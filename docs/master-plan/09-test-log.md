## 9. Test log — what's already verified on my Q

All tests run from the PC via SSH tunnel. Node never runs directly on the Q.

```bash
rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
```

### April 2026 — raw socket smoke tests

Before the Bridge package existed, two one-shot scripts in `experiments/` validated the stack:

- `test-router.mjs` — raw msgpack over Unix socket, called `$/version`. Result: `[ 1, 1, null, '0.5.4' ]` ✅
- Manual `set_led_state(true)` call with the LED sketch — LED visibly on. ✅ **End-to-end pipeline validated.**

Router version at that time: **0.5.4**.

### April 2026 — Bridge package integration tests

With [sketches/integration-test.ino](sketches/integration-test.ino) flashed and SSH tunnel open, [packages/bridge/test/integration.test.ts](packages/bridge/test/integration.test.ts) passes all of:

| Test | What it verifies |
|---|---|
| `$/version` returns a non-empty string | Router reachable, protocol working |
| `callWithTimeout` resolves within limit | Timeout path |
| `provide`: Node → router → Node round-trip | Inbound call + response |
| `notify`: Node → router → Node delivery | NOTIFY forwarding |
| `ping` returns `"pong"` | MCU method call |
| `add(2, 3)` returns `5` | Typed params |
| `set_led_state` / `get_led_state` | Write + read state on MCU |
| `set_rgb_state` / `get_rgb_state` | Array-typed params round-trip (`bool[3]`) |
| `heartbeat` NOTIFY arrives within 7s | Async MCU → Node event |
| `gpio_event` via `fire_test_event` | Interrupt flag → MCU `Bridge.call` → Node subscriber |

Router version at time of testing: **0.8.0**.
