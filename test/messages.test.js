import test from 'node:test';
import assert from 'node:assert/strict';
import * as messages from '../protocol/messages.js';

test('HELLO round-trips every field', () => {
  const hello = {
    protocolVersion: 1,
    deviceId: '0f7c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    viewportWidth: 480,
    viewportHeight: 800,
    devicePixelRatio: 2,
    clientName: 'BrowserForWP/0.1 (WindowsPhone8.1)',
  };
  assert.deepEqual(messages.decodeHello(messages.encodeHello(hello)), hello);
});

test('HELLO with a zero side is refused before a browser is started', () => {
  const encoded = messages.encodeHello({
    protocolVersion: 1,
    deviceId: 'x',
    token: 'y',
    viewportWidth: 0,
    viewportHeight: 800,
    devicePixelRatio: 1,
  });
  assert.throws(() => messages.decodeHello(encoded), /zero side/);
});

test('HELLO with a pixel ratio below one is refused', () => {
  const encoded = messages.encodeHello({
    protocolVersion: 1,
    deviceId: 'x',
    token: 'y',
    viewportWidth: 480,
    viewportHeight: 800,
    devicePixelRatio: 0,
  });
  assert.throws(() => messages.decodeHello(encoded), /at least 1/);
});

test('HELLO_ACK round-trips, and carries the salt the keys come from', () => {
  const salt = Buffer.alloc(32, 0xab);
  const ack = messages.decodeHelloAck(messages.encodeHelloAckOk({
    sessionSalt: salt,
    maxFrameBytes: 2097152,
    flags: messages.AUDIO_FLAG,
    serverName: 'test server',
    audioUrl: 'https://example/audio/abc?t=def',
  }));

  assert.equal(ack.ok, true);
  assert.deepEqual(ack.sessionSalt, salt);
  assert.equal(ack.maxFrameBytes, 2097152);
  assert.equal(ack.serverName, 'test server');
  assert.equal(ack.audioUrl, 'https://example/audio/abc?t=def');
  assert.equal(messages.hasAudio(ack), true);
});

test('a refusal carries a code and a readable reason and no salt', () => {
  const ack = messages.decodeHelloAck(messages.encodeHelloAckError({
    code: 2,
    message: 'the device token does not match',
  }));
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 2);
  assert.match(ack.message, /token/);
  assert.equal(ack.sessionSalt, undefined);
});

test('an empty salt in HELLO_ACK is refused, because it would derive a weak key', () => {
  const encoded = messages.encodeHelloAckOk({ sessionSalt: Buffer.alloc(0), maxFrameBytes: 1 });
  assert.throws(() => messages.decodeHelloAck(encoded), /no session salt/);
});

test('NAVIGATE round-trips and refuses an implausibly long url', () => {
  assert.deepEqual(
    messages.decodeNavigate(messages.encodeNavigate({ url: 'https://example.com/a?b=c' })),
    { url: 'https://example.com/a?b=c' },
  );
  const long = messages.encodeNavigate({ url: `https://example.com/${'a'.repeat(9000)}` });
  assert.throws(() => messages.decodeNavigate(long), /implausibly long/);
});

test('the empty messages accept only an empty payload', () => {
  assert.deepEqual(messages.decodeEmpty(messages.encodeEmpty()), {});
  assert.throws(() => messages.decodeEmpty(Buffer.from([0])), /no fields/);
});

test('TAP round-trips, including the signed scroll deltas', () => {
  const tap = { x: 120, y: 240, buttons: 1, clickCount: 2 };
  assert.deepEqual(messages.decodeTap(messages.encodeTap(tap)), tap);

  const scroll = { x: 1, y: 2, deltaX: -320, deltaY: 640 };
  assert.deepEqual(messages.decodeScroll(messages.encodeScroll(scroll)), scroll);
});

test('a scroll delta beyond an i16 is refused rather than wrapped', () => {
  assert.throws(() => messages.encodeScroll({ x: 0, y: 0, deltaX: 0, deltaY: 40000 }), /deltaY/);
});

test('RESIZE, KEY, TEXT and FIND round-trip', () => {
  const resize = { width: 720, height: 1280, devicePixelRatio: 3 };
  assert.deepEqual(messages.decodeResize(messages.encodeResize(resize)), resize);

  const key = { key: 'Enter', modifiers: 0, text: '' };
  assert.deepEqual(messages.decodeKey(messages.encodeKey(key)), key);

  assert.deepEqual(messages.decodeText(messages.encodeText({ text: 'ciao' })), { text: 'ciao' });
  assert.deepEqual(messages.decodeFind(messages.encodeFind({ text: 'news' })), { text: 'news' });
});

test('SETTINGS is a flag byte, and each flag is independent', () => {
  const combos = [
    { nightMode: false, desktopMode: false, blockTrackers: false },
    { nightMode: true, desktopMode: false, blockTrackers: false },
    { nightMode: false, desktopMode: true, blockTrackers: false },
    { nightMode: false, desktopMode: false, blockTrackers: true },
    { nightMode: true, desktopMode: true, blockTrackers: true },
  ];
  for (const settings of combos) {
    const encoded = messages.encodeSettings(settings);
    assert.equal(encoded.length, 1);
    assert.deepEqual(messages.decodeSettings(encoded), settings);
  }
});

test('PING and ACK are both a bare u32, and PONG reuses the ping layout', () => {
  assert.deepEqual(messages.decodeNonce(messages.encodeNonce(0x01020304)), { nonce: 0x01020304 });
  assert.deepEqual(messages.decodeAck(messages.encodeAck({ frameSeq: 7 })), { nonce: 7 });
});

test('TITLE, URL, LOAD_STATE, FIND_RESULT and AUDIO round-trip', () => {
  assert.deepEqual(messages.decodeTitle(messages.encodeTitle({ title: 'Example Domain' })), { title: 'Example Domain' });
  assert.deepEqual(messages.decodeUrl(messages.encodeUrl({ url: 'https://example.com/' })), { url: 'https://example.com/' });

  const load = { state: 2, detail: 'net::ERR_NAME_NOT_RESOLVED' };
  assert.deepEqual(messages.decodeLoadState(messages.encodeLoadState(load)), load);

  assert.deepEqual(messages.decodeFindResult(messages.encodeFindResult({ found: true, matches: 3 })), { found: true, matches: 3 });

  const audio = { playing: true, url: 'https://example/audio/1?t=2' };
  assert.deepEqual(messages.decodeAudio(messages.encodeAudio(audio)), audio);
});

test('a FRAME carries tiles with their rectangles and their bytes', () => {
  const tiles = [
    { x: 0, y: 0, width: 480, height: 800, data: Buffer.from('ffd8ffd9', 'hex') },
    { x: 480, y: 0, width: 240, height: 800, data: Buffer.from([1, 2, 3]) },
  ];
  const decoded = messages.decodeFramePayload(messages.encodeFrame({ tiles }));
  assert.equal(decoded.tiles.length, 2);
  assert.deepEqual(decoded.tiles[0].data, tiles[0].data);
  assert.deepEqual(
    { x: decoded.tiles[1].x, y: decoded.tiles[1].y, width: decoded.tiles[1].width, height: decoded.tiles[1].height },
    { x: 480, y: 0, width: 240, height: 800 },
  );
});

test('a FRAME with no tiles is refused', () => {
  assert.throws(() => messages.encodeFrame({ tiles: [] }), /at least one tile/);
});

test('a FRAME with more tiles than the limit is refused', () => {
  const tiles = Array.from({ length: messages.MAX_TILES_PER_FRAME + 1 }, () => ({
    x: 0, y: 0, width: 1, height: 1, data: Buffer.alloc(1),
  }));
  assert.throws(() => messages.encodeFrame({ tiles }), /too many tiles/);
});

test('a decoder refuses trailing bytes in every message that has a decoder', () => {
  const withTrailing = (buffer) => Buffer.concat([buffer, Buffer.from([0])]);
  const cases = [
    [messages.decodeHelloAck, messages.encodeHelloAckError({ code: 1 })],
    [messages.decodeNavigate, messages.encodeNavigate({ url: 'https://example.com/' })],
    [messages.decodeTap, messages.encodeTap({ x: 1, y: 2 })],
    [messages.decodeScroll, messages.encodeScroll({ x: 1, y: 2, deltaX: 0, deltaY: 0 })],
    [messages.decodeResize, messages.encodeResize({ width: 480, height: 800 })],
    [messages.decodeKey, messages.encodeKey({ key: 'a' })],
    [messages.decodeText, messages.encodeText({ text: 'a' })],
    [messages.decodeSettings, messages.encodeSettings({})],
    [messages.decodeNonce, messages.encodeNonce(1)],
    [messages.decodeTitle, messages.encodeTitle({ title: 'a' })],
    [messages.decodeLoadState, messages.encodeLoadState({ state: 0 })],
    [messages.decodeFindResult, messages.encodeFindResult({ found: false })],
    [messages.decodeAudio, messages.encodeAudio({ playing: false })],
  ];
  for (const [decoder, encoded] of cases) {
    assert.throws(() => decoder(withTrailing(encoded)), /trailing byte/, `${decoder.name} accepted a trailing byte`);
  }
});
