## 10. References

### Arduino

- [arduino/arduino-router](https://github.com/arduino/arduino-router) — the Go router service, with protocol documentation in README.
- [arduino-libraries/Arduino_RPClite](https://github.com/arduino-libraries/Arduino_RPClite) — MCU-side RPC primitives.
- [Arduino_RouterBridge library](https://www.arduinolibraries.info/libraries/arduino_router-bridge) — the higher-level MCU API (`Bridge.provide`, `Bridge.call`).
- [arduino/app-bricks-py](https://github.com/arduino/app-bricks-py) — the official brick repo. Target for phase 3 PR.
- [arduino/arduino-app-lab](https://github.com/arduino/arduino-app-lab) — App Lab desktop source (Wails).

### Protocol

- [MessagePack spec](https://msgpack.org/)
- [MessagePack-RPC spec](https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md)

### Related work / prior art

- [ffich/UNOQ_DoubleBridge](https://github.com/ffich/UNOQ_DoubleBridge) — Node-RED via Python TCP proxy. Useful as negative example of what we're NOT doing.
- Forum thread: [Bricks Node-RED](https://forum.arduino.cc/t/bricks-node-red/1414450) — Arduino staff confirming custom-brick distribution limitation.
- Forum thread: [Node.js Bridge](https://forum.arduino.cc/t/uno-q-has-anyone-tried-using-the-bridge-with-node-js-instead-of-python/1410860) — Arduino staff endorsing our direct-client approach.

### n8n

- [Creating nodes](https://docs.n8n.io/integrations/creating-nodes/build/)
- [Community nodes directory](https://www.npmjs.com/search?q=keywords:n8n-community-node-package)
- [Tools AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/) — the consumer of our Tool nodes.
- [What is a tool? (n8n primer)](https://docs.n8n.io/advanced-ai/examples/understand-tools/)
- [Let AI specify tool parameters ($fromAI)](https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function/)
- [Human-in-the-loop for tool calls](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
