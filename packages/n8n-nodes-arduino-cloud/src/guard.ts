/**
 * Property Guard — runs a user-supplied JavaScript body at invocation time
 * with a scope object the user can read from.
 *
 * Mirrors the Method Guard in n8n-nodes-uno-q (see UnoQTool.node.ts): the
 * guard returns `true` / `undefined` / `null` to allow, a string to reject
 * with that exact message (fed back to the LLM as tool output for self-
 * correction), `false` for a generic rejection, or throws for a hard error.
 *
 * Runs without a sandbox — same trust model as the n8n Code node.
 */

export type GuardVerdict = { allowed: true } | { allowed: false; message: string };

/**
 * Execute the guard body against the given scope. The scope object's keys
 * become named parameters of the synthesised function.
 */
export function runGuard(body: string, scope: Record<string, unknown>): GuardVerdict {
  const names = Object.keys(scope);
  const values = names.map((n) => scope[n]);
  const verdict = new Function(...names, body)(...values);

  if (verdict === true || verdict === undefined || verdict === null) {
    return { allowed: true };
  }
  if (verdict === false) {
    return { allowed: false, message: 'Guard rejected the call' };
  }
  if (typeof verdict === 'string') {
    return { allowed: false, message: verdict };
  }
  throw new Error(
    `Guard returned an unexpected value (${typeof verdict}); expected true/undefined, false, or a string`,
  );
}
