import type {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';

// Scaffold: empty AI-tool sub-node so n8n loads the package.
// TODO: expose bridge.call(method, params) as a DynamicStructuredTool.
export class UnoQTool implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Tool',
    name: 'unoQTool',
    icon: 'file:unoQTool.svg',
    group: ['transform'],
    version: 1,
    description: 'Expose an Arduino UNO Q method as a tool for the AI Agent',
    defaults: { name: 'Arduino UNO Q Tool' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Tools'] },
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    properties: [],
  };

  async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
    throw new Error('UnoQ Tool is not yet implemented');
  }
}
