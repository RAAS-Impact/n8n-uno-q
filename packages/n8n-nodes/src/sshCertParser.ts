/**
 * OpenSSH user-cert wire-format parser + signature verifier.
 *
 * `mscdex/ssh2` v1.17 does not parse OpenSSH user certificates in the
 * server auth callback (verified empirically — see master-plan §14.2
 * follow-up). It hands us the raw cert blob in `ctx.key.data` with
 * `ctx.key.algo === 'ssh-ed25519-cert-v01@openssh.com'`. This module
 * does the work ssh2 won't do.
 *
 * Reference: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.certkeys
 *
 * For ssh-ed25519-cert-v01@openssh.com the cert wire layout is:
 *   string algo                       ("ssh-ed25519-cert-v01@openssh.com")
 *   string nonce
 *   string pk                         (32-byte ed25519 pubkey)
 *   uint64 serial
 *   uint32 type                       (1=user, 2=host)
 *   string keyId
 *   string validPrincipals            (sub-buffer of length-prefixed strings)
 *   uint64 validAfter
 *   uint64 validBefore
 *   string criticalOptions            (sub-buffer of name/value pairs)
 *   string extensions                 (same shape)
 *   string reserved
 *   string signatureKey               (the CA pubkey, in SSH wire format)
 *   string signature                  (CA's signature over everything-before-this-field)
 *
 * The signature covers the bytes from offset 0 up to (but not including)
 * the `signature` field's length prefix. We parse the cert and capture
 * that "to-be-signed" byte range so the caller can verify it via
 * crypto.verify('ed25519', tbs, caPubKeyAsCryptoKey, sig).
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Result of `parseSshUserCert`. Raw bytes are stored as Buffers for performance. */
export interface ParsedSshUserCert {
  /** Algorithm string from the first cert field; we only support ed25519 here. */
  algo: string;
  nonce: Buffer;
  /** The user's bare ed25519 public key (32 bytes), embedded in the cert. */
  pubkey: Buffer;
  /** Cert serial number (uint64 as bigint — could exceed Number.MAX_SAFE_INTEGER). */
  serial: bigint;
  /** 1 = user cert, 2 = host cert. We accept only user certs. */
  type: number;
  /** The cert's KeyID — used as the routing key on the n8n side. */
  keyId: string;
  /** List of principals the cert is valid for. */
  principals: string[];
  /** Unix timestamp (seconds) — cert is invalid before this. 0 = always valid. */
  validAfter: bigint;
  /** Unix timestamp (seconds) — cert is invalid after this. UINT64_MAX = never expires. */
  validBefore: bigint;
  /** OpenSSH critical-options map. Reject cert if any unknown key is present (per spec). */
  criticalOptions: Record<string, string>;
  /** OpenSSH extensions map. Look here for `permit-port-forwarding`, etc. */
  extensions: Record<string, string>;
  /**
   * The CA's public key in OpenSSH SSH-wire format (length-prefixed algo +
   * length-prefixed key data). Compare against the user-CA pubkey loaded
   * from credential, but ONLY as a pre-filter — actual trust comes from
   * verifying the signature.
   */
  signatureKey: Buffer;
  /**
   * The bytes the CA signed over (everything in the cert blob up to but
   * not including the signature field). Pass to `verifySshUserCert`.
   */
  tbs: Buffer;
  /**
   * The CA's signature in SSH wire format: length-prefixed algo +
   * length-prefixed raw signature. Length-stripped raw signature bytes
   * are extracted by `verifySshUserCert` for `crypto.verify`.
   */
  signature: Buffer;
}

const ED25519_CERT_ALGO = 'ssh-ed25519-cert-v01@openssh.com';
const ED25519_KEY_ALGO = 'ssh-ed25519';
const CERT_TYPE_USER = 1;

/**
 * Parse a wire-format ed25519 user-cert blob, as delivered by ssh2 in
 * `ctx.key.data` when the OpenSSH client offers a CertificateFile.
 *
 * Throws on:
 *   - non-ed25519-cert algorithm (other cert algorithms are not supported in v1)
 *   - non-user-cert type
 *   - malformed buffer (truncated fields, length overflows)
 *
 * Validity-window, principals, extensions, and signature checks are
 * caller responsibilities — see `verifySshUserCert`.
 */
export function parseSshUserCert(blob: Buffer): ParsedSshUserCert {
  const r = new Reader(blob);
  const algo = r.readString().toString('utf8');
  if (algo !== ED25519_CERT_ALGO) {
    throw new Error(`unsupported cert algorithm: ${algo}`);
  }
  const nonce = r.readString();
  const pubkey = r.readString();
  if (pubkey.length !== 32) {
    throw new Error(`ed25519 cert pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const serial = r.readUint64();
  const type = r.readUint32();
  if (type !== CERT_TYPE_USER) {
    throw new Error(`expected user cert (type=1), got type=${type}`);
  }
  const keyId = r.readString().toString('utf8');
  const principals = parseStringList(r.readString());
  const validAfter = r.readUint64();
  const validBefore = r.readUint64();
  const criticalOptions = parseOptions(r.readString());
  const extensions = parseOptions(r.readString());
  // _reserved must be empty per spec, but we don't enforce — some OpenSSH
  // versions emit empty here, never anything else.
  r.readString();
  // tbs ends here — everything after is the signatureKey field followed
  // by the signature. The signature covers EVERYTHING up to (but not
  // including) its own length prefix.
  const signatureKey = r.readString();
  const tbsEnd = r.offset();
  const signature = r.readString();

  const tbs = blob.subarray(0, tbsEnd);

  return {
    algo,
    nonce,
    pubkey,
    serial,
    type,
    keyId,
    principals,
    validAfter,
    validBefore,
    criticalOptions,
    extensions,
    signatureKey,
    tbs,
    signature,
  };
}

/**
 * Verify a parsed user cert was signed by the given CA.
 *
 * Two checks, in order:
 *   1. The cert's `signatureKey` field must equal the CA's wire-format
 *      pubkey. This is a content-equality pre-filter — fast and catches
 *      "signed by a different CA" without invoking crypto.verify.
 *   2. The cert's signature is cryptographically valid for the TBS bytes
 *      under the CA's public key (via `crypto.verify('ed25519', ...)`).
 *      THIS is the load-bearing check: without it, an attacker could
 *      trivially forge a cert that claims our CA's signatureKey. The
 *      mock harness at experiments/mock-ssh-relay.mjs deliberately
 *      skipped this — production code must not.
 *
 * `caPublicKeyOpenSsh` is the CA's pubkey in OpenSSH file format
 * (e.g. `ssh-ed25519 AAAAC3Nz... uno-q-relay-ssh user CA\n`).
 */
export function verifySshUserCert(
  cert: ParsedSshUserCert,
  caPublicKeyOpenSsh: string,
): { ok: true } | { ok: false; reason: string } {
  // OpenSSH file format: <algo> <base64-body> [comment]. Extract base64 body.
  const parts = caPublicKeyOpenSsh.trim().split(/\s+/);
  if (parts.length < 2) {
    return { ok: false, reason: 'CA pubkey is not in OpenSSH format (algo + base64)' };
  }
  if (parts[0] !== ED25519_KEY_ALGO) {
    return { ok: false, reason: `CA must be ${ED25519_KEY_ALGO}, got ${parts[0]}` };
  }
  let caWire: Buffer;
  try {
    caWire = Buffer.from(parts[1], 'base64');
  } catch {
    return { ok: false, reason: 'CA pubkey base64 decode failed' };
  }
  // Cert's signatureKey field IS the same wire format (length-prefixed algo +
  // length-prefixed raw key). Direct equality check.
  if (!cert.signatureKey.equals(caWire)) {
    return { ok: false, reason: "cert signatureKey doesn't match the configured user CA" };
  }

  // Now do the actual signature verification.
  const sigInner = decodeSshSignature(cert.signature);
  if (!sigInner) {
    return { ok: false, reason: 'cert signature blob is malformed' };
  }

  // Build a Node KeyObject from the CA's wire-format pubkey. The path is:
  //   wire format → SubjectPublicKeyInfo (SPKI) → KeyObject.
  // For ed25519 we can use crypto.createPublicKey with a JWK or build the SPKI
  // by hand. The cleanest stdlib path is JWK because Node accepts it directly.
  const caRaw = parseSshEd25519PubKey(caWire);
  if (!caRaw) {
    return { ok: false, reason: 'CA pubkey wire format decode failed' };
  }
  const caKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: caRaw.toString('base64url') },
    format: 'jwk',
  });

  const valid = cryptoVerify(null, cert.tbs, caKey, sigInner);
  if (!valid) {
    return { ok: false, reason: 'cert signature does not verify under the configured user CA' };
  }
  return { ok: true };
}

// --- Internal: parse helpers --------------------------------------------

function parseStringList(buf: Buffer): string[] {
  const r = new Reader(buf);
  const out: string[] = [];
  while (!r.done()) out.push(r.readString().toString('utf8'));
  return out;
}

// OpenSSH critical-options/extensions are a map. Each entry is:
//   string name
//   string value      (often empty for boolean-like extensions)
function parseOptions(buf: Buffer): Record<string, string> {
  const r = new Reader(buf);
  const out: Record<string, string> = {};
  while (!r.done()) {
    const name = r.readString().toString('utf8');
    const value = r.readString();
    out[name] = value.length === 0 ? '' : value.toString('utf8');
  }
  return out;
}

/**
 * SSH wire signature format:
 *   string algo (e.g. "ssh-ed25519")
 *   string raw signature bytes (64 bytes for ed25519)
 *
 * Returns the inner 64-byte ed25519 signature, or null if the blob is
 * malformed or for the wrong algo.
 */
function decodeSshSignature(sigBlob: Buffer): Buffer | null {
  try {
    const r = new Reader(sigBlob);
    const algo = r.readString().toString('utf8');
    if (algo !== ED25519_KEY_ALGO) return null;
    const sig = r.readString();
    if (sig.length !== 64) return null;
    return sig;
  } catch {
    return null;
  }
}

/**
 * SSH wire ed25519 pubkey:
 *   string "ssh-ed25519"
 *   string raw 32-byte pubkey
 *
 * Returns the inner 32-byte raw pubkey, or null if malformed.
 */
function parseSshEd25519PubKey(wire: Buffer): Buffer | null {
  try {
    const r = new Reader(wire);
    const algo = r.readString().toString('utf8');
    if (algo !== ED25519_KEY_ALGO) return null;
    const raw = r.readString();
    if (raw.length !== 32) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Length-prefixed buffer reader for SSH wire format. */
class Reader {
  private off = 0;
  constructor(private buf: Buffer) {}
  done(): boolean {
    return this.off >= this.buf.length;
  }
  offset(): number {
    return this.off;
  }
  readUint32(): number {
    this.requireRange(4);
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  readUint64(): bigint {
    this.requireRange(8);
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  readString(): Buffer {
    const len = this.readUint32();
    this.requireRange(len);
    const s = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return s;
  }
  private requireRange(n: number) {
    if (this.off + n > this.buf.length) {
      throw new Error(
        `unexpected end of cert blob: need ${n} bytes at offset ${this.off} but only ${
          this.buf.length - this.off
        } remain`,
      );
    }
  }
}
