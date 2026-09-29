#!/usr/bin/env node
// The smoke test: the first thing to run against a deployment that is supposed
// to be up.
//
// WHY THIS EXISTS. Everything else in this repository is tested against a fake or
// against itself. `npm test` starts its own server on a loopback port, and the
// Chromium paths are covered by nothing at all -- deliberately, because they need
// a browser. So until a deployment is exercised end to end (TLS, handshake,
// sealing, a real page drawn by a real Chromium, a tap that reaches it and the
// answer that comes back), "it works" is a claim about the unit tests.
//
// WHAT IT ANSWERS, in order. It exits non-zero on the first check that fails:
//
//   1. does TLS 1.3 complete, and does HELLO come back OK
//   2. does a sealed NAVIGATE produce a FRAME, and is that frame a JPEG
//   3. does the ACK release the next frame (flow control stalling is exactly what
//      a "the page looks frozen" report describes, and it is silent)
//   4. on a page whose layout is known: does a tap on a text field report an
//      editable focus, does Tab move that answer with the focus, and does an
//      unchanged answer stay off the wire
//
// The FOCUS checks need a page whose layout is known, because a tap is a pair of
// coordinates and a public homepage is a guess. Pass --focus-url, and serve this
// (docs/DEPLOY.md has it):
//
//   <input>  at left 20, top 20, 200x40   ->  a tap at (100,40)  must say 1
//   <button> at left 20, top 80, 200x40   ->  a tap at (100,100) must say 0
//
// Without --focus-url those checks report SKIPPED, never passed.
//
// USAGE
//   node bin/bfwp-smoke.js --device <id> --token <token> \
//        [--host 127.0.0.1] [--port 8443] [--url https://example.com/] \
//        [--focus-url http://10.128.0.3:8080/] [--verify] [--timeout 20000]
//
// `--verify` turns certificate validation ON. It is off by default, and the reason
// is not convenience: the phone is the only client that can be tested against a
// real CA certificate, so a server behind a self-signed one is a legitimate
// intermediate state that this tool has to be able to diagnose rather than refuse
// to speak to.

import process from 'node:process';
import tls from 'node:tls';
import { FrameDecoder, HEADER_SIZE, MAGIC, VERSION, Type, describeType, encodeFrame, isSealed } from '../protocol/index.js';
import * as messages from '../protocol/messages.js';
import { Opener, Sealer, deriveKeys } from '../protocol/seal.js';

const USAGE = `bfwp-smoke — does this render server actually work?

  node bin/bfwp-smoke.js --device <id> --token <token> [options]

  --host <name>       server to dial (default 127.0.0.1)
  --port <n>          render port (default 8443)
  --device <id>       device id, from bin/bfwp-device.js add
  --token <token>     its token, shown once when it was created
  --url <url>         the page to navigate to (default https://example.com/)
  --focus-url <url>   a page whose layout matches the two boxes in this file's
                      header; without it the FOCUS checks report SKIPPED
  --verify            validate the certificate chain and name (off by default:
                      the phone validates, this tool has to be able to diagnose)
  --timeout <ms>      per-expectation timeout (default 20000)
`;

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 8443,
    device: '',
    token: '',
    url: 'https://example.com/',
    focusUrl: '',
    verify: false,
    timeout: 20000,
  };
  const names = {
    '--host': 'host',
    '--port': 'port',
    '--device': 'device',
    '--token': 'token',
    '--url': 'url',
    '--focus-url': 'focusUrl',
    '--timeout': 'timeout',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--verify') {
      args.verify = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      args.help = true;
      continue;
    }
    const key = names[flag];
    if (!key) {
      console.error(`unknown argument ${flag}; try --help`);
      process.exit(2);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      console.error(`${flag} needs a value`);
      process.exit(2);
    }
    index += 1;
    if (key === 'port' || key === 'timeout') {
      const number = Number.parseInt(value, 10);
      if (!Number.isInteger(number) || number <= 0) {
        console.error(`${flag} must be a positive integer`);
        process.exit(2);
      }
      args[key] = number;
    } else {
      args[key] = value;
    }
  }
  return args;
}

/**
 * A handshake frame: the header with sequence 0, and no sealing.
 *
 * Written here rather than through `encodeFrame` because that helper is the
 * SEALED framing path in spirit -- the sealer is what owns the counter, and
 * using it before there is a key would suggest a key existed.
 */
function plainFrame(type, payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt8(VERSION, 2);
  header.writeUInt8(type, 3);
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(0, 12);
  return Buffer.concat([header, payload]);
}

// ── One connection, as a phone would hold it ────────────────────────────────

class Connection {
  constructor(socket, { timeoutMs }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.opener = null;
    this.sealer = null;
    this.decoder = new FrameDecoder();
    this.log = [];
    this.waiters = new Set();
    this.closedReason = null;
    // False until the flow-control check is done: acknowledging everything
    // immediately would make "the ACK releases the next frame" untestable, since
    // the ack it is testing would already have been sent by this class.
    this.autoAck = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._failAll('the server closed the connection'));
    socket.on('error', (error) => this._failAll(`the socket failed: ${error.message}`));
  }

  /** The two keys, once HELLO_ACK has supplied the salt. */
  adopt(ack, token) {
    const keys = deriveKeys(Buffer.from(token, 'utf8'), ack.sessionSalt);
    this.opener = new Opener(keys.s2c);
    this.sealer = new Sealer(keys.c2s);
  }

  send(type, payload) {
    if (!this.sealer) throw new Error('cannot send a sealed frame before the keys exist');
    this.socket.write(this.sealer.seal(type, payload));
  }

  /** Every message of a type, in order, decoded through `decode`. */
  seen(type, decode) {
    return this.log.filter((message) => message.type === type).map((message) => decode(message.payload));
  }

  /** The log length now: pass it as `from` to look only at what follows. */
  mark() {
    return this.log.length;
  }

  /**
   * Waits for a message that satisfies `predicate`, considering only messages from
   * `from` onwards. Looking from a mark and not from the beginning is what makes
   * "did THIS command produce an answer" answerable at all.
   */
  waitFor(description, predicate, { timeoutMs = this.timeoutMs, from = 0 } = {}) {
    const found = this._scan(predicate, from);
    if (found) return Promise.resolve(found);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, from, description, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${description} did not happen within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /**
   * Waits and reports whether anything arrived, without throwing: the checks that
   * expect silence are just as real as the ones that expect a message.
   */
  async quietFor(description, predicate, { timeoutMs, from }) {
    try {
      const found = await this.waitFor(description, predicate, { timeoutMs, from });
      return found;
    } catch {
      return null;
    }
  }

  _scan(predicate, from) {
    for (let index = from; index < this.log.length; index += 1) {
      if (predicate(this.log[index], index)) return { message: this.log[index], index };
    }
    return null;
  }

  _onData(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this._failAll(`a frame could not be read: ${error.message}`);
      return;
    }
    for (const frame of frames) {
      let message;
      try {
        message = this._decode(frame);
      } catch (error) {
        this._failAll(`a frame could not be opened: ${error.message}`);
        return;
      }
      this.log.push(message);
      // What the phone does after it has drawn: without it the server holds its
      // screencast and the page stops moving, which is the one failure mode that
      // looks like a frozen picture rather than an error.
      if (this.autoAck && message.type === Type.FRAME) {
        this.send(Type.ACK, messages.encodeAck({ frameSeq: message.seq }));
      }
    }
    this._wake();
  }

  _decode(frame) {
    // HELLO_ACK and ERROR are the handshake, in the clear: they arrive before
    // there is a key to open them with, which is why they are the only two types
    // that travel unsealed.
    if (frame.type === Type.HELLO_ACK || frame.type === Type.ERROR) {
      return { type: frame.type, seq: frame.seq, payload: frame.payload };
    }
    if (!isSealed(frame.type)) {
      throw new Error(`a plaintext ${describeType(frame.type)} after the handshake`);
    }
    if (!this.opener) throw new Error('a sealed frame arrived before the keys did');
    // Rebuilt into a whole frame because the opener authenticates the header as
    // additional data: it needs the same sixteen bytes the server wrote.
    return this.opener.open(encodeFrame({ type: frame.type, seq: frame.seq, payload: frame.payload }));
  }

  _wake() {
    for (const waiter of [...this.waiters]) {
      const found = this._scan(waiter.predicate, waiter.from);
      if (!found) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(found);
    }
  }

  _failAll(reason) {
    this.closedReason = reason;
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.reject(new Error(`${waiter.description} cannot happen: ${reason}`));
    }
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skipped(name, why) {
  results.push({ name, skipped: true });
  console.log(`  \u00b7 ${name} — SKIPPED (${why})`);
}

/**
 * Waits until the server is SHOWING `url` with that document loaded, and returns
 * the three messages that say so.
 *
 * Three signals, and every one of them is needed:
 *
 *   * the URL message, because a FRAME is a picture of whatever the browser is
 *     showing and after a navigation that can still be the page being left
 *     behind. The first version of this file treated any frame as "my page has
 *     drawn", tapped the wrong document, missed the text field, and reported a
 *     working server as broken;
 *   * the FOCUS that follows a completed load, which is the only message in the
 *     protocol meaning "the new document is ready to be touched";
 *   * a frame, for the picture -- looked for over the WHOLE window and not only
 *     after the URL, because the picture and the address arrive as separate
 *     messages and either can come first. Requiring a frame after the URL was the
 *     second version of this bug: the frame had already arrived, the client had
 *     not acknowledged it, the server held its screencast, and the tool waited
 *     twenty seconds for a picture it was already holding.
 */
async function waitForPage(connection, url, { timeoutMs, from = 0 }) {
  const landed = await connection.waitFor(`the server to report ${url}`,
    (message) => message.type === Type.URL && messages.decodeUrl(message.payload).url === url,
    { from, timeoutMs });
  const focus = await connection.waitFor(`the document at ${url} to finish loading`,
    (message) => message.type === Type.FOCUS,
    { from: landed.index + 1, timeoutMs });
  const frame = await connection.waitFor(`a FRAME for ${url}`,
    (message) => message.type === Type.FRAME,
    { from, timeoutMs });
  return { landed, focus, frame };
}

function finish() {
  const failed = results.filter((result) => !result.ok);
  const skippedCount = results.filter((result) => result.skipped).length;
  const ran = results.length - skippedCount;
  console.log(`\n${ran - failed.length}/${ran} checks passed${skippedCount ? `, ${skippedCount} skipped` : ''}.`);
  if (failed.length > 0) {
    console.log('This deployment is not doing what the protocol says it does.');
    return 1;
  }
  console.log('The server completed a session, drew a page, and answered where the focus is.');
  return 0;
}

// ── The run ─────────────────────────────────────────────────────────────────

function dial(args) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: args.host,
      port: args.port,
      rejectUnauthorized: args.verify,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    });
    socket.setNoDelay(true);
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.device || !args.token) {
    console.error('a device id and a token are required; try --help');
    return 2;
  }

  console.log(`── ${args.host}:${args.port}, device ${args.device}`);
  const socket = await dial(args);
  console.log(`  TLS ${socket.getProtocol()}, ${socket.getCipher().name}`);

  const connection = new Connection(socket, { timeoutMs: args.timeout });

  connection.socket.write(plainFrame(Type.HELLO, messages.encodeHello({
    protocolVersion: 1,
    deviceId: args.device,
    token: args.token,
    viewportWidth: 480,
    viewportHeight: 800,
    devicePixelRatio: 2,
    clientName: 'BrowserForWP smoke test',
  })));

  const ackFound = await connection.waitFor('a HELLO_ACK', (message) => message.type === Type.HELLO_ACK);
  const ack = messages.decodeHelloAck(ackFound.message.payload);
  if (!ack.ok) {
    report('the server accepts this device', false, `refused: ${ack.message} (code ${ack.code})`);
    socket.destroy();
    return finish();
  }
  report('the server accepts this device', true,
    `${ack.serverName || 'unnamed'}, audio ${(ack.flags & 1) === 1 ? 'on' : 'off'}`);
  connection.adopt(ack, args.token);

  // ── a page, drawn by a real Chromium ─────────────────────────────────────
  let drawn;
  try {
    connection.send(Type.NAVIGATE, messages.encodeNavigate({ url: args.url }));
    drawn = await waitForPage(connection, args.url, { timeoutMs: args.timeout });
  } catch (error) {
    report('a sealed NAVIGATE produces a FRAME', false, error.message);
    socket.destroy();
    return finish();
  }

  const frame = messages.decodeFramePayload(drawn.frame.message.payload);
  const tile = frame.tiles[0];
  const jpeg = tile.data.length > 3 && tile.data[0] === 0xff && tile.data[1] === 0xd8;
  report('a sealed NAVIGATE produces a FRAME', true,
    `landed on ${args.url}, ${frame.tiles.length} tile(s), ${tile.width}x${tile.height}, ${tile.data.length} bytes`);
  report('the frame is a JPEG', jpeg, jpeg ? '' : `it starts with ${tile.data.subarray(0, 4).toString('hex')}`);

  // The acknowledgement is the test: without it the server holds its screencast
  // and the picture simply stops changing, with nothing in any log.
  connection.send(Type.ACK, messages.encodeAck({ frameSeq: drawn.frame.message.seq }));
  const released = await connection.quietFor('a second FRAME after the ACK',
    (message) => message.type === Type.FRAME && message.seq > drawn.frame.message.seq,
    { from: connection.mark(), timeoutMs: args.timeout });
  report('the ACK releases the next frame', Boolean(released),
    released ? `seq ${released.message.seq}` : 'no further frame arrived; the screencast was not restarted');

  // The frame that just proved the point has to be acknowledged too. autoAck only
  // covers what arrives after it is switched on, and ONE unacknowledged frame
  // stops the screencast entirely -- so the check after this one would have
  // measured the missing ACK instead of what it is named after. This tool's first
  // version had exactly that bug, and it reported "the focus page produced no
  // frame" against a server that was working perfectly.
  if (released) connection.send(Type.ACK, messages.encodeAck({ frameSeq: released.message.seq }));

  // From here the phone's own behaviour, simplified: acknowledge on arrival.
  connection.autoAck = true;

  if (!args.focusUrl) {
    skipped('a tap on a text field reports an editable focus', 'no --focus-url given');
    skipped('the page\'s own focus on load is reported', 'no --focus-url given');
    skipped('Tab moves the answer with the focus', 'no --focus-url given');
    skipped('an unchanged answer stays quiet', 'no --focus-url given');
  } else {
    await focusChecks(connection, args);
  }

  socket.destroy();
  return finish();
}

/**
 * The FOCUS expectations, against the page described in this file's header.
 *
 * Every one of them takes a mark BEFORE its command and looks only after that
 * mark, so an answer to the previous command cannot be mistaken for the answer to
 * this one -- which is the mistake that would let this tool report success against
 * a server that never sent a FOCUS at all.
 */
async function focusChecks(connection, args) {
  const isFocus = (message) => message.type === Type.FOCUS;
  const editable = (found) => messages.decodeFocus(found.message.payload).editable;

  // `let` and not `const`: every check below moves the mark forward, and a const
  // here is a TypeError at the second check rather than a failing test -- which is
  // how this line shipped for one run, and the symptom was a report that stopped
  // after six lines with no summary at all.
  let mark = connection.mark();
  connection.send(Type.NAVIGATE, messages.encodeNavigate({ url: args.focusUrl }));

  let onLoad;
  try {
    const page = await waitForPage(connection, args.focusUrl, { timeoutMs: args.timeout, from: mark });
    onLoad = page.focus;
  } catch (error) {
    report('the focus page draws', false, error.message);
    return;
  }
  report('the focus page draws', true, args.focusUrl);

  // The document's own focus on load, with nobody touching the glass: the page has
  // no autofocus and nothing is clicked, so the honest answer is "not editable".
  report('the page\'s own focus on load is reported', editable(onLoad) === false,
    `editable=${editable(onLoad)}`);

  // A tap on the <input>. This is the whole point of the message.
  mark = connection.mark();
  connection.send(Type.TAP, messages.encodeTap({ x: 100, y: 40 }));
  const onField = await connection.quietFor('FOCUS after a tap on the text field', isFocus,
    { from: mark, timeoutMs: args.timeout });
  report('a tap on a text field reports an editable focus', Boolean(onField) && editable(onField) === true,
    onField ? `editable=${editable(onField)}` : 'no FOCUS arrived after the tap');

  // Typing: a change to the page is a new frame, and that is the only thing that
  // proves TEXT reached Chromium rather than this server's handler.
  mark = connection.mark();
  connection.send(Type.TEXT, messages.encodeText({ text: 'ciao' }));
  const typed = await connection.quietFor('a FRAME after typing',
    (message) => message.type === Type.FRAME, { from: mark, timeoutMs: args.timeout });
  report('typing changes the page', Boolean(typed),
    typed ? `a new frame, seq ${typed.message.seq}` : 'the page did not redraw');

  // Tab moves the focus to the button, which takes no text: the answer changes
  // without anybody tapping, which is why FOCUS follows KEY as well.
  mark = connection.mark();
  connection.send(Type.KEY, messages.encodeKey({ key: 'Tab' }));
  const afterTab = await connection.quietFor('FOCUS after Tab', isFocus, { from: mark, timeoutMs: args.timeout });
  report('Tab moves the answer with the focus', Boolean(afterTab) && editable(afterTab) === false,
    afterTab ? `editable=${editable(afterTab)}` : 'no FOCUS arrived after Tab');

  // A tap on the button: still not editable. The server must stay quiet rather
  // than repeat a byte the client already holds.
  mark = connection.mark();
  connection.send(Type.TAP, messages.encodeTap({ x: 100, y: 100 }));
  const repeated = await connection.quietFor('a repeated FOCUS', isFocus, { from: mark, timeoutMs: 2500 });
  report('an unchanged answer stays quiet', repeated === null,
    repeated ? `the server sent editable=${editable(repeated)} again` : 'nothing for 2.5 s, as the protocol promises');
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\nthe smoke test could not run: ${error.message}`);
    process.exit(1);
  });
