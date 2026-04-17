/**
 * errors.ts — Typed error hierarchy for the Bridge.
 *
 * Each error class has a `code` string so consumers can distinguish error
 * types programmatically (e.g. in n8n nodes that need different error messages
 * for "socket not found" vs "call timed out" vs "method doesn't exist").
 */

/** Base error for all bridge-related failures. */
export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** A call() didn't receive a response within the timeout window. */
export class TimeoutError extends BridgeError {
  constructor(method: string, timeoutMs: number) {
    super(`Call to "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

/** The socket connection was lost or could not be established. */
export class ConnectionError extends BridgeError {
  constructor(message: string) {
    super(message, 'CONNECTION');
    this.name = 'ConnectionError';
  }
}

/** The router reported that nobody is registered to handle this method. */
export class MethodNotAvailableError extends BridgeError {
  constructor(method: string) {
    super(`Method "${method}" is not available`, 'METHOD_NOT_AVAILABLE');
    this.name = 'MethodNotAvailableError';
  }
}
