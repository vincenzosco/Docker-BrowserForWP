// The messages, one encode/decode pair each.
//
// The field order in these functions IS the protocol. There is nowhere else to
// look, which is deliberate: a protocol described in a document and implemented
// somewhere else drifts, and the drift is only visible as a garbled screen.
// docs/PROTOCOL.md restates this file for readers; the client's VB mirror
// follows this file; protocol/vectors.json pins concrete bytes for both.
//
// Every decoder calls .end(), so trailing bytes are an error rather than a
// silently ignored extension. That is what makes a version mismatch loud.

import {
  FRAME_FORMAT_JPEG,
  FRAME_FLAG_FULL,
  HELLO_ACK_FLAG_AUDIO,
  ProtocolError,
  Reader,
  SETTINGS_BLOCK_TRACKERS,
  SETTINGS_DESKTOP_MODE,
  SETTINGS_NIGHT_MODE,
  Writer,
} from './index.js';

/** A viewport beyond this is a client bug, not a device. */
export const MAX_VIEWPORT = 4096;
export const MAX_TILES_PER_FRAME = 256;
export const MAX_TEXT_FIELD = 4096;
export const MAX_URL_FIELD = 8192;

function bounded(value, max, name) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ProtocolError(`${name} must be an integer in 0..${max}, got ${value}`);
  }
  return value;
}

/** For the fields that go out as a SIGNED integer, like a scroll delta. */
function boundedSigned(value, max, name) {
  const min = -max - 1;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string') throw new ProtocolError(`${name} must be a string`);
  return value;
}

// ── 0x01 HELLO, client to server, in the clear ───────────────────────────────
// The token is the IKM for the session keys, which is exactly why the salt comes
// back in HELLO_ACK rather than being chosen here: a client-chosen salt under a
// client-chosen token is a client-chosen key.

export function encodeHello({
  protocolVersion,
  deviceId,
  token,
  viewportWidth,
  viewportHeight,
  devicePixelRatio = 1,
  clientName = '',
}) {
  return new Writer()
    .u8(protocolVersion)
    .str(deviceId)
    .str(token)
    .u16(bounded(viewportWidth, MAX_VIEWPORT, 'viewportWidth'))
    .u16(bounded(viewportHeight, MAX_VIEWPORT, 'viewportHeight'))
    .u8(bounded(devicePixelRatio, 4, 'devicePixelRatio'))
    .str(clientName)
    .build();
}

export function decodeHello(payload) {
  const reader = new Reader(payload);
  const message = {
    protocolVersion: reader.u8(),
    deviceId: reader.str(),
    token: reader.str(),
    viewportWidth: reader.u16(),
    viewportHeight: reader.u16(),
    devicePixelRatio: reader.u8(),
    clientName: reader.str(),
  };
  reader.end();
  if (message.viewportWidth === 0 || message.viewportHeight === 0) {
    throw new ProtocolError('a viewport with a zero side cannot be rendered');
  }
  if (message.devicePixelRatio < 1) throw new ProtocolError('devicePixelRatio must be at least 1');
  return message;
}

// ── 0x02 HELLO_ACK, server to client, in the clear ───────────────────────────

export function encodeHelloAckOk({ sessionSalt, maxFrameBytes, flags = 0, serverName = '', audioUrl = '' }) {
  return new Writer()
    .u8(1)
    .blob(sessionSalt)
    .u32(maxFrameBytes)
    .u8(flags)
    .str(serverName)
    .str(audioUrl)
    .build();
}

export function encodeHelloAckError({ code, message = '' }) {
  return new Writer().u8(0).u16(code).str(message).build();
}

export function decodeHelloAck(payload) {
  const reader = new Reader(payload);
  const ok = reader.u8();
  if (ok === 0) {
    const message = { ok: false, code: reader.u16(), message: reader.str() };
    reader.end();
    return message;
  }
  const message = {
    ok: true,
    sessionSalt: reader.blob(),
    maxFrameBytes: reader.u32(),
    flags: reader.u8(),
    serverName: reader.str(),
    audioUrl: reader.str(),
  };
  reader.end();
  if (message.sessionSalt.length === 0) throw new ProtocolError('HELLO_ACK carried no session salt');
  return message;
}

/** The only flag bit defined on HELLO_ACK. */
export function hasAudio(helloAck) {
  return (helloAck.flags & HELLO_ACK_FLAG_AUDIO) !== 0;
}

// ── 0x03 ERROR, server to client, in the clear ───────────────────────────────

export function encodeError({ code, message = '' }) {
  return new Writer().u16(code).str(message).build();
}

export function decodeError(payload) {
  const reader = new Reader(payload);
  const message = { code: reader.u16(), message: reader.str() };
  reader.end();
  return message;
}

// ── The sealed messages ──────────────────────────────────────────────────────
// From here on, each pair is a few lines and reads as the field list.

export function encodeNavigate({ url }) {
  return new Writer().str(requiredString(url, 'url')).build();
}

export function decodeNavigate(payload) {
  const reader = new Reader(payload);
  const url = reader.str();
  reader.end();
  if (url.length > MAX_URL_FIELD) throw new ProtocolError('url is implausibly long');
  return { url };
}

export function encodeEmpty() {
  return Buffer.alloc(0);
}

export function decodeEmpty(payload) {
  if (payload.length !== 0) throw new ProtocolError('this message carries no fields');
  return {};
}

export function encodeResize({ width, height, devicePixelRatio = 1 }) {
  return new Writer()
    .u16(bounded(width, MAX_VIEWPORT, 'width'))
    .u16(bounded(height, MAX_VIEWPORT, 'height'))
    .u8(bounded(devicePixelRatio, 4, 'devicePixelRatio'))
    .build();
}

export function decodeResize(payload) {
  const reader = new Reader(payload);
  const message = { width: reader.u16(), height: reader.u16(), devicePixelRatio: reader.u8() };
  reader.end();
  return message;
}

export function encodeTap({ x, y, buttons = 1, clickCount = 1 }) {
  return new Writer()
    .u16(bounded(x, MAX_VIEWPORT, 'x'))
    .u16(bounded(y, MAX_VIEWPORT, 'y'))
    .u8(bounded(buttons, 7, 'buttons'))
    .u8(bounded(clickCount, 3, 'clickCount'))
    .build();
}

export function decodeTap(payload) {
  const reader = new Reader(payload);
  const message = { x: reader.u16(), y: reader.u16(), buttons: reader.u8(), clickCount: reader.u8() };
  reader.end();
  return message;
}

export function encodeScroll({ x, y, deltaX, deltaY }) {
  return new Writer()
    .u16(bounded(x, MAX_VIEWPORT, 'x'))
    .u16(bounded(y, MAX_VIEWPORT, 'y'))
    .i16(boundedSigned(deltaX, 0x7fff, 'deltaX'))
    .i16(boundedSigned(deltaY, 0x7fff, 'deltaY'))
    .build();
}

export function decodeScroll(payload) {
  const reader = new Reader(payload);
  const message = { x: reader.u16(), y: reader.u16(), deltaX: reader.i16(), deltaY: reader.i16() };
  reader.end();
  return message;
}

/** `key` is a Playwright key name ("Enter", "Backspace"), not a scan code. */
export function encodeKey({ key, modifiers = 0, text = '' }) {
  return new Writer().str(requiredString(key, 'key')).u8(bounded(modifiers, 255, 'modifiers')).str(text).build();
}

export function decodeKey(payload) {
  const reader = new Reader(payload);
  const message = { key: reader.str(), modifiers: reader.u8(), text: reader.str() };
  reader.end();
  return message;
}

export function encodeText({ text }) {
  return new Writer().str(requiredString(text, 'text')).build();
}

export function decodeText(payload) {
  const reader = new Reader(payload);
  const text = reader.str();
  reader.end();
  if (text.length > MAX_TEXT_FIELD) throw new ProtocolError('text field is implausibly long');
  return { text };
}

export function encodeFind({ text }) {
  return new Writer().str(requiredString(text, 'text')).build();
}

export const decodeFind = decodeText;

export function encodeSettings({ nightMode = false, desktopMode = false, blockTrackers = false }) {
  let flags = 0;
  if (nightMode) flags |= SETTINGS_NIGHT_MODE;
  if (desktopMode) flags |= SETTINGS_DESKTOP_MODE;
  if (blockTrackers) flags |= SETTINGS_BLOCK_TRACKERS;
  return new Writer().u8(flags).build();
}

export function decodeSettings(payload) {
  const reader = new Reader(payload);
  const flags = reader.u8();
  reader.end();
  return {
    nightMode: (flags & SETTINGS_NIGHT_MODE) !== 0,
    desktopMode: (flags & SETTINGS_DESKTOP_MODE) !== 0,
    blockTrackers: (flags & SETTINGS_BLOCK_TRACKERS) !== 0,
  };
}

export function encodeNonce(nonce) {
  return new Writer().u32(bounded(nonce, 0xffffffff, 'nonce')).build();
}

export function decodeNonce(payload) {
  const reader = new Reader(payload);
  const nonce = reader.u32();
  reader.end();
  return { nonce };
}

export function encodeAck({ frameSeq }) {
  return new Writer().u32(bounded(frameSeq, 0xffffffff, 'frameSeq')).build();
}

export const decodeAck = decodeNonce;

export function encodeTitle({ title }) {
  return new Writer().str(requiredString(title, 'title')).build();
}

export function decodeTitle(payload) {
  const reader = new Reader(payload);
  const title = reader.str();
  reader.end();
  return { title };
}

export function encodeUrl({ url }) {
  return new Writer().str(requiredString(url, 'url')).build();
}

export const decodeUrl = decodeNavigate;

export function encodeLoadState({ state, detail = '' }) {
  return new Writer().u8(bounded(state, 2, 'state')).str(detail).build();
}

export function decodeLoadState(payload) {
  const reader = new Reader(payload);
  const state = reader.u8();
  const detail = reader.str();
  reader.end();
  return { state, detail };
}

/**
 * 0x23 FRAME, server to client.
 *
 * A tile list rather than one rectangle, because the primitive that produces
 * these frames (Chromium's screencast) hands back a whole viewport today, and a
 * differ that sends only what changed is the obvious next step. Sending a list
 * of one costs a two-byte count and saves a protocol version later.
 */
export function encodeFrame({ format = FRAME_FORMAT_JPEG, flags = 0, tiles }) {
  if (!Array.isArray(tiles) || tiles.length === 0) throw new ProtocolError('a frame needs at least one tile');
  if (tiles.length > MAX_TILES_PER_FRAME) throw new ProtocolError('too many tiles in one frame');
  const writer = new Writer().u8(format).u8(flags).u16(tiles.length);
  for (const tile of tiles) {
    writer
      .u16(bounded(tile.x, MAX_VIEWPORT, 'tile.x'))
      .u16(bounded(tile.y, MAX_VIEWPORT, 'tile.y'))
      .u16(bounded(tile.width, MAX_VIEWPORT, 'tile.width'))
      .u16(bounded(tile.height, MAX_VIEWPORT, 'tile.height'))
      .blob(tile.data);
  }
  return writer.build();
}

export function encodeFullFrame({ data, width, height, format = FRAME_FORMAT_JPEG }) {
  return encodeFrame({
    format,
    flags: FRAME_FLAG_FULL,
    tiles: [{ x: 0, y: 0, width, height, data }],
  });
}

export function decodeFramePayload(payload, { maxTiles = MAX_TILES_PER_FRAME } = {}) {
  const reader = new Reader(payload);
  const format = reader.u8();
  const flags = reader.u8();
  const count = reader.u16();
  if (count > maxTiles) throw new ProtocolError(`frame declares ${count} tiles, limit is ${maxTiles}`);
  const tiles = [];
  for (let index = 0; index < count; index += 1) {
    tiles.push({
      x: reader.u16(),
      y: reader.u16(),
      width: reader.u16(),
      height: reader.u16(),
      data: reader.blob(),
    });
  }
  reader.end();
  return { format, flags, tiles };
}

export function encodeFindResult({ found, matches = 0 }) {
  return new Writer().u8(found ? 1 : 0).u32(bounded(matches, 0xffffffff, 'matches')).build();
}

export function decodeFindResult(payload) {
  const reader = new Reader(payload);
  const message = { found: reader.u8() !== 0, matches: reader.u32() };
  reader.end();
  return message;
}

export function encodeAudio({ playing, url = '' }) {
  return new Writer().u8(playing ? 1 : 0).str(url).build();
}

export function decodeAudio(payload) {
  const reader = new Reader(payload);
  const message = { playing: reader.u8() !== 0, url: reader.str() };
  reader.end();
  return message;
}

export const AUDIO_FLAG = HELLO_ACK_FLAG_AUDIO;

/**
 * 0x27 FOCUS, server to client.
 *
 * One byte, because one bit is the whole question the client asks: is the thing
 * that has the page's focus able to take text? The answer decides whether the
 * phone raises its soft keyboard, and it has to come from here — the page lives
 * on this side, and the phone cannot see a caret, a field or a focus ring.
 *
 * It is NOT "the page has a text field". It is "the focus is in one right now",
 * which is why the session sends it on a change rather than a schedule: a tap on
 * a link and a tap on a search box are the same message with a different byte,
 * and a client that guessed from the page would raise the keyboard on both.
 *
 * The kind of field (password, email, number) would let the phone choose a soft
 * keyboard layout, and is deliberately absent: the decoders reject trailing
 * bytes, so adding it is a change in two repositories and in the vectors, and a
 * layout that no handset here can confirm is not worth that yet.
 */
export function encodeFocus({ editable }) {
  return new Writer().u8(editable ? 1 : 0).build();
}

export function decodeFocus(payload) {
  const reader = new Reader(payload);
  const raw = reader.u8();
  reader.end();
  // 0 and 1 only. A third value is a client or a server that invented an
  // extension without a version, and "truthy" would hide it.
  if (raw > 1) throw new ProtocolError(`focus.editable must be 0 or 1, got ${raw}`);
  return { editable: raw === 1 };
}
