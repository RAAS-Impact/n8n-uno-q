/**
 * Tests for sshCertParser — the OpenSSH user-cert wire-format parser
 * and signature verifier that SshServer relies on (because ssh2
 * v1.17 doesn't parse user certs itself).
 *
 * Strategy: instead of hand-crafting wire bytes (brittle and unreadable),
 * we generate real ed25519 keypairs, sign real certs with ssh-keygen,
 * and feed the resulting blobs into the parser. This catches both
 * "parser doesn't understand OpenSSH output" and "OpenSSH output drifted
 * across versions" failure modes — same posture as the bridge integration
 * tests against arduino-router.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSshUserCert, verifySshUserCert } from '../src/sshCertParser.js';

interface Bundle {
  /** CA pubkey in OpenSSH file format (the contents of <ca>.pub). */
  caPubKey: string;
  /** Issued user-cert pubkey blob (length-prefixed wire format). */
  certBlob: Buffer;
  /** The cert text file path, kept for debugging on assertion failure. */
  certFile: string;
}

interface IssueOpts {
  principals: string;
  keyId: string;
  validityDays: number;
  /** Extensions to grant. The parser/server requires permit-port-forwarding. */
  extensions?: string[];
  /** Critical options to grant (e.g. force-command). Empty by default. */
  criticalOptions?: string[];
}

let WORKDIR: string;

beforeAll(() => {
  WORKDIR = mkdtempSync(path.join(tmpdir(), 'ssh-cert-parser-test-'));
});

afterAll(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});

/**
 * Generate a fresh keypair + sign it with the given CA. Returns enough
 * bits to drive parser + verifier. We slurp the cert pubkey blob from
 * the .pub file (line shape: `<algo> <base64-blob> <comment>`).
 */
function issueUserCertWith(caPath: string, opts: IssueOpts): Bundle {
  const id = `${opts.keyId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keyPath = path.join(WORKDIR, `${id}-key`);
  const certPath = `${keyPath}-cert.pub`;

  // 1) Fresh user keypair.
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test:${opts.keyId}`, '-f', keyPath]);

  // 2) Sign the .pub with the CA. -O clear strips defaults; -O on per
  //    extension/option grants exactly what the test needs.
  const args = [
    '-q',
    '-s',
    caPath,
    '-I',
    opts.keyId,
    '-n',
    opts.principals,
    '-V',
    `+${opts.validityDays}d`,
    '-O',
    'clear',
  ];
  for (const ext of opts.extensions ?? []) args.push('-O', ext);
  for (const co of opts.criticalOptions ?? []) args.push('-O', co);
  args.push(`${keyPath}.pub`);
  execFileSync('ssh-keygen', args);

  // 3) The cert .pub is `<cert-algo> <base64-blob> <comment>`. Decode the
  //    blob — that's exactly what ssh2 hands us as ctx.key.data at runtime.
  const certText = readFileSync(certPath, 'utf8').trim();
  const parts = certText.split(/\s+/);
  expect(parts.length).toBeGreaterThanOrEqual(2);
  const certBlob = Buffer.from(parts[1], 'base64');

  const caPubKey = readFileSync(`${caPath}.pub`, 'utf8');
  return { caPubKey, certBlob, certFile: certPath };
}

function makeCa(name: string): string {
  const caPath = path.join(WORKDIR, `${name}-ca`);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test:${name}`, '-f', caPath]);
  return caPath;
}

describe('parseSshUserCert', () => {
  it('extracts keyId, principals, and the permit-port-forwarding extension', () => {
    const ca = makeCa('parse-basic');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 90,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    expect(parsed.algo).toBe('ssh-ed25519-cert-v01@openssh.com');
    expect(parsed.type).toBe(1);
    expect(parsed.keyId).toBe('kitchen');
    expect(parsed.principals).toEqual(['tunnel']);
    expect(parsed.extensions).toHaveProperty('permit-port-forwarding');
    expect(parsed.criticalOptions).toEqual({});
    expect(parsed.pubkey.length).toBe(32);
  });

  it('parses multiple principals when present', () => {
    const ca = makeCa('parse-multi-principal');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel,admin,backup',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    expect(parsed.principals).toEqual(['tunnel', 'admin', 'backup']);
  });

  it('reports validAfter/validBefore that bracket "now"', () => {
    const ca = makeCa('parse-validity');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    expect(parsed.validAfter).toBeLessThanOrEqual(nowSec);
    expect(parsed.validBefore).toBeGreaterThan(nowSec);
  });

  it('rejects host certs (type=2) — only user certs allowed', () => {
    const ca = makeCa('parse-host');
    const keyPath = path.join(WORKDIR, 'host-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test:host', '-f', keyPath]);
    execFileSync('ssh-keygen', [
      '-q',
      '-s',
      ca,
      '-h',                                 // host cert
      '-I',
      'host-id',
      '-n',
      'example.com',
      '-V',
      '+30d',
      `${keyPath}.pub`,
    ]);
    const certText = readFileSync(`${keyPath}-cert.pub`, 'utf8').trim();
    const blob = Buffer.from(certText.split(/\s+/)[1], 'base64');
    expect(() => parseSshUserCert(blob)).toThrow(/expected user cert/);
  });

  it('throws on truncated buffer', () => {
    const ca = makeCa('parse-trunc');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const truncated = certBlob.subarray(0, 50);
    expect(() => parseSshUserCert(truncated)).toThrow(/unexpected end of cert blob/);
  });

  it('throws on wrong algorithm (rsa cert)', () => {
    // We can't easily issue an RSA cert here; instead, hand-craft a blob
    // that starts with a different algo string and verify the pre-check.
    const buf = Buffer.alloc(64);
    const algo = 'ssh-rsa-cert-v01@openssh.com';
    buf.writeUInt32BE(algo.length, 0);
    buf.write(algo, 4);
    expect(() => parseSshUserCert(buf)).toThrow(/unsupported cert algorithm/);
  });
});

describe('verifySshUserCert', () => {
  it('accepts a cert signed by the configured user CA', () => {
    const ca = makeCa('verify-ok');
    const { caPubKey, certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    const result = verifySshUserCert(parsed, caPubKey);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a cert signed by a different CA', () => {
    const ca1 = makeCa('verify-ca1');
    const ca2 = makeCa('verify-ca2');
    const { certBlob } = issueUserCertWith(ca1, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const ca2PubKey = readFileSync(`${ca2}.pub`, 'utf8');
    const parsed = parseSshUserCert(certBlob);
    const result = verifySshUserCert(parsed, ca2PubKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/doesn't match the configured user CA/);
    }
  });

  it('rejects a forged cert that copies the CA pubkey but has a fake signature', () => {
    // This is THE attack the mock script's "CA-pubkey-equality only"
    // shortcut would let through. Verify our crypto.verify path catches it.
    const ca = makeCa('verify-forge');
    const { caPubKey, certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    // Tamper: flip the last byte of the signature. signatureKey still
    // matches the CA, so the byte-equality pre-filter passes — but
    // crypto.verify must reject.
    const sig = parsed.signature;
    const tamperedSig = Buffer.from(sig);
    tamperedSig[tamperedSig.length - 1] ^= 0x01;
    const tampered = { ...parsed, signature: tamperedSig };
    const result = verifySshUserCert(tampered, caPubKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/signature does not verify/);
    }
  });

  it('rejects a CA pubkey that is not in OpenSSH ed25519 format', () => {
    const ca = makeCa('verify-bad-ca');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    // Garbage CA string — neither algo prefix nor base64.
    const result = verifySshUserCert(parsed, 'this-is-not-a-pubkey');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ed25519 CA algorithm', () => {
    const ca = makeCa('verify-rsa-ca');
    const { certBlob } = issueUserCertWith(ca, {
      principals: 'tunnel',
      keyId: 'kitchen',
      validityDays: 30,
      extensions: ['permit-port-forwarding'],
    });
    const parsed = parseSshUserCert(certBlob);
    const result = verifySshUserCert(parsed, 'ssh-rsa AAAAB3NzaC1yc2E= fake-rsa');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CA must be ssh-ed25519/);
    }
  });
});
