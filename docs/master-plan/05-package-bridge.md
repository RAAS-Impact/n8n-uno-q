## 5. Package 1 — `@raasimpact/arduino-uno-q-bridge`

**Status: implemented and publish-ready.** Source, tests, README, LICENSE all in place.

### Scope and shape

- Pure Node.js, ES modules, TypeScript source, publishes both ESM and types.
- Single dependency: `@msgpack/msgpack`.
- License: MIT.

### Public API (implemented)

```ts
import { Bridge } from '@raasimpact/arduino-uno-q-bridge';

const bridge = await Bridge.connect({
  socket: '/var/run/arduino-router.sock',  // default
  reconnect: { enabled: true, baseDelayMs: 200, maxDelayMs: 5000 },
});

// Outbound call — router forwards to whoever registered this method
const answer = await bridge.call('set_led_state', true);
const answer = await bridge.callWithTimeout('slow_op', 10_000);
bridge.notify('fire_and_forget', 'hello');

// Inbound: register ourselves as the handler of a name
await bridge.provide('log_from_linux', async (params, msgid) => {
  console.log('MCU says:', params);
  return 'ok';
});

// Inbound notifications (MCU → us, fire-and-forget)
// Returns an unsubscribe function
const unsub = await bridge.onNotify('button_pressed', (params) => { /* ... */ });

// Lifecycle
bridge.on('reconnect', () => { /* providers and notify subs are re-registered automatically */ });
bridge.on('error', (err) => { /* log */ });
await bridge.close();
```

### Behaviours implemented

- **msgid allocation** — monotonic counter wrapping at 2³¹. In-flight requests tracked in `Map<msgid, {resolve, reject, timer}>`.
- **Timeouts** — default 5s via `call()`, custom via `callWithTimeout()`. All pending rejected on socket close.
- **Automatic reconnect with exponential backoff**, capped at `maxDelayMs`. On reconnect, re-registers all `provide` and `onNotify` subscriptions automatically.
- **Typed error hierarchy** — `BridgeError` (base), `TimeoutError` (code `TIMEOUT`), `ConnectionError` (code `CONNECTION`), `MethodNotAvailableError` (code `METHOD_NOT_AVAILABLE`).
- **Debug logging** — activate with `DEBUG=bridge node …`.
- **MockRouter** in unit tests — deterministic in-process fake router, no real socket needed.

### Repo layout (actual)

```
packages/bridge/
├── src/
│   ├── index.ts                     # public API, re-exports
│   ├── bridge.ts                    # Bridge class
│   ├── transport.ts                 # socket wrapper + reconnect
│   ├── codec.ts                     # msgpack encode/decode + StreamDecoder
│   └── errors.ts                    # BridgeError hierarchy
├── test/
│   ├── bridge.test.ts               # unit tests with MockRouter
│   ├── codec.test.ts                # codec / StreamDecoder unit tests
│   └── integration.test.ts          # real router via SSH tunnel (skipped if UNOQ_SOCKET unset)
├── package.json
├── tsconfig.json
├── vitest.integration.config.ts
├── README.md
└── LICENSE                          # MIT
```
