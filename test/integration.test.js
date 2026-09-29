// Integration: real sockets, real TLS, the actual listener.
//
// Everything else in test/ exercises a pure function. src/server.js is the part
// that owns a socket and the TLS configuration, and a mistake there is invisible
// to every unit test -- a wrong cipher string makes `tls.createServer` throw at
// startup, and a wrong `minVersion` makes a real client fail a handshake it
// cannot even report clearly. Both are pinned here.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorCode,
  FrameDecoder,
  Type,
  decodeFrame,
} from '../protocol/index.js';
import * as messages from '../protocol/messages.js';
import { DeviceStore } from '../src/devices.js';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { createRenderServer } from '../src/server.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(predicate, { timeout = 5000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function makeBrowserFactory() {
  let browser = null;
  return {
    get browser() {
      return browser;
    },
    async create() {
      browser = {
        framesStarted: 0,
        framesStopped: 0,
        closed: false,
        async navigate() {},
        async back() {},
        async forward() {},
        async reload() {},
        async stop() {},
        async tap() {},
        async scroll() {},
        async key() {},
        async text() {},
        async resize() {},
        async applySettings() {},
        async find() {
          return { found: false, matches: 0 };
        },
        async startFrames() {
          this.framesStarted += 1;
        },
        async stopFrames() {
          this.framesStopped += 1;
        },
        async close() {
          this.closed = true;
        },
      };
      return browser;
    },
    async close() {},
  };
}

function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-int-'));
  const store = new DeviceStore(path.join(directory, 'devices.json'));
  store.load();
  const { device, token } = store.add('integration phone');
  return { store, device, token, directory };
}

/** A connected socket plus the frames it has received, decoded as they arrive. */
function connect(port, { secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, maxVersion: 'TLSv1.3' })
      : net.connect({ port, host: '127.0.0.1' });

    const decoder = new FrameDecoder();
    const frames = [];
    let closed = false;

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) frames.push(frame);
    });
    socket.on('close', () => {
      closed = true;
    });
    socket.on('error', () => {
      closed = true;
    });

    const ready = secure ? 'secureConnect' : 'connect';
    socket.once(ready, () => {
      resolve({
        socket,
        frames,
        get closed() {
          return closed;
        },
        send: (buffer) => socket.write(buffer),
        sendFrame: (type, seq, payload) => socket.write(
          Buffer.concat([
            require_header(type, seq, payload.length),
            payload,
          ]),
        ),
        close: () => socket.destroy(),
      });
    });
    socket.once('error', reject);
  });
}

// A local copy of encodeHeader, so this file proves the WIRE rather than
// re-using the function it is testing.
function require_header(type, seq, length) {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(0xb752, 0);
  header.writeUInt8(1, 2);
  header.writeUInt8(type, 3);
  header.writeUInt32BE(length, 4);
  header.writeUInt32BE(seq, 8);
  header.writeUInt32BE(0, 12);
  return header;
}

function hello(deviceId, token) {
  return messages.encodeHello({
    protocolVersion: 1,
    deviceId,
    token,
    viewportWidth: 480,
    viewportHeight: 800,
    devicePixelRatio: 2,
    clientName: 'BrowserForWP/0.1 (WindowsPhone8.1)',
  });
}

async function withServer(overrides, body) {
  const port = await freePort();
  const { store, device, token } = makeStore();
  const config = loadConfig({
    BFWP_HOST: '127.0.0.1',
    BFWP_PORT: String(port),
    BFWP_DEVICES_FILE: path.join(os.tmpdir(), 'bfwp-int-unused.json'),
    BFWP_PORT_UNUSED: '',
    ...overrides,
  });
  const log = createLog({ level: 'silent' });
  const factory = makeBrowserFactory();
  const server = createRenderServer({ config, store, browserFactory: factory, log });
  server.start();
  try {
    await body({ port, store, device, token, config, factory, server });
  } finally {
    await server.stop();
  }
}

// ── The plain listener ──────────────────────────────────────────────────────

test('a real socket handshake produces a HELLO_ACK', async () => {
  await withServer({ BFWP_ALLOW_INSECURE: '1' }, async ({ port, device, token }) => {
    const client = await connect(port);
    try {
      client.sendFrame(Type.HELLO, 0, hello(device.deviceId, token));
      assert.ok(await waitFor(() => client.frames.length > 0), 'no answer arrived');

      const decoded = decodeFrame(Buffer.concat([
        require_header(client.frames[0].type, client.frames[0].seq, client.frames[0].payload.length),
        client.frames[0].payload,
      ]));
      assert.equal(decoded.type, Type.HELLO_ACK);

      const ack = messages.decodeHelloAck(decoded.payload);
      assert.equal(ack.ok, true);
      assert.equal(ack.sessionSalt.length, 32);
    } finally {
      client.close();
    }
  });
});

test('a device the registry does not know is refused over a real socket', async () => {
  await withServer({ BFWP_ALLOW_INSECURE: '1' }, async ({ port, token }) => {
    const client = await connect(port);
    try {
      client.sendFrame(Type.HELLO, 0, hello('99999999-9999-9999-9999-999999999999', token));
      assert.ok(await waitFor(() => client.frames.length > 0));

      const ack = messages.decodeHelloAck(client.frames[0].payload);
      assert.equal(ack.ok, false);
      assert.equal(ack.code, ErrorCode.UNKNOWN_DEVICE);
      assert.ok(await waitFor(() => client.closed), 'a refused connection should be closed');
    } finally {
      client.close();
    }
  });
});

test('the server is at its session limit and says BUSY', async () => {
  await withServer({ BFWP_ALLOW_INSECURE: '1', BFWP_MAX_SESSIONS: '1' }, async ({ port }) => {
    const first = await connect(port);
    // No HELLO: the session exists from the moment the socket is accepted, which
    // is what makes the limit a limit rather than a formality.
    assert.ok(await waitFor(() => true));

    const second = await connect(port);
    try {
      assert.ok(await waitFor(() => second.frames.length > 0), 'the second connection got no answer');
      const error = messages.decodeError(second.frames[0].payload);
      assert.equal(second.frames[0].type, Type.ERROR);
      assert.equal(error.code, ErrorCode.BUSY);
    } finally {
      first.close();
      second.close();
    }
  });
});

test('a stream that is not this protocol is disconnected, not parsed', async () => {
  await withServer({ BFWP_ALLOW_INSECURE: '1' }, async ({ port }) => {
    const client = await connect(port);
    try {
      client.send(Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'));
      assert.ok(await waitFor(() => client.closed), 'a foreign stream should be hung up on');
    } finally {
      client.close();
    }
  });
});

// ── The TLS listener ────────────────────────────────────────────────────────

function makeSelfSigned() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-tls-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key, cert };
}

test('the TLS listener is TLS 1.3 only and completes a handshake', async (t) => {
  // This is the assertion that catches a bad cipher string: Node validates it
  // when the server is created, so a typo means the server never listens at all.
  let certs;
  try {
    certs = makeSelfSigned();
  } catch {
    t.skip('openssl is not available to make a throwaway certificate');
    return;
  }

  await withServer(
    { BFWP_TLS_CERT: certs.cert, BFWP_TLS_KEY: certs.key },
    async ({ port, device, token }) => {
      const client = await connect(port, { secure: true });
      try {
        assert.equal(client.socket.getProtocol(), 'TLSv1.3', 'the render channel must be TLS 1.3');

        client.sendFrame(Type.HELLO, 0, hello(device.deviceId, token));
        assert.ok(await waitFor(() => client.frames.length > 0), 'no answer arrived over TLS');

        const ack = messages.decodeHelloAck(client.frames[0].payload);
        assert.equal(ack.ok, true);
      } finally {
        client.close();
      }
    },
  );
});

test('the TLS listener refuses to speak TLS 1.2', async (t) => {
  let certs;
  try {
    certs = makeSelfSigned();
  } catch {
    t.skip('openssl is not available to make a throwaway certificate');
    return;
  }

  await withServer(
    { BFWP_TLS_CERT: certs.cert, BFWP_TLS_KEY: certs.key },
    async ({ port }) => {
      // The client on the phone implements TLS 1.3 itself and offers no earlier
      // version, so a listener that also accepted 1.2 would be inviting a
      // downgrade that the client cannot even see.
      const failed = await new Promise((resolve) => {
        const socket = tls.connect({
          port,
          host: '127.0.0.1',
          rejectUnauthorized: false,
          maxVersion: 'TLSv1.2',
          minVersion: 'TLSv1.2',
        });
        socket.once('secureConnect', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(true);
        });
      });
      assert.equal(failed, true, 'a TLS 1.2 handshake should not succeed');
    },
  );
});
