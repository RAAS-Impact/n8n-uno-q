# @raasimpact/arduino-uno-q-bridge

A Node.js MessagePack-RPC client for the [Arduino UNO Q](https://store.arduino.cc/products/uno-q) router (`arduino-router`). Lets any Node.js process read sensors, drive GPIO, call I2C devices, and react to async events from the MCU — with no Python proxy in the way.

## Requirements

- Node.js 20+
- Arduino UNO Q with `arduino-router` running (Unix socket at `/var/run/arduino-router.sock`)
- MCU sketch using [`Arduino_RouterBridge`](https://www.arduinolibraries.info/libraries/arduino_router-bridge)

## Installation

```bash
npm install @raasimpact/arduino-uno-q-bridge
```

## Quick start

```ts
import { Bridge } from '@raasimpact/arduino-uno-q-bridge';

const bridge = await Bridge.connect();
// default socket: /var/run/arduino-router.sock

// Call a method registered on the MCU
const temp = await bridge.call('read_temperature');

// Fire and forget
bridge.notify('log_event', 'startup');

// Register as handler for inbound MCU calls
await bridge.provide('set_config', async (params) => {
  // params is the array the MCU passed
  return 'ok';
});

// Subscribe to MCU notifications (no response expected)
await bridge.onNotify('button_pressed', (params) => {
  console.log('Button', params[0], 'state:', params[1]);
});

await bridge.close();
```

## API

### `Bridge.connect(opts?)`

Returns a connected `Bridge` instance.

| Option | Type | Default | Description |
|---|---|---|---|
| `socket` | `string` | `/var/run/arduino-router.sock` | Unix socket path |
| `reconnect.enabled` | `boolean` | `true` | Auto-reconnect on drop |
| `reconnect.baseDelayMs` | `number` | `200` | Initial backoff delay |
| `reconnect.maxDelayMs` | `number` | `5000` | Backoff cap |

### `bridge.call(method, ...params)`

Send an RPC request and wait for the response (5s default timeout). Rejects with `BridgeError` on router error, `TimeoutError` on timeout, `ConnectionError` if the socket closes.

### `bridge.callWithTimeout(method, timeoutMs, ...params)`

Same as `call()` with an explicit timeout.

### `bridge.callWithOptions(method, params, { timeoutMs?, idempotent? })`

Like `call()` but with per-call retry semantics. See [Retry and idempotency](#retry-and-idempotency) below.

### `bridge.notify(method, ...params)`

Fire-and-forget. No response, no error propagation.

### `bridge.provide(method, handler)`

Register as the handler for `method` on the router. The handler receives `(params: unknown[], msgid: number)` and its return value is sent back as the RPC response. Throwing sends an error response. Re-registered automatically on reconnect.

### `bridge.onNotify(method, handler)`

Subscribe to inbound notifications. Returns an unsubscribe function. Multiple handlers per method are supported.

### `bridge.close()`

Gracefully close the socket.

### Events

| Event | Payload | When |
|---|---|---|
| `reconnect` | — | After a successful reconnection |
| `error` | `Error` | Non-fatal errors (re-registration failures, etc.) |

## Error types

```ts
import { BridgeError, TimeoutError, ConnectionError, MethodNotAvailableError } from '@raasimpact/arduino-uno-q-bridge';
```

All errors extend `BridgeError` and carry a `code` string for programmatic handling:

| Class | `code` | When |
|---|---|---|
| `TimeoutError` | `TIMEOUT` | No response within the timeout window |
| `ConnectionError` | `CONNECTION` | Socket closed or unreachable |
| `MethodNotAvailableError` | `METHOD_NOT_AVAILABLE` | Router has no handler for the method |

## Retry and idempotency

When the router socket drops mid-call, the MCU may have already executed a write but the response never made it back. A naïve retry fires the actuator twice. `callWithOptions` solves this with a single per-call boolean — `idempotent` — that gates auto-retry on `ConnectionError`.

```ts
// Safe to replay: setting an absolute state.
await bridge.callWithOptions('set_valve', [0], { idempotent: true });

// Unsafe to replay: relative move. Default (idempotent: false) = never retry.
await bridge.callWithOptions('move_stepper', [+100]);
```

### When to set `idempotent: true`

Ask: *if the socket drops and the bridge replays this call with the same params, does the MCU end up in the same state?*

- **Yes** — absolute writes (`set_valve(closed)`, `set_led_brightness(50)`), pure reads (`read_temperature`). Safe to retry.
- **No** — anything whose effect compounds: relative moves (`move_stepper(+100)`), pulses (`pulse_relay`), counters (`increment_and_read`). Must not retry.

The "absolute write" case is the common IoT one and is why the flag isn't just "read-only": `set_valve(closed)` writes to hardware but is still safe to replay.

### Retry contract

- On `ConnectionError` (mid-call OR when starting a call while the bridge is known-disconnected) **and only if** `idempotent: true`: the call races the bridge's `reconnect` event against the remaining `timeoutMs` budget. Reconnect wins → retry. If the retry also hits a `ConnectionError`, race again — keep retrying as long as the budget allows. (A single router restart usually produces multiple drop/reconnect cycles, so one retry is not enough in practice.)
- Each iteration awaits an actual `reconnect` event — no spinning, no fixed sleep.
- Never retry on `TimeoutError` — the MCU may still be executing, indistinguishable from a hang at this layer.
- Never retry non-idempotent calls regardless of error type.
- The original `timeoutMs` is the hard cap on total wall time. Once it runs out, the call rejects with `TimeoutError` regardless of how many retries were attempted.

### LLM-facing tool descriptions

If you are exposing a method to an LLM agent (directly or through `n8n-nodes-uno-q`), the safety signaling belongs in the tool description prose — the bridge does not prepend tags for you. Different models parse different conventions best; pick one and use it consistently. A few templates:

```
Reads the onboard temperature. Safe to call any time; no side effects.
Sets the valve to the given percentage open. Retryable — repeating the call with the same value leaves the valve in the same state.
Pulses the relay once. Each call advances state — never call this twice for the same intended action.
```

For per-*invocation* enforcement (rejecting specific calls at the gate — bad parameters, wrong time of day, external-state gating), use the `n8n-nodes-uno-q` Method node's **Method Guard** field — a small JS function that inspects `method` + `params` and returns a rejection string that the agent sees as tool output.

## Running inside Docker

Bind-mount the router socket into the container:

```yaml
volumes:
  - /var/run/arduino-router.sock:/var/run/arduino-router.sock
```

## Debug logging

```bash
DEBUG=bridge node your-script.mjs
```

Logs sent/received messages with msgid to stderr.

## License

MIT
