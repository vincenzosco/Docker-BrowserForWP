// The session: one device, from the first byte to the last.
//
// This file is pure. It takes frames in, calls a browser interface, and writes
// buffers out through a `send` callback. It never touches a socket and never
// touches Chromium, which is the whole reason an authentication failure, a
// replayed frame and a slow link can all be tested here without a container.
//
// Four rules live here and nowhere else:
//
//   1. HELLO is first, and the only frame in the clear besides its answer.
//   2. HELLO_ACK travels in the clear, and must: it carries the session salt,
//      and the salt is what the client derives its keys FROM. Sealing it would
//      be sealing the thing that makes sealing possible. The channel is
//      installed only after it has gone out.
//   3. After HELLO_ACK, a PLAINTEXT frame is an attack, not a mistake. Someone
//      who can rewrite the stream would otherwise be able to strip the seal
//      layer by claiming it had not started yet. The session closes instead.
//   4. At most one frame is in flight. A phone on 3G cannot absorb a screenshot
//      stream, so the tap into Chromium is stopped until the client
//      acknowledges the frame it has. Nothing is buffered, nothing grows.

import {
  ErrorCode,
  LoadState,
  ProtocolError,
  Type,
  describeType,
  encodeFrame,
  encodeHeader,
  isSealed,
} from '../protocol/index.js';
import {
  MAX_TEXT_FIELD,
  MAX_URL_FIELD,
  decodeAck,
  decodeEmpty,
  decodeFind,
  decodeHello,
  decodeKey,
  decodeNavigate,
  decodeNonce,
  decodeResize,
  decodeScroll,
  decodeSettings,
  decodeTap,
  decodeText,
  encodeAudio,
  encodeFocus,
  encodeError,
  encodeFindResult,
  encodeFullFrame,
  encodeHelloAckError,
  encodeHelloAckOk,
  encodeLoadState,
  encodeNonce,
  encodeTitle,
  encodeUrl,
} from '../protocol/messages.js';
import { HELLO_ACK_FLAG_AUDIO } from '../protocol/index.js';
import { Channel, randomSessionSalt } from '../protocol/seal.js';

/**
 * Accepts what a person types, and refuses everything that is not the web.
 *
 * `file:`, `javascript:`, `data:` and `chrome:` are how a remote viewer turns
 * into a local file reader for whoever holds the phone. There is no legitimate
 * reason for this server to fetch one, so none of them reaches Chromium.
 */
export function sanitizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) throw new ProtocolError('empty url');
  if (text.length > MAX_URL_FIELD) throw new ProtocolError('url is implausibly long');

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ProtocolError(`not a url: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProtocolError(`refusing a ${parsed.protocol} url`);
  }
  return parsed.toString();
}

export class Session {
  constructor({
    store,
    browserFactory,
    config,
    send,
    log,
    sessionId,
    now = () => Date.now(),
    saltFactory = randomSessionSalt,
    onClosed = () => {},
  }) {
    if (!store) throw new Error('a session needs a device store');
    if (typeof send !== 'function') throw new Error('a session needs a send callback');
    this.store = store;
    this.browserFactory = browserFactory;
    this.config = config;
    this.send = send;
    this.onClosed = onClosed;
    this.log = log;
    this.sessionId = sessionId ?? 'session';
    this.now = now;
    this.saltFactory = saltFactory;

    this.state = 'awaiting-hello';
    this.device = null;
    this.channel = null;
    this.browser = null;
    this.viewport = {
      width: config.viewportWidth,
      height: config.viewportHeight,
      dpr: config.devicePixelRatio,
    };
    this.lastActivity = this.now();
    this.frameInFlight = null;
    this.framesSent = 0;
    this.framesDropped = 0;
    this.closedReason = null;
    // null means "not asked yet", which is different from "false". See
    // _reportFocus: a page change resets it, so the first report after a
    // navigation is always sent even when it repeats the previous byte.
    this.focusEditable = null;
  }

  /** Idle sessions are closed by the server; a phone in a pocket holds a page open. */
  isIdle(sinceMs) {
    return this.now() - this.lastActivity > sinceMs;
  }

  /** Plaintext before the handshake, sealed after it, and the only place that decides. */
  _write(type, payload) {
    if (this.channel) {
      this.send(this.channel.out.seal(type, payload));
      return this.channel.out.seq;
    }
    this.send(encodeFrame({ type, seq: 0, payload }));
    return 0;
  }

  /**
   * A write that must not be sealed.
   *
   * Used for HELLO_ACK and for refusals. A client that has not authenticated
   * cannot derive a key, so a sealed refusal is a refusal nobody can read.
   */
  _writePlaintext(type, payload) {
    if (!this.channel) return this._write(type, payload);
    const channel = this.channel;
    this.channel = null;
    try {
      return this._write(type, payload);
    } finally {
      this.channel = channel;
    }
  }

  async onFrame({ type, seq, payload }) {
    if (this.state === 'closed') return;
    this.lastActivity = this.now();

    if (this.state === 'awaiting-hello') {
      await this._handleHello(type, payload);
      return;
    }

    if (!isSealed(type)) {
      // Rule 3, and the reason it is a rule: tolerating this would let anyone
      // who can rewrite the stream downgrade the whole layer by claiming not to
      // have started it.
      await this.close(`plaintext ${describeType(type)} after the handshake`);
      return;
    }

    let opened;
    try {
      opened = this.channel.in.open(this._rebuildFrame(type, seq, payload));
    } catch (error) {
      await this.close(`rejected a sealed frame: ${error.message}`);
      return;
    }

    await this._dispatch(opened.type, opened.payload);
  }

  /**
   * Rebuild the whole frame from the decoder's parts.
   *
   * The decoder reports the header's fields and hands back the payload, but the
   * AEAD authenticates the header bytes. Rebuilding those bytes from the same
   * values is what keeps the AAD honest; if the two ever disagreed, every frame
   * would fail to open, which is at least the loud kind of failure.
   */
  _rebuildFrame(type, seq, payload) {
    return Buffer.concat([
      encodeHeader({ type, seq, length: payload.length }),
      payload,
    ]);
  }

  async _handleHello(type, payload) {
    if (type !== Type.HELLO) {
      this._writePlaintext(Type.ERROR, encodeError({
        code: ErrorCode.PROTOCOL,
        message: 'HELLO must be the first frame',
      }));
      await this.close('first frame was not HELLO');
      return;
    }

    let hello;
    try {
      hello = decodeHello(payload);
    } catch (error) {
      this._writePlaintext(Type.ERROR, encodeError({ code: ErrorCode.PROTOCOL, message: error.message }));
      await this.close(`malformed HELLO: ${error.message}`);
      return;
    }

    // Registered before anything else can log it, so a refused token is still
    // never written out.
    this.log.addSecret(hello.token);

    if (hello.protocolVersion !== 1) {
      this._writePlaintext(Type.HELLO_ACK, encodeHelloAckError({
        code: ErrorCode.BAD_VERSION,
        message: `this server speaks protocol version 1, the client offered ${hello.protocolVersion}`,
      }));
      await this.close('protocol version mismatch');
      return;
    }

    // The registry is written by ANOTHER PROCESS (`bfwp-device.js`, the same
    // container and a different process), so it is re-read when the file changes.
    // Logged, because an operator who has just run `add` is entitled to see that
    // the server noticed -- and a `disable` nobody notices is a lost phone that
    // still connects.
    if (this.store.refreshIfChanged()) {
      this.log.info(`${this.sessionId} device registry reloaded: ${this.store.size} device(s)`);
    }

    const verdict = this.store.verify(hello.deviceId, hello.token);
    if (!verdict.ok) {
      const message = verdict.code === ErrorCode.UNKNOWN_DEVICE
        ? 'this device id is not registered on this server'
        : verdict.code === ErrorCode.DISABLED_DEVICE
          ? 'this device has been disabled on this server'
          : 'the device token does not match';
      this._writePlaintext(Type.HELLO_ACK, encodeHelloAckError({ code: verdict.code, message }));
      this.log.warn(`${this.sessionId} refused a device: ${message}`);
      await this.close('authentication refused');
      return;
    }

    this.device = verdict.device;
    this.viewport = {
      width: hello.viewportWidth || this.config.viewportWidth,
      height: hello.viewportHeight || this.config.viewportHeight,
      dpr: hello.devicePixelRatio || this.config.devicePixelRatio,
    };

    const sessionSalt = this.saltFactory();
    const channel = new Channel(Buffer.from(hello.token, 'utf8'), sessionSalt);

    // Rule 2: the salt goes out in the clear FIRST, and only then is the channel
    // installed. Doing it the other way round seals the message that carries the
    // key material, and the client can never read it.
    this._writePlaintext(Type.HELLO_ACK, encodeHelloAckOk({
      sessionSalt,
      maxFrameBytes: this.config.maxFrameBytes,
      flags: this.config.audioEnabled ? HELLO_ACK_FLAG_AUDIO : 0,
      serverName: this.config.serverName,
      audioUrl: this.config.audioEnabled ? `${this.config.publicUrl}/audio/${this.sessionId}` : '',
    }));

    this.channel = channel;
    this.state = 'open';
    this.log.info(
      `${this.sessionId} opened for device ${this.device.deviceId} `
      + `at ${this.viewport.width}x${this.viewport.height}@${this.viewport.dpr}`,
    );

    try {
      this.browser = await this.browserFactory.create({
        deviceId: this.device.deviceId,
        viewport: this.viewport,
        onEvent: (event) => this._onBrowserEvent(event),
      });
    } catch (error) {
      this.log.error(`${this.sessionId} could not start a browser session`, error);
      this._write(Type.ERROR, encodeError({ code: ErrorCode.SERVER, message: 'no browser available' }));
      await this.close(`browser start failed: ${error.message}`);
      return;
    }

    if (typeof this.browser.applySettings === 'function') {
      await this.browser.applySettings({ nightMode: false, desktopMode: false });
    }
    await this._requestFrame();
  }

  /**
   * async because one branch has to ask the page a question before it can finish
   * reporting. The event source does not await this, which is fine: the handling
   * up to the first await is synchronous, so the messages that do not need an
   * answer keep the order they were emitted in.
   */
  async _onBrowserEvent(event) {
    if (this.state !== 'open' || !this.channel) return;
    try {
      if (event.kind === 'frame') {
        if (this.frameInFlight !== null) {
          // Rule 4: the previous frame has not been acknowledged, so the last
          // one is still on the wire. Dropping this one is the entire mechanism.
          this.framesDropped += 1;
          return;
        }
        const seq = this._write(Type.FRAME, encodeFullFrame({
          data: event.jpeg,
          width: event.width,
          height: event.height,
        }));
        this.frameInFlight = seq;
        this.framesSent += 1;
        if (typeof this.browser?.stopFrames === 'function') {
          Promise.resolve(this.browser.stopFrames()).catch(() => {});
        }
        return;
      }
      if (event.kind === 'title') {
        this._write(Type.TITLE, encodeTitle({ title: event.title }));
        return;
      }
      if (event.kind === 'url') {
        this._write(Type.URL, encodeUrl({ url: event.url }));
        return;
      }
      if (event.kind === 'load') {
        this._write(Type.LOAD_STATE, encodeLoadState({ state: event.state, detail: event.detail ?? '' }));
        // A completed load is where the page's focus has been thrown away -- a
        // navigation replaces the document, and autofocus may or may not have
        // landed on something that takes text. Reported here rather than left to
        // the next tap, because a page that focuses its own search box would
        // otherwise show a keyboard-less cursor until the person touched it.
        if (event.state === LoadState.DONE) await this._reportFocus();
        return;
      }
      if (event.kind === 'audio') {
        this._write(Type.AUDIO, encodeAudio({ playing: event.playing, url: event.url ?? '' }));
      }
    } catch (error) {
      this.log.error(`${this.sessionId} could not send a ${event.kind} message`, error);
    }
  }

  /**
   * Tell the client whether the page's focused element takes text, when the
   * answer has changed.
   *
   * TWO THINGS ARE DELIBERATE HERE. The first is the deduplication: typing a
   * sentence produces a key or a text message per keystroke, and a FOCUS message
   * per keystroke would be one message per character spent on a byte that did not
   * change. The second is that a browser which cannot answer is not an error --
   * the tests' fake browser and any future backend may have no focus() at all,
   * and a session that threw there would take the page down with it.
   */
  async _reportFocus() {
    if (typeof this.browser?.focus !== 'function') return;
    let answer;
    try {
      answer = await this.browser.focus();
    } catch (error) {
      this.log.debug(`${this.sessionId} could not ask the page about focus`, error.message);
      return;
    }
    if (!answer || typeof answer.editable !== 'boolean') return;
    if (this.focusEditable === answer.editable) return;
    this.focusEditable = answer.editable;
    this._write(Type.FOCUS, encodeFocus({ editable: answer.editable }));
  }

  async _requestFrame() {
    if (this.frameInFlight !== null) return;
    if (typeof this.browser?.startFrames === 'function') {
      await this.browser.startFrames();
    }
  }

  async _dispatch(type, payload) {
    try {
      switch (type) {
        case Type.NAVIGATE: {
          const { url } = decodeNavigate(payload);
          // "Not asked yet" again: the next document's focus is an unrelated
          // fact, so the first report after this must be sent even if its byte
          // matches the byte of the page being left behind.
          this.focusEditable = null;
          await this.browser.navigate(sanitizeUrl(url));
          return;
        }
        case Type.BACK:
          decodeEmpty(payload);
          await this.browser.back();
          return;
        case Type.FORWARD:
          decodeEmpty(payload);
          await this.browser.forward();
          return;
        case Type.RELOAD:
          decodeEmpty(payload);
          await this.browser.reload();
          return;
        case Type.STOP:
          decodeEmpty(payload);
          await this.browser.stop();
          return;
        case Type.RESIZE: {
          const resize = decodeResize(payload);
          this.viewport = { width: resize.width, height: resize.height, dpr: resize.devicePixelRatio };
          await this.browser.resize(this.viewport);
          this.frameInFlight = null;
          await this._requestFrame();
          return;
        }
        case Type.TAP:
          await this.browser.tap(decodeTap(payload));
          // The reason this message exists: a tap may have put the page's focus
          // in a text field, in a button, or nowhere, and only the document can
          // say which. The phone cannot guess it from the picture.
          await this._reportFocus();
          return;
        case Type.SCROLL:
          await this.browser.scroll(decodeScroll(payload));
          return;
        case Type.KEY: {
          const key = decodeKey(payload);
          if (key.key.length > MAX_TEXT_FIELD) throw new ProtocolError('key name is implausibly long');
          await this.browser.key(key);
          // Tab and Escape both move the focus, and the keys bar offers Tab on
          // purpose: the phone has no way to press it, and a keyboard that stays
          // up after Tab landed on a link is the same defect as one that never
          // came up at all.
          await this._reportFocus();
          return;
        }
        case Type.TEXT:
          await this.browser.text(decodeText(payload));
          return;
        case Type.FIND: {
          const result = await this.browser.find(decodeFind(payload));
          this._write(Type.FIND_RESULT, encodeFindResult({ found: result.found, matches: result.matches }));
          return;
        }
        case Type.SETTINGS:
          await this.browser.applySettings(decodeSettings(payload));
          return;
        case Type.PING: {
          const { nonce } = decodeNonce(payload);
          this._write(Type.PONG, encodeNonce(nonce));
          return;
        }
        case Type.ACK: {
          const { nonce } = decodeAck(payload);
          if (this.frameInFlight !== null && nonce >= this.frameInFlight) {
            this.frameInFlight = null;
            await this._requestFrame();
          }
          return;
        }
        default:
          throw new ProtocolError(`message type ${describeType(type)} is not accepted from a client`);
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        // A malformed message closes the session rather than being skipped:
        // when two ends disagree about a layout, continuing produces nonsense
        // that looks like a rendering bug.
        await this.close(`bad ${describeType(type)}: ${error.message}`);
        return;
      }
      this.log.error(`${this.sessionId} failed to handle ${describeType(type)}`, error);
      this._write(Type.LOAD_STATE, encodeLoadState({ state: LoadState.FAILED, detail: error.message }));
    }
  }

  async close(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closedReason = reason;
    const browser = this.browser;
    this.browser = null;
    if (browser && typeof browser.close === 'function') {
      await browser.close().catch(() => {});
    }
    this.log.info(`${this.sessionId} closed: ${reason}`);

    // The transport is told LAST, so that everything written before the close is
    // already queued on the socket. Without this the server holds a refused
    // device's connection open until the idle sweep, which is a slot a stranger
    // can occupy with no credential at all.
    try {
      this.onClosed(reason);
    } catch (error) {
      this.log.warn(`the transport refused to close: ${error.message}`);
    }
  }

  get stats() {
    return {
      state: this.state,
      deviceId: this.device?.deviceId ?? null,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
      framesReceived: this.channel ? this.channel.in.lastSeq : 0,
      closedReason: this.closedReason,
    };
  }
}
