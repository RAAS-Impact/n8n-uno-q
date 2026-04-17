import { describe, it, expect } from 'vitest';
import { encodeRequest, encodeResponse, encodeNotify, StreamDecoder, MSG_REQUEST, MSG_RESPONSE, MSG_NOTIFY } from '../src/codec.js';

describe('codec', () => {
  it('encodes a request', () => {
    const buf = encodeRequest(1, '$/version', []);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('encodes a response', () => {
    const buf = encodeResponse(1, null, '0.5.4');
    expect(buf).toBeInstanceOf(Uint8Array);
  });

  it('encodes a notify', () => {
    const buf = encodeNotify('event', ['hello']);
    expect(buf).toBeInstanceOf(Uint8Array);
  });
});

describe('StreamDecoder', () => {
  it('decodes a single complete message', () => {
    const decoder = new StreamDecoder();
    const encoded = encodeRequest(1, '$/version', []);
    const messages = decoder.feed(encoded);
    expect(messages).toHaveLength(1);
    expect(messages[0][0]).toBe(MSG_REQUEST);
    expect(messages[0][2]).toBe('$/version');
  });

  it('handles multiple messages in one chunk', () => {
    const decoder = new StreamDecoder();
    const a = encodeRequest(1, 'foo', []);
    const b = encodeResponse(1, null, 'ok');
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a);
    combined.set(b, a.length);

    const messages = decoder.feed(combined);
    expect(messages).toHaveLength(2);
    expect(messages[0][0]).toBe(MSG_REQUEST);
    expect(messages[1][0]).toBe(MSG_RESPONSE);
  });
});
