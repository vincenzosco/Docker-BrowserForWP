import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDecoder,
  HEADER_SIZE,
  MAGIC,
  MAX_PAYLOAD,
  ProtocolError,
  Reader,
  Type,
  VERSION,
  Writer,
  decodeFrame,
  decodeHeader,
  encodeFrame,
  encodeHeader,
  isSealed,
} from '../protocol/index.js';

test('the integers go out big-endian, not in host order', () => {
  const buffer = new Writer()
    .u8(0x12)
    .u16(0x3456)
    .u32(0x789abcde)
    .i16(-2)
    .i32(-3)
    .build();

  assert.equal(buffer.subarray(0, 1).toString('hex'), '12');
  assert.equal(buffer.subarray(1, 3).toString('hex'), '3456');
  assert.equal(buffer.subarray(3, 7).toString('hex'), '789abcde');
  assert.equal(buffer.subarray(7, 9).toString('hex'), 'fffe');
  assert.equal(buffer.subarray(9, 13).toString('hex'), 'fffffffd');
});

test('a Writer and a Reader round-trip every primitive', () => {
  const buffer = new Writer()
    .u8(200)
    .u16(40000)
    .u32(4000000000)
    .i8(-100)
    .i16(-30000)
    .i32(-2000000000)
    .str('ciao')
    .blob(Buffer.from([1, 2, 3]))
    .build();

  const reader = new Reader(buffer);
  assert.equal(reader.u8(), 200);
  assert.equal(reader.u16(), 40000);
  assert.equal(reader.u32(), 4000000000);
  assert.equal(reader.i8(), -100);
  assert.equal(reader.i16(), -30000);
  assert.equal(reader.i32(), -2000000000);
  assert.equal(reader.str(), 'ciao');
  assert.deepEqual([...reader.blob()], [1, 2, 3]);
  reader.end();
});

test('the string length prefix counts bytes, not characters', () => {
  const buffer = new Writer().str('è').build();
  assert.equal(buffer.readUInt32BE(0), 2, 'U+00E8 is two bytes in UTF-8');
  assert.equal(new Reader(buffer).str(), 'è');
});

test('a null string is an empty field, not a crash', () => {
  assert.equal(new Reader(new Writer().str(null).build()).str(), '');
});

test('reading past the end throws rather than returning a zero', () => {
  const reader = new Reader(new Writer().u8(1).build());
  reader.u8();
  assert.throws(() => reader.u16(), ProtocolError);
});

test('an integer outside its width is refused at write time', () => {
  assert.throws(() => new Writer().u8(256), ProtocolError);
  assert.throws(() => new Writer().u16(-1), ProtocolError);
  assert.throws(() => new Writer().u32(0x100000000), ProtocolError);
});

test('trailing bytes in a payload are an error', () => {
  const reader = new Reader(new Writer().u8(1).u8(2).build());
  reader.u8();
  assert.throws(() => reader.end(), ProtocolError);
});

test('the header round-trips and pins its own layout', () => {
  const header = encodeHeader({ type: Type.TAP, seq: 0x01020304, length: 0x10 });

  assert.equal(header.length, HEADER_SIZE);
  assert.equal(header.readUInt16BE(0), MAGIC);
  assert.equal(header.readUInt8(2), VERSION);
  assert.equal(header.readUInt8(3), Type.TAP);
  assert.equal(header.readUInt32BE(4), 0x10);
  assert.equal(header.readUInt32BE(8), 0x01020304);
  assert.equal(header.readUInt32BE(12), 0);

  const decoded = decodeHeader(header);
  assert.equal(decoded.type, Type.TAP);
  assert.equal(decoded.seq, 0x01020304);
  assert.equal(decoded.length, 0x10);
});

test('a foreign magic is refused by name', () => {
  const header = encodeHeader({ type: Type.TAP, seq: 1, length: 0 });
  header.writeUInt16BE(0x1234, 0);
  assert.throws(() => decodeHeader(header), /not a BrowserForWP frame/);
});

test('a different protocol version is refused with both numbers in the message', () => {
  const header = encodeHeader({ type: Type.TAP, seq: 1, length: 0 });
  header.writeUInt8(9, 2);
  assert.throws(() => decodeHeader(header), /version 9.*speaks 1/);
});

test('a reserved field that is not zero means a newer client, and is refused', () => {
  const header = encodeHeader({ type: Type.TAP, seq: 1, length: 0 });
  header.writeUInt32BE(1, 12);
  assert.throws(() => decodeHeader(header), /reserved header field/);
});

test('a declared payload beyond the limit is refused before allocating', () => {
  const header = encodeHeader({ type: Type.TAP, seq: 1, length: 0 });
  header.writeUInt32BE(MAX_PAYLOAD + 1, 4);
  assert.throws(() => decodeHeader(header), /exceeds the/);
});

test('a frame round-trips through encodeFrame and decodeFrame', () => {
  const payload = Buffer.from('hello', 'utf8');
  const frame = encodeFrame({ type: Type.NAVIGATE, seq: 3, payload });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, Type.NAVIGATE);
  assert.equal(decoded.seq, 3);
  assert.equal(decoded.payload.toString('utf8'), 'hello');
});

test('sealing is decided by the type, in one place', () => {
  assert.equal(isSealed(Type.HELLO), false);
  assert.equal(isSealed(Type.HELLO_ACK), false);
  assert.equal(isSealed(Type.ERROR), false);
  assert.equal(isSealed(Type.NAVIGATE), true);
  assert.equal(isSealed(Type.FRAME), true);
});

test('the decoder reassembles a frame split inside its header', () => {
  const frame = encodeFrame({ type: Type.PING, seq: 1, payload: Buffer.from('abcd') });
  const decoder = new FrameDecoder();

  assert.deepEqual(decoder.push(frame.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(frame.subarray(7, 18)), []);
  const frames = decoder.push(frame.subarray(18));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), 'abcd');
});

test('the decoder reassembles a frame split inside its payload', () => {
  const payload = Buffer.alloc(1000, 7);
  const frame = encodeFrame({ type: Type.FRAME, seq: 4, payload });
  const decoder = new FrameDecoder();

  assert.deepEqual(decoder.push(frame.subarray(0, HEADER_SIZE + 1)), []);
  assert.deepEqual(decoder.push(frame.subarray(HEADER_SIZE + 1, HEADER_SIZE + 999)), []);
  const frames = decoder.push(frame.subarray(HEADER_SIZE + 999));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 1000);
});

test('the decoder returns every frame in one chunk', () => {
  const first = encodeFrame({ type: Type.PING, seq: 1, payload: Buffer.from('a') });
  const second = encodeFrame({ type: Type.PONG, seq: 2, payload: Buffer.from('b') });
  const decoder = new FrameDecoder();

  const frames = decoder.push(Buffer.concat([first, second]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, Type.PING);
  assert.equal(frames[1].type, Type.PONG);
  assert.equal(decoder.pendingBytes, 0);
});

test('the decoder carries a leftover byte into the next chunk', () => {
  const frame = encodeFrame({ type: Type.PING, seq: 1, payload: Buffer.from('ab') });
  const decoder = new FrameDecoder();

  assert.deepEqual(decoder.push(Buffer.concat([frame, Buffer.from([0])])), [
    { type: Type.PING, seq: 1, payload: frame.subarray(HEADER_SIZE) },
  ]);
  assert.equal(decoder.pendingBytes, 1);
});

test('the decoder refuses an oversized frame before buffering it', () => {
  const decoder = new FrameDecoder({ maxPayload: 32 });
  const frame = encodeFrame({ type: Type.FRAME, seq: 1, payload: Buffer.alloc(64) });
  assert.throws(() => decoder.push(frame), /exceeds the 32-byte limit/);
});

test('an empty chunk changes nothing', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
  assert.deepEqual(decoder.push(null), []);
});
