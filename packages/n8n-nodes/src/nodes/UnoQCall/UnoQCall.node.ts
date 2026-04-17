import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';

// Scaffold: empty node so n8n loads the package.
// TODO: implement bridge.call(method, params) via BridgeManager.
export class UnoQCall implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Call',
    name: 'unoQCall',
    icon: 'file:unoQCall.svg',
    group: ['transform'],
    version: 1,
    description: 'Call a method on the Arduino UNO Q router',
    defaults: { name: 'Arduino UNO Q Call' },
    codex: {
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    throw new Error('UnoQ Call is not yet implemented');
  }
}
