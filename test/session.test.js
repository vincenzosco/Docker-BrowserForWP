import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, HEADER_SIZE, Type, decodeFrame } from '../protocol/index.js';
import * as messages from '../protocol/messages.js';
import { Opener, Sealer, deriveKeys } from '../protocol/seal.js';
import { DeviceStore } from '../src/devices.js';
import { Session, sanitizeUrl } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';

const SESSION_SALT = Buffer.alloc(32, 0x5a);

// ── The fake browser ────────────────────────────────────────────────────────
// Small on purpose: it records what it was told and can push an event back, and
// that is enough to exercise every branch of the session without Chromium.
function makeBrowserFactory() {
  const calls = [];
  let emit = null;
  let browser = null;

  const factory = {
    calls,
    get browser() {
      return browser;
    },
    emit(event) {
      assert.ok(emit, 'no browser session was started, so there is nobody to emit to');
      emit(event);
    },
    async create({ deviceId, viewport, onEvent }) {
      emit = onEvent;
      browser = {
        deviceId,
        viewport,
        framesStarted: 0,
        framesStopped: 0,
        closed: false,
        async navigate(url) { calls.push(['navigate', url]); },
        async back() { calls.push(['back']); },
        async forward() { calls.push(['forward']); },
        async reload() { calls.push(['reload']); },
        async stop() { calls.push(['stop']); },
        async tap(tap) { calls.push(['tap', tap]); },
        async scroll(scroll) { calls.push(['scroll', scroll]); },
        async key(key) { calls.push(['key', key]); },
        async text(text) { calls.push(['text', text]); },
        async resize(size) { calls.push(['resize', size]); },
        async applySettings(settings) { calls.push(['applySettings', settings]); },
        async find(query) { calls.push(['find', query]); return { found: true, matches: 2 }; },
        async startFrames() { this.framesStarted += 1; },
        async stopFrames() { this.framesStopped += 1; },
        async close() { this.closed = true; },
      };
      return browser;
    },
    async close() {},
  };
  return factory;
}

// ── The client half, built from the same primitives the phone will use ──────
function makeClient(tokenText) {
  const token = Buffer.from(tokenText, 'utf8');
  let sealer = null;
  let opener = null;
  return {
    adopt(sessionSalt) {
      const keys = deriveKeys(token, sessionSalt);
      sealer = new Sealer(keys.c2s);
      opener = new Opener(keys.s2c);
    },
    /** A full sealed frame, and the payload it contains, ready to hand the session. */
    sealed(type, payload) {
      const frame = sealer.seal(type, payload);
      return { frame, part: { type, seq: frame.readUInt32BE(8), payload: frame.subarray(HEADER_SIZE) } };
    },
    open(frame) {
      return opener.open(frame);
    },
    get sealedFramesSent() {
      return sealer ? sealer.seq : 0;
    },
  };
}

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-session-'));
  const store = new DeviceStore(path.join(directory, 'devices.json'));
  store.load();
  const { device, token } = store.add('test phone');

  const out = [];
  const factory = makeBrowserFactory();
  const session = new Session({
    store,
    browserFactory: factory,
    config: loadConfig({}),
    send: (buffer) => out.push(buffer),
    log: createLog({ level: 'silent' }),
    sessionId: 'test',
    saltFactory: () => SESSION_SALT,
  });

  return { store, device, token, out, factory, session };
}

function helloPayload({ deviceId, token, width = 480, height = 800, dpr = 2, version = 1 }) {
  return messages.encodeHello({
    protocolVersion: version,
    deviceId,
    token,
    viewportWidth: width,
    viewportHeight: height,
    devicePixelRatio: dpr,
    clientName: 'BrowserForWP/0.1 (WindowsPhone8.1)',
  });
}

async function openSession(ctx) {
  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: ctx.device.deviceId, token: ctx.token }),
  });
}

/** Everything after the handshake answer, opened in order with the client's key. */
function readSealed(ctx, client) {
  return ctx.out.slice(1).map((frame) => client.open(frame));
}

// ── The handshake ───────────────────────────────────────────────────────────

test('a valid device gets a plaintext HELLO_ACK carrying the session salt', async () => {
  const ctx = harness();
  await openSession(ctx);

  assert.equal(ctx.session.state, 'open');
  assert.equal(ctx.out.length, 1, 'the handshake answer is the only thing sent so far');

  // Readable WITHOUT a key, which is the point: the client needs this message in
  // order to derive one.
  const decoded = decodeFrame(ctx.out[0]);
  assert.equal(decoded.type, Type.HELLO_ACK);

  const ack = messages.decodeHelloAck(decoded.payload);
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.sessionSalt, SESSION_SALT);
  assert.equal(ack.serverName, 'BrowserForWP render server');
  assert.equal(messages.hasAudio(ack), false, 'audio is off by default');
  assert.equal(ack.audioUrl, '');
});

test('the session starts a browser and asks for the first frame', async () => {
  const ctx = harness();
  await openSession(ctx);

  assert.ok(ctx.factory.browser, 'a browser session should exist');
  assert.equal(ctx.factory.browser.deviceId, ctx.device.deviceId);
  assert.equal(ctx.factory.browser.framesStarted, 1);
  assert.deepEqual(
    ctx.factory.calls.filter((call) => call[0] === 'applySettings').length,
    1,
    'the initial settings should be applied once',
  );
});

test('the viewport the client declares is the viewport the browser gets', async () => {
  const ctx = harness();
  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: ctx.device.deviceId, token: ctx.token, width: 720, height: 1280, dpr: 3 }),
  });
  assert.deepEqual(ctx.factory.browser.viewport, { width: 720, height: 1280, dpr: 3 });
});

test('a wrong token is refused with BAD_TOKEN and no salt', async () => {
  const ctx = harness();
  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: ctx.device.deviceId, token: 'not-the-token-not-the-token' }),
  });

  const ack = messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, ErrorCode.BAD_TOKEN);
  assert.equal(ack.sessionSalt, undefined);
  assert.equal(ctx.session.state, 'closed');
  assert.equal(ctx.factory.browser, null, 'no browser should be started for a refused device');
});

test('an unregistered device id is refused with UNKNOWN_DEVICE', async () => {
  const ctx = harness();
  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: '11111111-2222-3333-4444-555555555555', token: ctx.token }),
  });

  const ack = messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, ErrorCode.UNKNOWN_DEVICE);
});

test('a disabled device is refused even with the token it was issued', async () => {
  const ctx = harness();
  ctx.store.setDisabled(ctx.device.deviceId, true);
  await openSession(ctx);

  const ack = messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, ErrorCode.DISABLED_DEVICE);
  assert.equal(ctx.session.state, 'closed');
});

test('a different protocol version is refused with both numbers named', async () => {
  const ctx = harness();
  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: ctx.device.deviceId, token: ctx.token, version: 7 }),
  });

  const ack = messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, ErrorCode.BAD_VERSION);
  assert.match(ack.message, /version 1.*offered 7/);
});

test('a first frame that is not HELLO is refused and closes the session', async () => {
  const ctx = harness();
  await ctx.session.onFrame({ type: Type.NAVIGATE, seq: 0, payload: Buffer.alloc(0) });

  const decoded = decodeFrame(ctx.out[0]);
  assert.equal(decoded.type, Type.ERROR);
  assert.equal(messages.decodeError(decoded.payload).code, ErrorCode.PROTOCOL);
  assert.equal(ctx.session.state, 'closed');
});

test('a malformed HELLO is refused without starting anything', async () => {
  const ctx = harness();
  await ctx.session.onFrame({ type: Type.HELLO, seq: 0, payload: Buffer.from([1, 2, 3]) });

  const decoded = decodeFrame(ctx.out[0]);
  assert.equal(decoded.type, Type.ERROR);
  assert.equal(ctx.session.state, 'closed');
  assert.equal(ctx.factory.browser, null);
});

// ── The sealed session ──────────────────────────────────────────────────────

test('after the handshake the client speaks sealed, and a PING comes back sealed', async () => {
  const ctx = harness();
  await openSession(ctx);

  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  const ping = client.sealed(Type.PING, messages.encodeNonce(42));
  await ctx.session.onFrame(ping.part);

  const pong = client.open(ctx.out.at(-1));
  assert.equal(pong.type, Type.PONG);
  assert.deepEqual(messages.decodeNonce(pong.payload), { nonce: 42 });
  assert.equal(ctx.session.channel.framesReceived, 1);
});

test('a HANDSHAKE-type frame after the handshake closes the session', async () => {
  // The downgrade guard, and it is about the handshake types specifically.
  // Anyone able to rewrite the stream could otherwise send a plaintext
  // HELLO_ACK-shaped frame and hope to be answered in the clear.
  const ctx = harness();
  await openSession(ctx);

  await ctx.session.onFrame({ type: Type.HELLO_ACK, seq: 0, payload: Buffer.alloc(8) });

  assert.equal(ctx.session.state, 'closed');
  assert.match(ctx.session.closedReason, /plaintext HELLO_ACK after the handshake/);
});

test('a sealed-TYPE frame sent in the clear is refused by the tag check', async () => {
  // The other half of the same guard: a type that must be sealed simply cannot
  // be, so the AEAD refuses it. Nothing needs to detect "unsealed" separately --
  // an unsealed frame of a sealed type is a frame that fails to authenticate.
  const ctx = harness();
  await openSession(ctx);

  await ctx.session.onFrame({ type: Type.PING, seq: 1, payload: messages.encodeNonce(1) });
  assert.equal(ctx.session.state, 'closed');
  assert.match(ctx.session.closedReason, /shorter than its own tag/);
});

test('a replayed sealed frame closes the session', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  const first = client.sealed(Type.PING, messages.encodeNonce(1));
  await ctx.session.onFrame(first.part);
  assert.equal(ctx.session.state, 'open');

  await ctx.session.onFrame(first.part);
  assert.equal(ctx.session.state, 'closed');
  assert.match(ctx.session.closedReason, /replayed or reordered/);
});

test('a frame sealed with the wrong key closes the session', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient('a different token of a different length');
  client.adopt(SESSION_SALT);

  const wrong = client.sealed(Type.PING, messages.encodeNonce(1));
  await ctx.session.onFrame(wrong.part);
  assert.equal(ctx.session.state, 'closed');
  assert.match(ctx.session.closedReason, /failed authentication/);
});

// ── What reaches the browser ────────────────────────────────────────────────

test('NAVIGATE reaches the browser with a normalised url', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  await ctx.session.onFrame(client.sealed(Type.NAVIGATE, messages.encodeNavigate({ url: 'example.com' })).part);

  assert.deepEqual(ctx.factory.calls.filter((call) => call[0] === 'navigate'), [
    ['navigate', 'https://example.com/'],
  ]);
});

test('a file: url closes the session and never reaches the browser', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  await ctx.session.onFrame(
    client.sealed(Type.NAVIGATE, messages.encodeNavigate({ url: 'file:///C:/Users/secret.txt' })).part,
  );

  assert.equal(ctx.session.state, 'closed');
  assert.deepEqual(ctx.factory.calls.filter((call) => call[0] === 'navigate'), []);
});

test('tap, scroll, key, text, resize and find all reach the browser', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  const send = async (type, payload) => ctx.session.onFrame(client.sealed(type, payload).part);
  await send(Type.TAP, messages.encodeTap({ x: 10, y: 20 }));
  await send(Type.SCROLL, messages.encodeScroll({ x: 1, y: 2, deltaX: 0, deltaY: -100 }));
  await send(Type.KEY, messages.encodeKey({ key: 'Enter' }));
  await send(Type.TEXT, messages.encodeText({ text: 'hi' }));
  await send(Type.RESIZE, messages.encodeResize({ width: 360, height: 640, devicePixelRatio: 2 }));
  await send(Type.FIND, messages.encodeFind({ text: 'news' }));

  const kinds = ctx.factory.calls.map((call) => call[0]);
  assert.deepEqual(
    kinds.filter((kind) => kind !== 'applySettings'),
    ['tap', 'scroll', 'key', 'text', 'resize', 'find'],
  );
  assert.deepEqual(ctx.factory.calls.find((call) => call[0] === 'resize')[1], {
    width: 360,
    height: 640,
    dpr: 2,
  });

  const findResult = client.open(ctx.out.at(-1));
  assert.equal(findResult.type, Type.FIND_RESULT);
  assert.deepEqual(messages.decodeFindResult(findResult.payload), { found: true, matches: 2 });
});

test('a message type a client may not send closes the session', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  // TITLE is server-to-client only.
  await ctx.session.onFrame(client.sealed(Type.TITLE, messages.encodeTitle({ title: 'x' })).part);
  assert.equal(ctx.session.state, 'closed');
  assert.match(ctx.session.closedReason, /not accepted from a client/);
});

// ── Backpressure ────────────────────────────────────────────────────────────

test('only one frame is in flight, and the next one waits for the acknowledgement', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  ctx.factory.emit({ kind: 'frame', jpeg: Buffer.from('ffd8ffd9', 'hex'), width: 480, height: 800 });
  ctx.factory.emit({ kind: 'frame', jpeg: Buffer.from('ffd8ffda', 'hex'), width: 480, height: 800 });

  const frames = readSealed(ctx, client).filter((message) => message.type === Type.FRAME);
  assert.equal(frames.length, 1, 'the second frame must be dropped, not buffered');
  assert.equal(ctx.session.framesDropped, 1);
  assert.equal(ctx.factory.browser.framesStopped, 1, 'the screencast tap is stopped while a frame is unacknowledged');

  const inFlight = ctx.session.frameInFlight;
  assert.ok(Number.isInteger(inFlight));

  const ack = client.sealed(Type.ACK, messages.encodeAck({ frameSeq: inFlight }));
  await ctx.session.onFrame(ack.part);

  assert.equal(ctx.session.frameInFlight, null);
  assert.equal(ctx.factory.browser.framesStarted, 2, 'the tap restarts after the acknowledgement');
});

test('an acknowledgement for a frame that was never sent does not restart the tap', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  const startedBefore = ctx.factory.browser.framesStarted;
  await ctx.session.onFrame(client.sealed(Type.ACK, messages.encodeAck({ frameSeq: 9999 })).part);
  assert.equal(ctx.factory.browser.framesStarted, startedBefore);
});

// ── Events out ──────────────────────────────────────────────────────────────

test('title, url and load state reach the client sealed, in order', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  ctx.factory.emit({ kind: 'url', url: 'https://example.com/' });
  ctx.factory.emit({ kind: 'load', state: 1, detail: '' });
  ctx.factory.emit({ kind: 'title', title: 'Example Domain' });

  const received = readSealed(ctx, client);
  assert.deepEqual(received.map((message) => message.type), [Type.URL, Type.LOAD_STATE, Type.TITLE]);
  assert.deepEqual(messages.decodeUrl(received[0].payload), { url: 'https://example.com/' });
  assert.deepEqual(messages.decodeLoadState(received[1].payload), { state: 1, detail: '' });
  assert.deepEqual(messages.decodeTitle(received[2].payload), { title: 'Example Domain' });
});

test('a FRAME message carries the jpeg the browser produced', async () => {
  const ctx = harness();
  await openSession(ctx);
  const client = makeClient(ctx.token);
  client.adopt(messages.decodeHelloAck(decodeFrame(ctx.out[0]).payload).sessionSalt);

  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
  ctx.factory.emit({ kind: 'frame', jpeg, width: 480, height: 800 });

  const frame = readSealed(ctx, client).find((message) => message.type === Type.FRAME);
  assert.ok(frame, 'a FRAME message should have been sent');
  const decoded = messages.decodeFramePayload(frame.payload);
  assert.equal(decoded.tiles.length, 1);
  assert.deepEqual(decoded.tiles[0].data, jpeg);
  assert.equal(decoded.tiles[0].width, 480);
  assert.equal(decoded.tiles[0].height, 800);
});

// ── Closing ─────────────────────────────────────────────────────────────────

test('closing the session closes the browser exactly once', async () => {
  const ctx = harness();
  await openSession(ctx);

  await ctx.session.close('test is done');
  await ctx.session.close('and again');
  assert.equal(ctx.factory.browser.closed, true);
  assert.equal(ctx.session.state, 'closed');
  assert.equal(ctx.session.closedReason, 'test is done');
});

test('closing the session tells the transport, once, and last', async () => {
  // Without this the server holds a refused device's socket open until the idle
  // sweep -- a slot a stranger can take with no credential at all.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-session-'));
  const store = new DeviceStore(path.join(directory, 'devices.json'));
  store.load();
  const { device, token } = store.add('test phone');

  const order = [];
  const factory = makeBrowserFactory();
  const session = new Session({
    store,
    browserFactory: factory,
    config: loadConfig({}),
    send: () => order.push('write'),
    log: createLog({ level: 'silent' }),
    sessionId: 'closing',
    saltFactory: () => SESSION_SALT,
    onClosed: (reason) => order.push(`closed:${reason}`),
  });

  await session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: device.deviceId, token }),
  });
  order.length = 0;

  await session.close('test is done');
  await session.close('and again');

  assert.deepEqual(order, ['closed:test is done'], 'the transport is told once, and only once');
});

test('a refused device still tells the transport to hang up', async () => {
  const ctx = harness();
  let closedWith = null;
  ctx.session.onClosed = (reason) => {
    closedWith = reason;
  };

  await ctx.session.onFrame({
    type: Type.HELLO,
    seq: 0,
    payload: helloPayload({ deviceId: ctx.device.deviceId, token: 'the wrong token entirely' }),
  });

  assert.equal(closedWith, 'authentication refused');
});

test('a transport that throws while closing does not take the session down with it', async () => {
  const ctx = harness();
  await openSession(ctx);
  ctx.session.onClosed = () => {
    throw new Error('the socket is already gone');
  };
  await assert.doesNotReject(() => ctx.session.close('test'));
  assert.equal(ctx.session.state, 'closed');
});

test('a frame after the session closed is ignored, not dispatched', async () => {
  const ctx = harness();
  await openSession(ctx);
  await ctx.session.close('done');
  const before = ctx.factory.calls.length;

  await ctx.session.onFrame({ type: Type.NAVIGATE, seq: 1, payload: Buffer.alloc(0) });
  assert.equal(ctx.factory.calls.length, before);
});

test('an idle session reports itself as idle', async () => {
  let clock = 1000;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-session-'));
  const store = new DeviceStore(path.join(directory, 'devices.json'));
  store.load();
  const session = new Session({
    store,
    browserFactory: makeBrowserFactory(),
    config: loadConfig({}),
    send: () => {},
    log: createLog({ level: 'silent' }),
    sessionId: 'idle',
    now: () => clock,
  });

  assert.equal(session.isIdle(5000), false);
  clock += 6000;
  assert.equal(session.isIdle(5000), true);
});

// ── The url rule, on its own ────────────────────────────────────────────────

test('sanitizeUrl accepts what a person types and normalises it', () => {
  assert.equal(sanitizeUrl('example.com'), 'https://example.com/');
  assert.equal(sanitizeUrl('  example.com/a/b?c=d  '), 'https://example.com/a/b?c=d');
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com/');
  assert.equal(sanitizeUrl('https://example.com:8443/x'), 'https://example.com:8443/x');
});

test('sanitizeUrl refuses every scheme that is not the web', () => {
  for (const url of [
    'file:///C:/Windows/System32/config/SAM',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'chrome://settings',
    'ftp://example.com/x',
  ]) {
    assert.throws(() => sanitizeUrl(url), /refusing a|not a url/);
  }
});

test('sanitizeUrl refuses an empty or absurdly long url', () => {
  assert.throws(() => sanitizeUrl(''), /empty url/);
  assert.throws(() => sanitizeUrl('   '), /empty url/);
  assert.throws(() => sanitizeUrl(`https://example.com/${'a'.repeat(9000)}`), /implausibly long/);
});

test('sanitizeUrl does not let a url smuggle a second one', () => {
  assert.equal(sanitizeUrl('example.com/?next=file:///etc/passwd'), 'https://example.com/?next=file:///etc/passwd');
});
