## 2. Architecture decision: direct to router, no Python proxy

`arduino-router` (the Go service running on the UNO Q) is a MessagePack-RPC hub. It exposes itself over Unix socket and serial, accepts standard msgpack-rpc clients in any language, and routes calls between them based on method names registered via `$/register`. **The `arduino.app_utils.Bridge` Python package is nothing more than a thin client on top of this**, not a privileged intermediary.

**Consequence:** Node.js can talk to the router directly. We do **not** need a Python proxy (which would have been the naïve approach — spawning a Python sidecar container that exposes HTTP/TCP to n8n and calls `Bridge.call` internally). Removing the proxy means:

- One less container to ship, configure, monitor.
- Lower latency (one hop instead of two).
- Async events (MCU → n8n) work natively via msgpack-rpc NOTIFY — no polling, no webhooks, no second protocol.
- n8n's trigger nodes can just `$/register` a method name and wait for calls.

**Earlier alternative (rejected):** talking to n8n via TCP JSON-line through a Python App Lab app that wraps `Bridge`. This is what [UNOQ_DoubleBridge](https://github.com/ffich/UNOQ_DoubleBridge) does for Node-RED. It works, but it's strictly a superset of what we need for a worse result. Rejected.

**Confirmation from Arduino team:** in the [forum thread about Node.js Bridge](https://forum.arduino.cc/t/uno-q-has-anyone-tried-using-the-bridge-with-node-js-instead-of-python/1410860), @manchuino (Arduino staff) explicitly endorsed this path: *"you need to implement an interface to the arduino-router in node.js the same way the bridge.py script does."*
