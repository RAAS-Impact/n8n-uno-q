import { describe, expect, it } from 'vitest';
import { runGuard } from '../src/guard.js';

describe('runGuard', () => {
  it('allows when the body returns true', () => {
    expect(runGuard('return true;', {}).allowed).toBe(true);
  });

  it('allows when the body returns undefined (no explicit return)', () => {
    expect(runGuard('const x = 1;', {}).allowed).toBe(true);
  });

  it('allows when the body returns null', () => {
    expect(runGuard('return null;', {}).allowed).toBe(true);
  });

  it('rejects with a generic message when the body returns false', () => {
    const v = runGuard('return false;', {});
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.message).toBe('Guard rejected the call');
  });

  it('rejects with the returned string verbatim', () => {
    const v = runGuard('return "out of range";', {});
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.message).toBe('out of range');
  });

  it('exposes scope variables as named parameters', () => {
    const v = runGuard(
      'if (operation === "set" && value > 100) return "max 100"; return true;',
      { operation: 'set', value: 150 },
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.message).toBe('max 100');
  });

  it('propagates thrown errors', () => {
    expect(() => runGuard('throw new Error("boom");', {})).toThrow('boom');
  });

  it('rejects unexpected return types', () => {
    expect(() => runGuard('return { nope: 1 };', {})).toThrow(/unexpected value/);
  });
});
