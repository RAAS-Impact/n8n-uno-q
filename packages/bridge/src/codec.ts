/**
 * codec.ts — MessagePack-RPC serialization layer.
 *
 * This module sits between the Bridge and the raw socket. It converts
 * TypeScript structures into msgpack bytes (and back) following the
 * MessagePack-RPC spec (https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md).
 *
 * Why we need this (vs. the simple approach in experiments/test-router.mjs):
 *
 * test-router.mjs does a single write → single read → close. It can use
 * decodeMultiStream directly on the socket because nothing else is happening.
 *
 * The Bridge is a persistent, concurrent, bidirectional client:
 * - Multiple call() in flight at once, responses arrive out of order
 * - Inbound requests (provide) and notifications (onNotify) arrive mixed
 *   with outbound responses on the same socket
 * - TCP/Unix sockets don't preserve message boundaries: one write() can
 *   arrive as two read() chunks, or two writes can merge into one chunk
 *
 * So we need:
 * 1. Encode functions to build each message type with the right shape
 * 2. A streaming decoder that reassembles partial chunks into complete messages
 */
import { encode, decodeMulti } from '@msgpack/msgpack';

/**
 * MessagePack-RPC message type discriminators.
 * The first element of every message array tells us what kind it is:
 * - 0 = REQUEST:  a call that expects a RESPONSE back
 * - 1 = RESPONSE: the answer to a previous REQUEST
 * - 2 = NOTIFY:   fire-and-forget, no response expected
 */
export const MSG_REQUEST = 0;
export const MSG_RESPONSE = 1;
export const MSG_NOTIFY = 2;

/** [0, msgid, method, params] — outbound call or inbound call from router */
export type RpcRequest = [typeof MSG_REQUEST, number, string, unknown[]];

/** [1, msgid, error, result] — error is null on success */
export type RpcResponse = [typeof MSG_RESPONSE, number, unknown, unknown];

/** [2, method, params] — no msgid, no response */
export type RpcNotify = [typeof MSG_NOTIFY, string, unknown[]];

export type RpcMessage = RpcRequest | RpcResponse | RpcNotify;

/** Build a REQUEST message: [0, msgid, method, params] → msgpack bytes */
export function encodeRequest(msgid: number, method: string, params: unknown[]): Uint8Array {
  return encode([MSG_REQUEST, msgid, method, params]);
}

/** Build a RESPONSE message: [1, msgid, error, result] → msgpack bytes */
export function encodeResponse(msgid: number, error: unknown, result: unknown): Uint8Array {
  return encode([MSG_RESPONSE, msgid, error, result]);
}

/** Build a NOTIFY message: [2, method, params] → msgpack bytes (no msgid) */
export function encodeNotify(method: string, params: unknown[]): Uint8Array {
  return encode([MSG_NOTIFY, method, params]);
}

/**
 * Streaming decoder that reassembles socket chunks into complete RPC messages.
 *
 * The problem: Unix sockets (and TCP) are byte streams with no message
 * boundaries. A 50-byte message can arrive as two 25-byte chunks, or two
 * messages can arrive fused in a single chunk. We can't just call decode()
 * on each chunk — we'd get errors on partial data and miss messages that
 * span chunks.
 *
 * The solution: feed() accumulates bytes in an internal buffer, then uses
 * decodeMulti() to extract as many complete messages as possible. Whatever
 * bytes remain (an incomplete trailing message) stay in the buffer for the
 * next feed() call.
 */
export class StreamDecoder {
  private buffer = new Uint8Array(0);

  /**
   * Process incoming bytes. Returns an array of fully decoded RPC messages
   * (may be empty if the chunk is an incomplete fragment).
   */
  feed(chunk: Uint8Array): RpcMessage[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const messages: RpcMessage[] = [];
    let bytesConsumed = 0;

    try {
      for (const value of decodeMulti(this.buffer)) {
        messages.push(value as RpcMessage);
        // Re-encode to measure consumed bytes. @msgpack/msgpack Decoder does not
        // expose byte position publicly. For our small RPC messages (<1KB typical)
        // the overhead is negligible.
        bytesConsumed += encode(value).length;
      }
    } catch {
      // decodeMulti throws when it hits incomplete data at the end of the
      // buffer — this is expected. The complete messages above are already
      // collected; the leftover bytes stay in the buffer for next time.
    }

    this.buffer = this.buffer.slice(bytesConsumed);
    return messages;
  }
}
