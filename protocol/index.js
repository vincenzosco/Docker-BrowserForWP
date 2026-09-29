// BrowserForWP render protocol — the wire format, both directions.
//
// A Windows Phone 8.1 package cannot host a modern engine: the AppContainer
// forbids writable-and-executable memory, so there is no JIT, and no third-party
// engine can be deployed at all. What that platform CAN do is draw and send
// input. So this server renders the page and the phone is a viewer with an input
// device, which makes this file the contract between two codebases in two
// languages.
//
// A contract across languages fails silently: a field read at the wrong offset
// produces garbage on a screen, not an exception in a log. It is therefore
// pinned by protocol/vectors.json, whose content is deterministic (a fixed
// token, a fixed salt, fixed plaintexts). The VB re-implementation is checked
// byte for byte against a copy of that file.
//
// Payloads are BINARY, not JSON, for two reasons that both come from the device:
//
//   * The client is a VB/WinRT project with no JSON parser anywhere in it, and
//     adding one is new attack surface for a format the device never needs.
//   * Base64 inside JSON would inflate every frame by a third, on a link that
//     is usually 3G. A 16-byte header and length-prefixed fields cost more lines
//     here and less battery there.
//
// All integers are BIG-ENDIAN and every read is bounds-checked. .NET's
// BitConverter is little-endian and unguarded, so the client cannot use it; both
// sides shift explicitly instead, which is also what makes the two readable side
// by side.

export const MAGIC = 0xb752; // '·R', the first two bytes of every frame
export const VERSION = 1;
export const HEADER_SIZE = 16;

/** Refuse anything larger before allocating for it. 8 MiB is a full-screen JPEG. */
export const MAX_PAYLOAD = 8 * 1024 * 1024;

/**
 * Message types.
 *
 * 0x01-0x03 are the HANDSHAKE and travel in the clear: the session salt they
 * carry does not exist yet, so there is nothing to seal them with. Everything
 * from 0x10 on is sealed. See SEALED_FROM.
 */
export const Type = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  ERROR: 0x03,

  NAVIGATE: 0x10,
  BACK: 0x11,
  FORWARD: 0x12,
  RELOAD: 0x13,
  STOP: 0x14,
  RESIZE: 0x15,
  TAP: 0x16,
  SCROLL: 0x17,
  KEY: 0x18,
  TEXT: 0x19,
  FIND: 0x1a,
  SETTINGS: 0x1b,
  PING: 0x1c,
  ACK: 0x1d,

  TITLE: 0x20,
  URL: 0x21,
  LOAD_STATE: 0x22,
  FRAME: 0x23,
  FIND_RESULT: 0x24,
  AUDIO: 0x25,
  PONG: 0x26,
  FOCUS: 0x27,
});

/**
 * The first type that is sealed. A single rule, checked in one place, because
 * "which frames are encrypted" answered in two places is a downgrade waiting to
 * happen: an attacker only has to find the path that forgets.
 */
export const SEALED_FROM = 0x10;

export function isSealed(type) {
  return type >= SEALED_FROM;
}

export const ErrorCode = Object.freeze({
  BAD_VERSION: 1,
  BAD_TOKEN: 2,
  UNKNOWN_DEVICE: 3,
  DISABLED_DEVICE: 4,
  PROTOCOL: 5,
  BUSY: 6,
  SERVER: 7,
});

export const LoadState = Object.freeze({
  STARTED: 0,
  DONE: 1,
  FAILED: 2,
});

export const FRAME_FORMAT_JPEG = 1;
export const FRAME_FLAG_FULL = 0x01;

export const HELLO_ACK_FLAG_AUDIO = 0x01;

export const SETTINGS_NIGHT_MODE = 0x01;
export const SETTINGS_DESKTOP_MODE = 0x02;
export const SETTINGS_BLOCK_TRACKERS = 0x04;

const TYPE_NAMES = new Map(Object.entries(Type).map(([name, value]) => [value, name]));

/** The type's name, for logs and for test failures. Unknown types stay numeric. */
export function describeType(type) {
  return TYPE_NAMES.get(type) ?? `0x${type.toString(16)}`;
}

/** Any violation of this file. Thrown, never logged and continued past. */
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function checkUint(value, max, name) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ProtocolError(`${name} must be an integer in 0..${max}, got ${value}`);
  }
}

function readUint(buf, offset, width) {
  if (width === 1) return buf.readUInt8(offset);
  if (width === 2) return buf.readUInt16BE(offset);
  return buf.readUInt32BE(offset);
}

function readInt(buf, offset, width) {
  if (width === 1) return buf.readInt8(offset);
  if (width === 2) return buf.readInt16BE(offset);
  return buf.readInt32BE(offset);
}

/** Builds a payload. Chainable, so a message reads as a list of its fields. */
export class Writer {
  constructor() {
    this._chunks = [];
    this._size = 0;
  }

  _push(buf) {
    this._chunks.push(buf);
    this._size += buf.length;
    return this;
  }

  u8(value) {
    checkUint(value, 0xff, 'u8');
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(value, 0);
    return this._push(b);
  }

  u16(value) {
    checkUint(value, 0xffff, 'u16');
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(value, 0);
    return this._push(b);
  }

  u32(value) {
    checkUint(value, 0xffffffff, 'u32');
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value, 0);
    return this._push(b);
  }

  i8(value) {
    checkUint(value + 0x80, 0xff, 'i8');
    const b = Buffer.allocUnsafe(1);
    b.writeInt8(value, 0);
    return this._push(b);
  }

  i16(value) {
    checkUint(value + 0x8000, 0xffff, 'i16');
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(value, 0);
    return this._push(b);
  }

  i32(value) {
    checkUint(value + 0x80000000, 0xffffffff, 'i32');
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(value, 0);
    return this._push(b);
  }

  /** A length-prefixed byte string. The length prefix counts bytes, not characters. */
  blob(bytes) {
    const b = Buffer.from(bytes ?? Buffer.alloc(0));
    this.u32(b.length);
    return this._push(b);
  }

  /** A length-prefixed UTF-8 string. */
  str(text) {
    if (text === null || text === undefined) return this.blob(Buffer.alloc(0));
    if (typeof text !== 'string') throw new ProtocolError('str() takes a string');
    return this.blob(Buffer.from(text, 'utf8'));
  }

  get size() {
    return this._size;
  }

  build() {
    return Buffer.concat(this._chunks, this._size);
  }
}

/** Consumes a payload. Every read is bounds-checked; trailing bytes are an error. */
export class Reader {
  constructor(buf) {
    this.buf = Buffer.from(buf ?? Buffer.alloc(0));
    this.offset = 0;
  }

  _need(width) {
    if (this.offset + width > this.buf.length) {
      throw new ProtocolError(`truncated payload: needed ${width} byte(s) at offset ${this.offset} of ${this.buf.length}`);
    }
  }

  u8() {
    this._need(1);
    return readUint(this.buf, (this.offset += 1) - 1, 1);
  }

  u16() {
    this._need(2);
    return readUint(this.buf, (this.offset += 2) - 2, 2);
  }

  u32() {
    this._need(4);
    return readUint(this.buf, (this.offset += 4) - 4, 4);
  }

  i8() {
    this._need(1);
    return readInt(this.buf, (this.offset += 1) - 1, 1);
  }

  i16() {
    this._need(2);
    return readInt(this.buf, (this.offset += 2) - 2, 2);
  }

  i32() {
    this._need(4);
    return readInt(this.buf, (this.offset += 4) - 4, 4);
  }

  blob() {
    const length = this.u32();
    this._need(length);
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  str() {
    return this.blob().toString('utf8');
  }

  get remaining() {
    return this.buf.length - this.offset;
  }

  /** Call at the end of every parse: a field nobody reads is a field nobody wrote. */
  end() {
    if (this.remaining !== 0) {
      throw new ProtocolError(`${this.remaining} trailing byte(s) in the payload`);
    }
    return this;
  }
}

/**
 * The 16-byte frame header.
 *
 * `length` counts the bytes that FOLLOW the header, and is the value
 * authenticated as AAD, so a frame cannot be re-labelled as another type or
 * truncated without the tag check failing. `seq` is per-direction, starts at 1,
 * and is the AEAD nonce, which is what makes a replayed frame fail to open.
 */
export function encodeHeader({ type, seq, length }) {
  checkUint(type, 0xff, 'type');
  checkUint(seq, 0xffffffff, 'seq');
  checkUint(length, MAX_PAYLOAD, 'length');
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt8(VERSION, 2);
  header.writeUInt8(type, 3);
  header.writeUInt32BE(length, 4);
  header.writeUInt32BE(seq, 8);
  header.writeUInt32BE(0, 12);
  return header;
}

export function decodeHeader(buf) {
  if (!buf || buf.length < HEADER_SIZE) {
    throw new ProtocolError(`a frame header is ${HEADER_SIZE} bytes`);
  }
  const magic = buf.readUInt16BE(0);
  if (magic !== MAGIC) {
    throw new ProtocolError(`bad magic 0x${magic.toString(16)}: this is not a BrowserForWP frame, or the stream is out of step`);
  }
  const version = buf.readUInt8(2);
  if (version !== VERSION) {
    throw new ProtocolError(`unsupported protocol version ${version}, this server speaks ${VERSION}`);
  }
  const reserved = buf.readUInt32BE(12);
  if (reserved !== 0) {
    throw new ProtocolError('reserved header field is not zero, which means a newer client with fields this server ignores');
  }
  const length = buf.readUInt32BE(4);
  if (length > MAX_PAYLOAD) {
    throw new ProtocolError(`declared payload of ${length} bytes exceeds the ${MAX_PAYLOAD}-byte limit`);
  }
  return {
    type: buf.readUInt8(3),
    seq: buf.readUInt32BE(8),
    length,
    header: buf.subarray(0, HEADER_SIZE),
  };
}

export function encodeFrame({ type, seq, payload }) {
  const body = Buffer.from(payload ?? Buffer.alloc(0));
  return Buffer.concat([encodeHeader({ type, seq, length: body.length }), body]);
}

export function decodeFrame(buf) {
  const { type, seq, length } = decodeHeader(buf);
  if (buf.length < HEADER_SIZE + length) {
    throw new ProtocolError('frame is shorter than the length in its own header');
  }
  return { type, seq, payload: buf.subarray(HEADER_SIZE, HEADER_SIZE + length) };
}

/**
 * Splits a byte stream into frames.
 *
 * TCP has no message boundaries, so this is where "a chunk is not a message"
 * lives, in one place, tested against chunks split in the middle of a header and
 * in the middle of a payload. It reports no opinion about sealing: whether a
 * payload needs opening is the session's rule, and stating it twice would be
 * stating it inconsistently.
 */
export class FrameDecoder {
  constructor({ maxPayload = MAX_PAYLOAD } = {}) {
    this._pending = Buffer.alloc(0);
    this._maxPayload = maxPayload;
  }

  get pendingBytes() {
    return this._pending.length;
  }

  /** Returns every complete frame in the buffer now; keeps the remainder. */
  push(chunk) {
    if (chunk && chunk.length > 0) {
      this._pending = this._pending.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this._pending, chunk]);
    }

    const frames = [];
    for (;;) {
      if (this._pending.length < HEADER_SIZE) break;
      const { type, seq, length } = decodeHeader(this._pending.subarray(0, HEADER_SIZE));
      if (length > this._maxPayload) {
        throw new ProtocolError(`frame of ${length} bytes exceeds the ${this._maxPayload}-byte limit`);
      }
      if (this._pending.length < HEADER_SIZE + length) break;
      frames.push({
        type,
        seq,
        payload: this._pending.subarray(HEADER_SIZE, HEADER_SIZE + length),
      });
      this._pending = this._pending.subarray(HEADER_SIZE + length);
    }
    return frames;
  }
}
