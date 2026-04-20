/**
 * bridge.ts — The main Bridge client class.
 *
 * This is the core of the package: a persistent, bidirectional MessagePack-RPC
 * client that talks to the arduino-router over a Unix socket.
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
 *   still handling them.
 *
 * - **Lifecycle management**: timeouts on pending calls, graceful close,
 *   rejection of all in-flight promises on socket drop.
 */
import { EventEmitter } from 'node:events';
import { Transport } from './transport.js';
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
  /** Path to the arduino-router Unix socket. Default: /var/run/arduino-router.sock */
  socket?: string;
  /** Reconnection behaviour. Enabled by default. */
  reconnect?: Partial<ReconnectOptions>;
}

export type BridgeOptions = Required<ConnectOptions>;

/**
 * Per-call options for `callWithOptions`. See CONTEXT.md §6.4 for the full
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

  private connected = false;

  /**
   * True once the first connect has completed. The transport.on('connect')
   * handler uses this to distinguish the initial connect (no re-registration,
   * no 'reconnect' event) from subsequent reconnects. Tracking this
   * explicitly is more robust than peeking at msgid — a fail-fast attempt
   * may not bump msgid, leaving a stale "this is the first connect" reading.
   */
  private hasConnectedOnce = false;

  private constructor(private readonly options: BridgeOptions) {
    super();
    this.transport = new Transport(options.socket, options.reconnect as ReconnectOptions);
  }

  /** Connect to the router and return a ready-to-use Bridge instance. */
  static async connect(opts: ConnectOptions = {}): Promise<Bridge> {
    const options: BridgeOptions = {
      socket: opts.socket ?? DEFAULT_SOCKET,
      reconnect: {
        enabled: opts.reconnect?.enabled ?? true,
        baseDelayMs: opts.reconnect?.baseDelayMs ?? 200,
        maxDelayMs: opts.reconnect?.maxDelayMs ?? 5000,
      },
    };

    const bridge = new Bridge(options);
    await bridge.init();
    return bridge;
  }

  /**
   * Wire up transport events and establish the first connection.
   * The returned promise resolves once the socket is connected.
   */
  private async init(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Feed every socket chunk through the streaming decoder
      this.transport.on('data', (chunk: Uint8Array) => this.onData(chunk));

      this.transport.on('connect', () => {
        this.connected = true;
        // First connect → flip the flag and stop. Subsequent connects are
        // reconnections; re-register everything and emit 'reconnect'.
        if (!this.hasConnectedOnce) {
          this.hasConnectedOnce = true;
          return;
        }
        debug('reconnect', 're-registering providers');
        this.reRegister().then(() => this.emit('reconnect'));
      });

      // On socket close, reject every pending call — the responses will never
      // arrive. Also clear the in-flight provide handler tracking (those IIFEs
      // keep running in the background, but their eventual RESPONSE bytes go
      // nowhere — the original MCU msgid is unknown to any socket we reconnect
      // to). Finally, emit a `disconnect` event so application-layer consumers
      // (e.g. n8n's UnoQTrigger holding deferred PendingRequests entries) have
      // a hook to clean up their own state instead of waiting for a RESPONSE
      // that will never reach the original caller.
      this.transport.on('close', () => {
        this.connected = false;
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new ConnectionError('Socket closed'));
          this.pending.delete(id);
        }
        this.activeHandlers.clear();
        this.emit('disconnect');
      });

      this.transport.on('error', (err: Error) => {
        this.emit('error', err);
      });

      // Wait for the first successful connection before resolving
      this.transport.once('connect', () => {
        debug('connect', 'connected to', this.options.socket);
        this.connected = true;
        resolve();
      });
      this.transport.once('error', (err: Error) => reject(err));
      this.transport.connect();
    });
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
        pending.reject(new BridgeError(String(error)));
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
        const task = (async () => {
          try {
            const result = await handler(params as unknown[], msgid as number);
            const ok = this.transport.write(encodeResponse(msgid as number, null, result));
            if (!ok) debug('send', 'response dropped (socket closed)', msgid, method);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.transport.write(encodeResponse(msgid as number, message, null));
          }
        })();
        this.activeHandlers.add(task);
        task.finally(() => this.activeHandlers.delete(task));
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
   * Retry contract (CONTEXT.md §6.4):
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
   * Example:
   * ```ts
   * await bridge.provide('echo', (params) => ({ echo: params }));
   * ```
   */
  async provide(method: string, handler: ProvideHandler): Promise<void> {
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

  /** Gracefully close the socket and clean up all listeners. */
  async close(): Promise<void> {
    await this.transport.close();
    this.removeAllListeners();
  }
}
