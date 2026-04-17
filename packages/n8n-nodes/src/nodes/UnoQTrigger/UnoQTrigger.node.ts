import type {
  INodeType,
  INodeTypeDescription,
  ITriggerFunctions,
  ITriggerResponse,
} from 'n8n-workflow';

// Scaffold: empty trigger so n8n loads the package.
// TODO: BridgeManager.acquire() → bridge.provide(method, handler) that emits to workflow.
export class UnoQTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Trigger',
    name: 'unoQTrigger',
    icon: 'file:unoQTrigger.svg',
    group: ['trigger'],
    version: 1,
    description: 'Trigger a workflow on events from the Arduino UNO Q MCU',
    defaults: { name: 'Arduino UNO Q Trigger' },
    codex: {
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    inputs: [],
    outputs: ['main'],
    properties: [],
  };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    return { closeFunction: async () => {} };
  }
}
