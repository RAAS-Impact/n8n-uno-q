/**
 * UnoQTool.execute() integration-ish tests.
 *
 * These exercise the real execute() method against a mocked IExecuteFunctions
 * and a mocked Bridge — so they cover the wiring the pure rateLimiter tests
 * can't: gate ordering, the shape of `budget` passed into the method guard,
 * when recordCall fires, rejection message format, and that the bridge sees
 * the correct (method, params, opts) tuple.
 *
 * They do NOT cover the UI field descriptor — that only n8n can validate
 * (field names exist, types render, displayOptions evaluate). Once these
 * pass, the remaining verification is a manual n8n round-trip.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UnoQTool } from '../src/nodes/UnoQTool/UnoQTool.node.js';
import { BridgeManager } from '../src/BridgeManager.js';
import { __resetRateLimiterForTests } from '../src/rateLimiter.js';

interface Params {
  method?: string;
  parametersMode?: 'none' | 'fields' | 'json';
  parameters?: { parameter?: Array<{ type: string; value: string }> };
  parametersJson?: string;
  options?: { timeout?: number; socketPath?: string };
  idempotent?: boolean;
  rateLimit?: { maxCalls?: number; window?: 'minute' | 'hour' | 'day' };
  methodGuard?: string;
}

const DEFAULTS: Required<Pick<Params, 'method' | 'parametersMode'>> = {
  method: 'set_led',
  parametersMode: 'none',
};

interface CredentialStub {
  id: string;
  // The data transport-resolver returns when getCredentials is called. Drives
  // the descriptor the rate limiter's key (and BridgeManager lookup) uses.
  data: { transport: 'unix'; socketPath: string } | { transport: 'tcp'; host: string; port: number };
}

function makeCtx(
  items: unknown[],
  params: Params,
  nodeId = 'node-test',
  credential?: CredentialStub,
): unknown {
  const full: Params = { ...DEFAULTS, ...params };
  return {
    getInputData: () => items.map((item) => ({ json: item ?? {} })),
    getNode: () => ({
      id: nodeId,
      name: 'UnoQTool',
      type: 'n8n-nodes-uno-q.unoQTool',
      typeVersion: 1,
      credentials: credential
        ? { unoQRouterApi: { id: credential.id, name: 'stub' } }
        : undefined,
    }),
    continueOnFail: () => false,
    getNodeParameter: (name: string, _i: number, dflt?: unknown) => {
      if (name in full) return (full as Record<string, unknown>)[name];
      if (dflt !== undefined) return dflt;
      throw new Error(`fake ctx: no param "${name}" configured and no default`);
    },
    getCredentials: async () => {
      if (!credential) {
        throw new Error('fake ctx: getCredentials called but no credential configured');
      }
      return credential.data;
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };
}

interface BridgeCall {
  method: string;
  params: unknown[];
  opts: { timeoutMs: number; idempotent: boolean };
}

const DEFAULT_DESCRIPTOR = { kind: 'unix', path: '/var/run/arduino-router.sock' } as const;

function descriptorKey(d: { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number }): string {
  return d.kind === 'unix' ? `unix:${d.path}` : `tcp:${d.host}:${d.port}`;
}

function installFakeBridge(
  result: unknown = 'ok',
  descriptor: { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number } = DEFAULT_DESCRIPTOR,
): BridgeCall[] {
  const calls: BridgeCall[] = [];
  const fakeBridge = {
    callWithOptions: async (
      method: string,
      params: unknown[],
      opts: { timeoutMs: number; idempotent: boolean },
    ) => {
      calls.push({ method, params, opts });
      return result;
    },
  };
  // BridgeManager is Map-keyed by descriptor. Seed the entry for the path
  // transport-resolver will pick (default unix, or the credential's tcp/unix).
  const mgr = BridgeManager.getInstance() as unknown as {
    entries: Map<string, unknown>;
  };
  mgr.entries.set(descriptorKey(descriptor), {
    bridge: fakeBridge,
    pendingClose: null,
    refCount: 0,
    methodRefs: new Map(),
    descriptor,
  });
  return calls;
}

function clearBridge(): void {
  const mgr = BridgeManager.getInstance() as unknown as {
    entries: Map<string, unknown>;
  };
  mgr.entries.clear();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(ctx: unknown): Promise<any[]> {
  const node = new UnoQTool();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (node.execute as any).call(ctx);
  return out[0];
}

describe('UnoQTool.execute', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    clearBridge();
  });

  describe('happy path', () => {
    it('calls bridge with method, params, and options, then surfaces the result', async () => {
      const calls = installFakeBridge('sent');
      const ctx = makeCtx([{}], {
        method: 'set_led',
        parametersMode: 'fields',
        parameters: {
          parameter: [
            { type: 'boolean', value: 'true' },
            { type: 'number', value: '42' },
          ],
        },
        options: { timeout: 3000 },
        idempotent: true,
      });

      const out = await run(ctx);
      expect(out).toHaveLength(1);
      expect(out[0].json).toEqual({ method: 'set_led', params: [true, 42], result: 'sent' });
      expect(calls).toEqual([
        { method: 'set_led', params: [true, 42], opts: { timeoutMs: 3000, idempotent: true } },
      ]);
    });
  });

  describe('Rate Limit enforcement', () => {
    it('rejects the (cap+1)th call within the window; bridge is called only `cap` times', async () => {
      const calls = installFakeBridge();
      const ctx = makeCtx([{}, {}, {}], {
        rateLimit: { maxCalls: 2, window: 'minute' },
      });

      const out = await run(ctx);
      expect(out).toHaveLength(3);
      expect(out[0].json.result).toBe('ok');
      expect(out[1].json.result).toBe('ok');
      expect(out[2].json.refused).toBe(true);
      expect(out[2].json.error).toMatch(
        /^Refused: rate limit of 2 per minute exceeded\. Retry in ~\d+s\.$/,
      );
      expect(calls).toHaveLength(2);
    });

    it('is inactive when no cap is configured', async () => {
      const calls = installFakeBridge();
      const ctx = makeCtx([{}, {}, {}, {}, {}], {});
      await run(ctx);
      expect(calls).toHaveLength(5);
    });

    it('keys the counter by credentialId so re-pointing a node starts fresh budget', async () => {
      // Same node.id and same method, two different credentials pointing at
      // two different Qs. §12.4: the counter must not carry the old Q's call
      // history into the new target. Saturate credential A's bucket, then
      // confirm credential B still has its full budget.
      const descriptorA = { kind: 'tcp' as const, host: 'kitchen', port: 5775 };
      const descriptorB = { kind: 'tcp' as const, host: 'garage', port: 5775 };
      const callsA = installFakeBridge('ok', descriptorA);
      const callsB = installFakeBridge('ok', descriptorB);

      const ctxA = makeCtx([{}, {}, {}], { rateLimit: { maxCalls: 2, window: 'minute' } }, 'node-x', {
        id: 'cred-kitchen',
        data: { transport: 'tcp', host: descriptorA.host, port: descriptorA.port },
      });
      const outA = await run(ctxA);
      expect(outA[0].json.result).toBe('ok');
      expect(outA[1].json.result).toBe('ok');
      expect(outA[2].json.refused).toBe(true);
      expect(callsA).toHaveLength(2);

      const ctxB = makeCtx([{}, {}], { rateLimit: { maxCalls: 2, window: 'minute' } }, 'node-x', {
        id: 'cred-garage',
        data: { transport: 'tcp', host: descriptorB.host, port: descriptorB.port },
      });
      const outB = await run(ctxB);
      expect(outB[0].json.result).toBe('ok');
      expect(outB[1].json.result).toBe('ok');
      expect(outB.every((r) => !r.json.refused)).toBe(true);
      expect(callsB).toHaveLength(2);
    });
  });

  describe('gate ordering', () => {
    it('rate-limit rejection short-circuits the guard (guard body never runs)', async () => {
      installFakeBridge();
      // Side-effect counter via a unique symbol on globalThis. If the guard
      // runs, it increments — we assert it does not for a rate-limit reject.
      const key = Symbol.for('test:guardRanCount:' + Math.random());
      (globalThis as Record<symbol, number>)[key] = 0;
      const counterExpr = `globalThis[Symbol.for('${key.description}')]++; return true;`;

      const ctx = makeCtx([{}, {}, {}], {
        rateLimit: { maxCalls: 2, window: 'minute' },
        methodGuard: counterExpr,
      });

      await run(ctx);
      // First two calls run the guard; third is rejected by rate limit before
      // the guard gets a chance.
      expect((globalThis as Record<symbol, number>)[key]).toBe(2);
    });

    it('guard rejection does NOT consume rate-limit budget', async () => {
      const calls = installFakeBridge();
      // Reject every 2nd call. 4 items → 2 allowed through, 2 rejected.
      // With cap=2, the rejected calls must not eat slots: the two *allowed*
      // ones should both succeed.
      const ctx = makeCtx([{}, {}, {}, {}], {
        rateLimit: { maxCalls: 2, window: 'minute' },
        methodGuard: `
          globalThis.__guardN = (globalThis.__guardN || 0) + 1;
          if (globalThis.__guardN % 2 === 0) return "Refused: even-numbered call";
          return true;
        `,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__guardN = 0;

      const out = await run(ctx);
      expect(out[0].json.result).toBe('ok');
      expect(out[1].json.refused).toBe(true);
      expect(out[1].json.error).toBe('Refused: even-numbered call');
      expect(out[2].json.result).toBe('ok');
      expect(out[3].json.refused).toBe(true);
      // Bridge only saw the two allowed calls.
      expect(calls).toHaveLength(2);
    });
  });

  describe('budget in guard scope', () => {
    it('budget.used reflects prior successful calls across items', async () => {
      installFakeBridge();
      const ctx = makeCtx([{}, {}, {}], {
        methodGuard: `return "seen=" + budget.used("minute");`,
      });
      const out = await run(ctx);
      // Guard always rejects (returns a string), so recordCall never fires;
      // every guard sees used=0.
      expect(out[0].json.error).toBe('seen=0');
      expect(out[1].json.error).toBe('seen=0');
      expect(out[2].json.error).toBe('seen=0');
    });

    it('budget.used increments on each successful call', async () => {
      installFakeBridge();
      // Guard returns a string only on first call, passes through after — so
      // we can observe how used() evolves.
      const ctx = makeCtx([{}, {}, {}], {
        methodGuard: `
          const n = budget.used("minute");
          globalThis.__seenUsed = globalThis.__seenUsed || [];
          globalThis.__seenUsed.push(n);
          return true;
        `,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__seenUsed = [];
      await run(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((globalThis as any).__seenUsed).toEqual([0, 1, 2]);
    });

    it('budget.remaining and budget.resetsInMs are null when no cap is configured', async () => {
      installFakeBridge();
      const ctx = makeCtx([{}], {
        methodGuard: `return JSON.stringify({ r: budget.remaining, t: budget.resetsInMs });`,
      });
      const out = await run(ctx);
      expect(JSON.parse(out[0].json.error)).toEqual({ r: null, t: null });
    });

    it('budget.remaining drops as calls land when a cap is configured', async () => {
      installFakeBridge();
      const ctx = makeCtx([{}, {}, {}], {
        rateLimit: { maxCalls: 5, window: 'minute' },
        methodGuard: `
          globalThis.__rems = globalThis.__rems || [];
          globalThis.__rems.push(budget.remaining);
          return true;
        `,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__rems = [];
      await run(ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((globalThis as any).__rems).toEqual([5, 4, 3]);
    });
  });
});
