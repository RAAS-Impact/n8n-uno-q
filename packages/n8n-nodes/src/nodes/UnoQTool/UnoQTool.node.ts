// TODO: Implement UnoQ Tool (AI Agent sub-node)
// - name: MCU method name
// - description: plain-English for the LLM
// - parameter schema: list of {name, type, description, required}
// - human review gate (checkbox, default on for state-changing methods)
// - socket path (Advanced options)
//
// Extends tool sub-node pattern with ai_tool connection type.
// Under the hood: bridge.call(method, params) — same as UnoQCall.

export class UnoQTool {
  // Placeholder — will implement INodeType with ai_tool output
}
