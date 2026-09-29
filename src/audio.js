// Audio, the part of this that is honestly the least finished.
//
// WHY IT IS HARD: a headless Chromium has no audio device. Nothing in Playwright
// exposes the audio the page is playing, so "the phone hears the sound" needs a
// virtual sink inside the container -- PulseAudio with a null sink -- plus
// something (ffmpeg) to read that sink and encode it, and the result arrives at
// this process as a byte stream on a FIFO. That wiring lives in the Dockerfile
// and in docs/DEPLOY.md, and it is the one part of this repository that cannot
// be verified by the test suite, because it needs a sound card that is not
// there.
//
// WHAT IS HERE, and is tested: the delivery half. A session that is told audio
// is available receives a URL carrying a session-scoped random ticket. The
// ticket is not the device token, so a log line, a proxy access log or a
// screenshot of the URL does not leak a credential that outlives the session --
// which is exactly what would happen if the token were put in a query string,
// and query strings are the most-logged string in existence.
//
// The endpoint streams MP3 to the phone, which plays it with MediaElement over
// ordinary Schannel TLS. That is deliberate: the custom TLS 1.3 stack in the
// client cannot feed MediaElement, and it does not need to. A stream from our own
// server, over a certificate the phone already trusts, is the smaller solution.

import crypto from 'node:crypto';
import fs from 'node:fs';

const TICKET_BYTES = 32;

export function mintTicket() {
  return crypto.randomBytes(TICKET_BYTES).toString('base64url');
}

export class AudioRegistry {
  constructor({ config, log, now = () => Date.now() }) {
    this.config = config;
    this.log = log;
    this.now = now;
    this.tickets = new Map();
  }

  /** Called when a session opens; mints a ticket only when audio is switched on. */
  attach(sessionId, session) {
    if (!this.config.audioEnabled) return null;
    const ticket = mintTicket();
    this.tickets.set(`${sessionId}:${ticket}`, this.now());
    session.audioTicket = ticket;
    session.audioUrl = `${this.config.publicUrl}/audio/${sessionId}?t=${ticket}`;
    return ticket;
  }

  detach(sessionId) {
    for (const key of [...this.tickets.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.tickets.delete(key);
    }
  }

  /** Constant-time ticket check, scoped to the session the URL names. */
  verify(sessionId, ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return false;
    const claimed = Buffer.from(ticket, 'utf8');
    let matched = false;
    for (const key of this.tickets.keys()) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      const known = Buffer.from(key.slice(sessionId.length + 1), 'utf8');
      if (known.length !== claimed.length) continue;
      if (crypto.timingSafeEqual(known, claimed)) matched = true;
    }
    return matched;
  }

  get activeTickets() {
    return this.tickets.size;
  }
}

/**
 * The HTTP handler for /audio/<sessionId>?t=<ticket>.
 *
 * Streams whatever the capture side is writing to the configured FIFO. Opened
 * per request and closed with the response, so a phone that stops listening
 * stops the read.
 */
export function createAudioHandler({ config, log, audioRegistry }) {
  return function handleAudio(req, res) {
    if (!config.audioEnabled) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('audio is not enabled on this server\n');
      return;
    }

    let parsed;
    try {
      parsed = new URL(req.url, config.publicUrl);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request\n');
      return;
    }

    const match = parsed.pathname.match(/^\/audio\/([A-Za-z0-9-]{1,32})$/);
    const sessionId = match ? match[1] : null;
    const ticket = parsed.searchParams.get('t');

    if (!sessionId || !ticket || !audioRegistry.verify(sessionId, ticket)) {
      log.warn(`audio request refused for ${sessionId ?? 'no session'}`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden\n');
      return;
    }

    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      // No Content-Length: the stream ends when the page stops making noise.
      connection: 'keep-alive',
    });

    const stream = fs.createReadStream(config.audioFifo);
    stream.on('error', (error) => {
      log.warn(`audio capture is not readable: ${error.message}`);
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
      res.end();
    });
    stream.pipe(res);
    res.on('close', () => stream.destroy());
  };
}
