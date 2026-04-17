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
