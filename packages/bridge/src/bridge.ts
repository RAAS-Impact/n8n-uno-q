/**
 * bridge.ts — The main Bridge client class.
 *
 * This is the core of the package: a persistent, bidirectional MessagePack-RPC
 * client that talks to the arduino-router. The network is pluggable via the
 * Transport interface (unix socket, TCP, mock); the RPC state machine is
 * independent of which one is in use.
 *
 * What it does that a simple one-shot script can't:
 *
 * - **Concurrent calls**: multiple call() promises in flight at once, each
 *   tracked by a unique msgid so responses can be matched even if they arrive
 *   out of order.
 *
 * - **Bidirectional**: not just outbound calls — the Bridge can also receive
 *   inbound calls (provide()) and notifications (onNotify()) from the MCU,
 *   all multiplexed on the same socket.
 *
 * - **Resilient**: automatic reconnection with exponential backoff. On
 *   reconnect, re-registers all provided methods so the router knows we're
 *   still handling them. The backoff + replay loop lives here, not in the
 *   Transport, so a single implementation covers every transport flavour.
 *
 * - **Lifecycle management**: timeouts on pending calls, graceful close,
 *   rejection of all in-flight promises on socket drop.
 */
import { EventEmitter } from 'node:events';
import { createTransport, describeTransport } from './transport/index.js';
import type { Transport, TransportDescriptor } from './transport/index.js';
import { StreamDecoder, encodeRequest, encodeResponse, encodeNotify, MSG_REQUEST, MSG_RESPONSE, MSG_NOTIFY } from './codec.js';
import type { RpcMessage } from './codec.js';
import { TimeoutError, ConnectionError, BridgeError } from './errors.js';

// Lightweight debug logging — activate with DEBUG=bridge (or any string containing "bridge")
const DEBUG = process.env.DEBUG?.includes('bridge') ?? false;
function debug(category: string, ...args: unknown[]) {
  if (DEBUG) console.debug(`[bridge:${category}]`, ...args);
}

export interface ReconnectOptions {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ConnectOptions {
  /**
   * Legacy shortcut for `transport: { kind: 'unix', path: ... }`. Preserved for
   * backwards compatibility; prefer `transport` for new code.
   * @deprecated Use `transport` instead.
   */
  socket?: string;
  /** Where this Bridge should connect. Defaults to the legacy unix socket path. */
  transport?: TransportDescriptor;
  /** Reconnection behaviour. Enabled by default. */
  reconnect?: Partial<ReconnectOptions>;
  /**
   * Inject a pre-built Transport instance — used by tests (MockTransport) and
   * by advanced callers who need a custom wire implementation. When supplied,
   * `transport` and `socket` are ignored.
   */
  transportInstance?: Transport;
}

export interface BridgeOptions {
  transport: TransportDescriptor;
  reconnect: ReconnectOptions;
}

/**
 * Per-call options for `callWithOptions`. See docs/master-plan/06-package-n8n-nodes.md §6.4 for the full
 * retry contract; the short version lives next to callWithOptions below.
 */
export interface CallOptions {
  /** Overall budget for the call, including any retry. Default: 5000ms. */
  timeoutMs?: number;
  /**
   * May this call be safely retried when the socket drops mid-call? Governs
   * auto-retry on `ConnectionError`. Default: false (fail-closed). Never
   * retried on `TimeoutError` regardless — the MCU may still be executing.
   */
  idempotent?: boolean;
}

/** An in-flight outbound call waiting for its response. */
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Handler for methods registered via bridge.provide().
 * Receives the full params array and the router-assigned msgid.
 * Return value is sent as the RPC response; throwing sends an error response.
 */
export type ProvideHandler = (params: unknown[], msgid: number) => Promise<unknown> | unknown;

/** Handler for notifications registered via bridge.onNotify(). Fire-and-forget — no return value. */
export type NotifyHandler = (params: unknown[]) => void;

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_TIMEOUT_MS = 5000;

export class Bridge extends EventEmitter {
  private transport: Transport;
  private decoder = new StreamDecoder();

  /**
   * Monotonically increasing message ID. Each outbound call gets a unique ID
   * so we can match the response to the right Promise. Wraps at 2^31 to stay
   * within signed 32-bit range (some msgpack implementations treat higher values
   * as negative).
   */
  private msgid = 0;

  /** Map of msgid → pending Promise for outbound calls awaiting a response. */
  private pending = new Map<number, PendingRequest>();

  /** Methods we've registered on the router via $/register, with their handlers. */
  private providers = new Map<string, ProvideHandler>();

  /** Notification listeners, keyed by method name. Multiple handlers per method allowed. */
  private notifyHandlers = new Map<string, Set<NotifyHandler>>();

  /**
   * In-flight provide handler invocations. Each entry is the async IIFE that
   * awaits the handler and writes the RESPONSE. Used by waitForActiveHandlers()
   * so callers can drain pending work before closing the socket.
   */
  private activeHandlers = new Set<Promise<void>>();

  /**
   * In-flight router-forwarded requests, keyed by msgid → method name. Lets
   * close() write an explicit error response for any request whose handler
   * has not yet finished — without this drain, the response write races with
   * transport teardown and the upstream caller (often an MCU blocked on
   * Bridge.call) hangs forever waiting for a reply that will never arrive.
   * Entries are removed when the handler writes its own response, so close()
   * only sends errors for requests still genuinely in flight.
   */
  private inFlightRequests = new Map<number, string>();

  private connected = false;
  private closedByUs = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly options: BridgeOptions,
    transport: Transport,
  ) {
    super();
    this.transport = transport;
    this.wireTransportEvents();
  }

  /** Connect to the router and return a ready-to-use Bridge instance. */
  static async connect(opts: ConnectOptions = {}): Promise<Bridge> {
    // Resolve the transport descriptor: explicit `transport` wins, otherwise
    // fall back to the legacy `socket` shortcut, otherwise default unix path.
    const descriptor: TransportDescriptor =
      opts.transport ?? { kind: 'unix', path: opts.socket ?? DEFAULT_SOCKET };

    const options: BridgeOptions = {
      transport: descriptor,
      reconnect: {
        enabled: opts.reconnect?.enabled ?? true,
        baseDelayMs: opts.reconnect?.baseDelayMs ?? 200,
        maxDelayMs: opts.reconnect?.maxDelayMs ?? 5000,
      },
    };

    const transport = opts.transportInstance ?? createTransport(descriptor);
    const bridge = new Bridge(options, transport);
    await bridge.initialConnect();
    return bridge;
  }

  /**
   * Register the long-lived Transport listeners that persist across
   * reconnection attempts. Bridge re-uses the same Transport instance for
   * every (re)connect, so these listeners only need to be attached once.
   */
  private wireTransportEvents(): void {
    this.transport.on('data', (chunk: Uint8Array) => this.onData(chunk));
    this.transport.on('error', (err: Error) => this.emit('error', err));
    this.transport.on('close', () => this.onTransportClose());
  }

  /** Perform the first connection attempt — failure rejects the connect() Promise. */
  private async initialConnect(): Promise<void> {
    await this.transport.connect();
    this.connected = true;
    debug('connect', 'connected to', describeTransport(this.options.transport));
  }

  /**
   * Fired each time the underlying socket closes. Cleans up per-connection
   * state and — unless the user called close() — schedules a reconnect with
   * exponential backoff. The subsequent reconnect attempt replays $/register
   * for every provide()d method and onNotify()d subscription.
   */
  private onTransportClose(): void {
    this.connected = false;
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new ConnectionError('Socket closed'));
      this.pending.delete(id);
    }
    this.activeHandlers.clear();
    // Drop in-flight request tracking — the socket is gone, no error
    // response can be sent. close() handles the graceful path; this branch
    // covers transport drops where there's no recovery.
    this.inFlightRequests.clear();
    this.emit('disconnect');

    if (this.options.reconnect.enabled && !this.closedByUs) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    const delay = Math.min(
      this.options.reconnect.baseDelayMs * 2 ** this.reconnectAttempt,
      this.options.reconnect.maxDelayMs,
    );
    this.reconnectAttempt++;
    debug('reconnect', `scheduled in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doReconnect();
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.closedByUs) return;
    try {
      await this.transport.connect();
      this.connected = true;
      this.reconnectAttempt = 0;
      debug('reconnect', 're-registering providers');
      await this.reRegister();
      this.emit('reconnect');
    } catch (err) {
      // Reconnect attempt failed (e.g. ECONNREFUSED). Surface via 'error'
      // and schedule the next attempt — the backoff doubles until the cap.
      this.emit('error', err as Error);
      if (!this.closedByUs) this.scheduleReconnect();
    }
  }

  /** Decode incoming bytes into RPC messages and dispatch each one. */
  private onData(chunk: Uint8Array): void {
    const messages = this.decoder.feed(chunk);
    for (const msg of messages) {
      // Guard against null or non-array values in the stream
      if (!Array.isArray(msg)) {
        debug('recv', 'ignoring non-array message:', msg);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  /**
   * Route an incoming message based on its type:
   * - RESPONSE → resolve/reject the matching pending call
   * - REQUEST  → invoke the provider handler and send back a response
   * - NOTIFY   → invoke all registered notification handlers
   */
  private handleMessage(msg: RpcMessage): void {
    const type = msg[0];

    if (type === MSG_RESPONSE) {
      // This is the answer to one of our outbound call() invocations.
      // Match it by msgid and settle the corresponding Promise.
      const [, msgid, error, result] = msg;
      debug('recv', 'response', msgid, error ? `err=${error}` : 'ok');
      const pending = this.pending.get(msgid);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msgid);
      if (error != null) {
        // arduino-router / Arduino RouterBridge dialect: error is a 2-tuple
        // [code: int, message: string]. Older/foreign peers may send a bare
        // string or a single value — fall back to String(error) in that case
        // so we still surface something readable instead of "[object]".
        let message: string;
        if (
          Array.isArray(error) &&
          error.length >= 2 &&
          typeof error[1] === 'string'
        ) {
          message = error[1];
        } else {
          message = String(error);
        }
        pending.reject(new BridgeError(message));
      } else {
        pending.resolve(result);
      }
    } else if (type === MSG_REQUEST) {
      // The router is forwarding a call to a method we registered via provide().
      // Run our handler and send the result (or error) back as a RESPONSE.
      const [, msgid, method, params] = msg;
      debug('recv', 'request', msgid, method);
      const handler = this.providers.get(method as string);
      if (handler) {
        // Track the request so close() can drain it with an explicit error
        // response if the handler hasn't finished by then. The handler's
        // own response writes below skip themselves when delete() returns
        // false, which means close() already responded on this msgid's
        // behalf and trying again would double-send.
        this.inFlightRequests.set(msgid as number, method as string);
        const task = (async () => {
          try {
            const result = await handler(params as unknown[], msgid as number);
            if (this.inFlightRequests.delete(msgid as number)) {
              const ok = this.transport.write(encodeResponse(msgid as number, null, result));
              if (!ok) debug('send', 'response dropped (socket closed)', msgid, method);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            // arduino-router / RouterBridge dialect expects [code, message].
            // A bare string trips the MCU's decoder with "RPC Error not
            // parsable (check type)" (err 252). Code 1 = generic application
            // error; code 2 is the router's own "method not available" and
            // we deliberately avoid colliding with it.
            if (this.inFlightRequests.delete(msgid as number)) {
              this.transport.write(
                encodeResponse(msgid as number, [1, message], null),
              );
            }
          }
        })();
        this.activeHandlers.add(task);
        task.finally(() => this.activeHandlers.delete(task));
      } else {
        // No local handler for a method the router is forwarding to us. This
        // means our providers map has drifted out of sync with the router's
        // routing table — possible causes include idempotent provide() trusting
        // a stale cache, a reconnect race, or a test-listen teardown that
        // cleared the handler without unregistering on the router. Regardless
        // of root cause, we must not silently drop the request: the caller
        // (typically an MCU blocked on Bridge.call) would hang indefinitely.
        // Reply with an explicit error so it unblocks and surfaces the
        // mismatch in logs.
        debug('recv', 'request for unregistered method', msgid, method);
        // Error shape MUST be [code: int, message: string] to be parseable
        // by the Arduino RouterBridge library on the MCU side — a bare
        // string surfaces as "err 252: RPC Error not parsable (check type)"
        // and defeats the whole point of this branch (readable diagnostics
        // for the caller). Code 1 = generic application error; code 2 is
        // reserved for the router's "method not available".
        this.transport.write(
          encodeResponse(
            msgid as number,
            [1, `no handler registered for method: ${method}`],
            null,
          ),
        );
      }
    } else if (type === MSG_NOTIFY) {
      // Fire-and-forget from the MCU (e.g. button_pressed, sensor_threshold).
      // No response expected — just invoke all subscribed handlers.
      const [, method, params] = msg;
      debug('recv', 'notify', method);
      const handlers = this.notifyHandlers.get(method as string);
      if (handlers) {
        for (const handler of handlers) {
          handler(params as unknown[]);
        }
      }
    }
  }

  /** Allocate the next message ID. Wraps at 2^31 to stay in safe integer range. */
  private nextMsgId(): number {
    this.msgid = (this.msgid + 1) & 0x7fffffff;
    return this.msgid;
  }

  /**
   * Call a remote method and wait for its response.
   * Uses the default 5s timeout — use callWithTimeout() if you need a different
   * one, or callWithOptions() for per-call retry behaviour.
   *
   * Example: `await bridge.call('set_led_state', true)`
   */
  async call(method: string, ...params: unknown[]): Promise<unknown> {
    return this.callWithOptions(method, params, {});
  }

  /**
   * Like call() but with a custom timeout in milliseconds.
   *
   * Example: `await bridge.callWithTimeout('slow_sensor_read', 10000)`
   */
  async callWithTimeout(method: string, timeout: number, ...params: unknown[]): Promise<unknown> {
    return this.callWithOptions(method, params, { timeoutMs: timeout });
  }

  /**
   * Call a remote method with explicit per-call options.
   *
   * Retry contract (docs/master-plan/06-package-n8n-nodes.md §6.4):
   * - On `ConnectionError` (mid-call OR at call start, when the bridge is in
   *   a known-disconnected state) AND only if `idempotent: true`: race the
   *   bridge's 'reconnect' event against the remaining `timeoutMs` budget.
   *   If reconnect wins, retry — and keep retrying through subsequent
   *   ConnectionErrors until the call resolves OR the budget runs out.
   *   A single arduino-router restart causes multiple disconnect/reconnect
   *   cycles in practice, so a single retry isn't enough.
   * - Never retry on `TimeoutError` — the MCU may still be executing, and
   *   a successful execution is indistinguishable from a hang at this layer.
   * - Never retry non-idempotent calls regardless of error type.
   * - All retries share the original `timeoutMs` budget; the budget is the
   *   hard cap on total wall time spent in callWithOptions.
   */
  async callWithOptions(
    method: string,
    params: unknown[] = [],
    opts: CallOptions = {},
  ): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const idempotent = opts.idempotent ?? false;
    const deadline = Date.now() + timeoutMs;

    const attempt = (): Promise<unknown> => {
      // Fail fast if the bridge is in a known-disconnected state. Otherwise
      // we'd write to a destroyed socket (silently dropping the request) and
      // wait for the timer to fire — denying the retry path a ConnectionError
      // to react to.
      if (!this.connected) {
        return Promise.reject(new ConnectionError('Not connected'));
      }
      const remaining = Math.max(0, deadline - Date.now());
      const id = this.nextMsgId();
      debug('send', 'request', id, method, `budget=${remaining}`);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new TimeoutError(method, timeoutMs));
        }, remaining);
        this.pending.set(id, { resolve, reject, timer });
        this.transport.write(encodeRequest(id, method, params));
      });
    };

    const waitForReconnect = (remaining: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const onReconnect = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          this.off('reconnect', onReconnect);
          resolve(false);
        }, remaining);
        this.once('reconnect', onReconnect);
      });

    // Loop until the call resolves, the budget runs out, or a non-retryable
    // error surfaces. Each iteration either returns the response or waits for
    // the next 'reconnect' event before trying again.
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof ConnectionError) || !idempotent) throw err;

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TimeoutError(method, timeoutMs);

        const reconnected = await waitForReconnect(remaining);
        if (!reconnected) throw new TimeoutError(method, timeoutMs);
        debug('send', 'retrying', method, 'after reconnect');
        // Loop and try again. We do NOT cap retry count — the budget is the
        // cap, and each iteration awaits an actual reconnect event (no spin).
      }
    }
  }

  /**
   * Send a fire-and-forget notification. No response expected.
   *
   * Example: `bridge.notify('log_event', 'sensor_read', 42)`
   */
  notify(method: string, ...params: unknown[]): void {
    debug('send', 'notify', method);
    this.transport.write(encodeNotify(method, params));
  }

  /**
   * Register as the handler for a method name on the router.
   * Calls $/register on the router, then stores the handler locally.
   * The handler receives (params, msgid) and should return the result
   * (or throw to send an error response back to the caller).
   *
   * Idempotent on the same Bridge instance: if the method is already
   * registered on this socket (e.g. a prior n8n trigger closeFunction cleared
   * its local refcount but the Bridge was kept alive by other subscribers, so
   * the router-side $/register is still live), we swap the handler locally
   * and skip the round-trip. Without this, the router rejects the second
   * $/register with "route already exists" and the trigger fails to re-arm.
   *
   * Example:
   * ```ts
   * await bridge.provide('echo', (params) => ({ echo: params }));
   * ```
   */
  async provide(method: string, handler: ProvideHandler): Promise<void> {
    if (this.providers.has(method)) {
      debug('provide', 'reusing router registration for', method);
      this.providers.set(method, handler);
      return;
    }
    await this.call('$/register', method);
    this.providers.set(method, handler);
  }

  /**
   * Subscribe to inbound notifications for a method name.
   * Registers the method on the router (via $/register) so the router
   * knows to forward NOTIFYs for this name to us.
   * Returns an unsubscribe function. Multiple handlers per method are allowed.
   *
   * Example:
   * ```ts
   * const unsub = await bridge.onNotify('button_pressed', (params) => {
   *   console.log('Button', params[0], params[1]);
   * });
   * // Later: unsub() to stop listening
   * ```
   */
  async onNotify(method: string, handler: NotifyHandler): Promise<() => void> {
    let set = this.notifyHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notifyHandlers.set(method, set);
      // First subscriber for this method — register on the router so it
      // forwards NOTIFYs to us. Skip if already registered via provide().
      if (!this.providers.has(method)) {
        await this.call('$/register', method);
      }
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * After a reconnection, re-register all methods (providers + notify
   * subscriptions). The router drops registrations when a client
   * disconnects, so we must tell it again what we're interested in.
   */
  private async reRegister(): Promise<void> {
    // Collect all method names that need registration (avoid duplicates)
    const methods = new Set([
      ...this.providers.keys(),
      ...this.notifyHandlers.keys(),
    ]);
    for (const method of methods) {
      try {
        debug('reconnect', 're-registering', method);
        await this.call('$/register', method);
      } catch {
        this.emit('error', new BridgeError(`Failed to re-register "${method}" after reconnect`));
      }
    }
  }

  /** Number of provide handler invocations that have not yet written their response. */
  get activeHandlerCount(): number {
    return this.activeHandlers.size;
  }

  /**
   * Wait for all in-flight provide handlers to settle (send their RESPONSE),
   * or until `timeoutMs` elapses — whichever comes first.
   *
   * Call this before close() when a handler may resolve asynchronously (e.g. a
   * deferred n8n Respond flow). Without draining, close() tears down the socket
   * while the handler is still awaiting — the subsequent transport.write silently
   * fails and the caller never gets its RPC response.
   */
  async waitForActiveHandlers(timeoutMs: number): Promise<void> {
    if (this.activeHandlers.size === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (this.activeHandlers.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const timer = new Promise<void>((r) => setTimeout(r, remaining));
      await Promise.race([
        Promise.allSettled(Array.from(this.activeHandlers)),
        timer,
      ]);
    }
  }

  /**
   * Gracefully close the socket and clean up all listeners.
   *
   * Two layers of cleanup happen here that downstream consumers (notably
   * any MCU blocked on a synchronous Bridge.call) depend on:
   *
   *   1. Drain in-flight router-forwarded requests by writing an explicit
   *      `[1, "bridge closing while handling <method>"]` error response
   *      for each. Without this, a handler that's still mid-execution
   *      would race with transport teardown and the upstream caller would
   *      hang forever.
   *
   *   2. Send `$/reset` to drop every method this connection registered on
   *      the router. Without this, the router keeps routing to a dead
   *      socket; the next caller for one of our methods either hangs (no
   *      EPIPE-aware fallback) or sees a transport-level error rather than
   *      a clean "method not available". A bounded timeout means a slow
   *      router doesn't block close().
   */
  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connected) {
      // Step 1 — drain in-flight handlers with explicit error responses.
      // Iterate a snapshot so handlers completing concurrently can't mutate
      // the map mid-loop. Each delete() acts as a CAS: if the handler
      // already removed its own entry and wrote a response, the snapshot
      // entry is a no-op here.
      const inFlight = Array.from(this.inFlightRequests);
      this.inFlightRequests.clear();
      for (const [msgid, method] of inFlight) {
        try {
          this.transport.write(
            encodeResponse(msgid, [1, `bridge closing while handling ${method}`], null),
          );
        } catch {
          /* socket already gone — best effort */
        }
      }

      // Step 2 — tell the router to forget our registrations. Sent
      // unconditionally rather than gated on providers.size: callers can
      // mutate that map directly (tests do, and production drift paths
      // exist too — see the "no handler registered" branch in
      // handleMessage), in which case our local view is stale but the
      // router's routing table is not. $/reset is idempotent, so an
      // unnecessary call is harmless. Bounded so an unresponsive router
      // doesn't make close() hang; failures (timeout, network drop) are
      // non-fatal — the transport.close() below still happens, and the
      // router's EPIPE detection is the fallback.
      try {
        await this.callWithTimeout('$/reset', 500);
      } catch (err) {
        debug('close', '$/reset failed (non-fatal):', (err as Error).message);
      }
    }

    await this.transport.close();
    this.removeAllListeners();
  }
}
