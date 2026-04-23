/**
 * @raasimpact/arduino-uno-q-bridge
 *
 * Public API for the MessagePack-RPC client for Arduino UNO Q's router.
 * Everything a consumer needs is exported from here — no need to import
 * from internal modules.
 */
export { Bridge } from './bridge.js';
export type {
  BridgeOptions,
  CallOptions,
  ConnectOptions,
  ReconnectOptions,
  ProvideHandler,
  NotifyHandler,
} from './bridge.js';
export { BridgeError, TimeoutError, ConnectionError, MethodNotAvailableError } from './errors.js';
export type { Transport, TransportDescriptor } from './transport/index.js';
export {
  describeTransport,
  createTransport,
  UnixSocketTransport,
  TcpTransport,
  TlsTransport,
} from './transport/index.js';
export type {
  UnixSocketTransportOptions,
  TcpTransportOptions,
  TlsTransportOptions,
} from './transport/index.js';
