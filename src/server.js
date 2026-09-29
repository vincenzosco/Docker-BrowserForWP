// The listener: sockets in, sessions out.
//
// Deliberately thin. Everything worth testing is in session.js; this file is the
// part that owns a socket, and it does four things: read bytes, hand complete
// frames to a session, enforce how many devices may be connected at once, and
// hang up on a session that has gone quiet.

import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import {
  ErrorCode,
  FrameDecoder,
  ProtocolError,
  Type,
  encodeHeader,
} from '../protocol/index.js';
import { encodeError } from '../protocol/messages.js';
import { Session } from './session.js';

const SWEEP_INTERVAL_MS = 30000;

export function createRenderServer({ config, store, browserFactory, log, audioRegistry }) {
  const sessions = new Map();
  let listener = null;
  let sweepTimer = null;

  function activeSessions() {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.state !== 'closed') count += 1;
    }
    return count;
  }

  function refuse(socket, code, message) {
    // Plaintext by construction: a refused connection has no session and
    // therefore no key. The client reads this before it has sent HELLO only in
    // the BUSY case, where it is about to hang up anyway.
    try {
      const payload = encodeError({ code, message });
      socket.write(Buffer.concat([
        encodeHeader({ type: Type.ERROR, seq: 0, length: payload.length }),
        payload,
      ]));
    } catch {
      // The socket may already be gone.
    }
  }

  function handleConnection(socket) {
    const sessionId = crypto.randomUUID().slice(0, 8);
    const remote = socket.remoteAddress ?? 'unknown';

    if (activeSessions() >= config.maxSessions) {
      log.warn(`${sessionId} refused: ${activeSessions()}/${config.maxSessions} sessions are open`);
      refuse(socket, ErrorCode.BUSY, 'this server is at its session limit');
      socket.destroy();
      return;
    }

    const connectionLog = log.child(`${sessionId}`);
    const decoder = new FrameDecoder({ maxPayload: config.maxFrameBytes + 4096 });

    // Declared before the handlers that chain onto it: a `data` event cannot
    // arrive before this line has run, but ordering the two this way removes
    // the need to know that.
    let queue = Promise.resolve();

    const session = new Session({
      store,
      browserFactory,
      config,
      log: connectionLog,
      sessionId,
      send: (buffer) => {
        if (socket.destroyed) return;
        // Ordinal numbers are set here rather than awaited: backpressure is
        // handled by the frame acknowledgement, not by the socket queue, and
        // awaiting every write would make one slow reader stall the sweeper.
        socket.write(buffer);
      },
      // A refused device, a replayed frame and an idle timeout all have to hang
      // the socket up, and all three go through close(). end() rather than
      // destroy() so the refusal that was just written actually leaves.
      onClosed: () => {
        if (!socket.destroyed) socket.end();
      },
    });
    sessions.set(sessionId, session);
    if (audioRegistry) audioRegistry.attach(sessionId, session);

    connectionLog.info(`connection from ${remote}`);

    socket.on('data', (chunk) => {
      /* eslint-disable no-await-in-loop -- writes are chained below, not awaited here */
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        connectionLog.warn(`closing a stream that is not this protocol: ${error.message}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        // Serialized on purpose: two NAVIGATE messages must reach Chromium in
        // the order they were sent, and the browser interface is not documented
        // as reentrant.
        queue = queue.then(() => session.onFrame(frame)).catch((error) => {
          connectionLog.error('session failed', error);
        });
      }
    });

    socket.on('error', (error) => {
      connectionLog.debug(`socket error: ${error.message}`);
    });

    socket.on('close', () => {
      queue = queue.then(() => session.close('the client closed the connection'))
        .catch(() => {})
        .finally(() => {
          sessions.delete(sessionId);
          if (audioRegistry) audioRegistry.detach(sessionId);
        });
    });
  }

  function start() {
    if (listener) return listener;

    if (config.allowInsecure) {
      log.warn('BFWP_ALLOW_INSECURE is set: this listener speaks plain TCP and must not face the internet');
      listener = net.createServer(handleConnection);
    } else {
      const cert = fs.readFileSync(config.tlsCert);
      const key = fs.readFileSync(config.tlsKey);
      listener = tls.createServer(
        {
          cert,
          key,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          // The client implements TLS 1.3 itself and offers AES-128-GCM and
          // ChaCha20-Poly1305. Restricting to those two keeps a negotiating
          // middlebox from steering the handshake somewhere the client cannot
          // follow, which would look like "the server is down".
          ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256',
        },
        handleConnection,
      );
    }

    listener.on('error', (error) => log.error('listener error', error));
    listener.listen(config.port, config.host, () => {
      log.info(`listening on ${config.host}:${config.port} `
        + `(${config.allowInsecure ? 'plain TCP' : 'TLS 1.3 only'}), `
        + `${config.maxSessions} session(s) allowed`);
    });

    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of sessions) {
        if (session.state === 'closed' || !session.isIdle(config.sessionIdleMs)) continue;
        log.info(`${sessionId} closed after ${Math.round((now - session.lastActivity) / 1000)}s idle`);
        session.close('idle timeout').catch(() => {});
        sessions.delete(sessionId);
        if (audioRegistry) audioRegistry.detach(sessionId);
      }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();

    return listener;
  }

  async function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const session of sessions.values()) {
      await session.close('the server is shutting down').catch(() => {});
    }
    sessions.clear();
    if (listener) {
      await new Promise((resolve) => listener.close(resolve));
      listener = null;
    }
    if (typeof browserFactory?.close === 'function') {
      await browserFactory.close().catch(() => {});
    }
  }

  return {
    start,
    stop,
    get sessionCount() {
      return sessions.size;
    },
    get activeSessionCount() {
      return activeSessions();
    },
    sessions,
  };
}

export { ProtocolError };
