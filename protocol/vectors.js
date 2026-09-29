// The deterministic vectors, as a function.
//
// It lives in protocol/ rather than in bin/ because two callers need it: the
// generator, which writes the file, and the test, which regenerates the same
// object and fails if the checked-in file has drifted. A generator whose output
// is only ever written is a generator nobody notices breaking.
//
// Everything is fixed on purpose. A token of 0x00..0x1f, a salt of 0x20..0x3f,
// fixed plaintexts, a fresh Sealer per direction. No randomness reaches this
// file, so the same bytes come out on every machine and in every year.

import {
  HEADER_SIZE,
  MAGIC,
  Type,
  VERSION,
  describeType,
  encodeHeader,
} from './index.js';
import * as messages from './messages.js';
import { Sealer, deriveKeys, nonceFor } from './seal.js';

export const VECTOR_TOKEN = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
export const VECTOR_SESSION_SALT = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 0x20));

export const VECTOR_VIEWPORT = Object.freeze({ width: 480, height: 800, dpr: 2 });

export function buildVectors() {
  const keys = deriveKeys(VECTOR_TOKEN, VECTOR_SESSION_SALT);

  const payloads = [
    {
      name: 'HELLO',
      type: Type.HELLO,
      sealed: false,
      hex: messages.encodeHello({
        protocolVersion: 1,
        deviceId: '0f7c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b',
        token: VECTOR_TOKEN.toString('base64url'),
        viewportWidth: VECTOR_VIEWPORT.width,
        viewportHeight: VECTOR_VIEWPORT.height,
        devicePixelRatio: VECTOR_VIEWPORT.dpr,
        clientName: 'BrowserForWP/0.1 (WindowsPhone8.1)',
      }).toString('hex'),
    },
    {
      name: 'HELLO_ACK_REFUSED',
      type: Type.HELLO_ACK,
      sealed: false,
      hex: messages.encodeHelloAckError({ code: 2, message: 'the device token does not match' }).toString('hex'),
    },
    {
      name: 'HELLO_ACK_OK',
      type: Type.HELLO_ACK,
      sealed: false,
      hex: messages.encodeHelloAckOk({
        sessionSalt: VECTOR_SESSION_SALT,
        maxFrameBytes: 2097152,
        flags: 1,
        serverName: 'BrowserForWP render server',
        audioUrl: 'https://render.example/audio/9f3a1c22?t=abc',
      }).toString('hex'),
    },
    {
      name: 'NAVIGATE',
      type: Type.NAVIGATE,
      sealed: true,
      hex: messages.encodeNavigate({ url: 'https://example.com/' }).toString('hex'),
    },
    {
      name: 'TAP',
      type: Type.TAP,
      sealed: true,
      hex: messages.encodeTap({ x: 120, y: 240, buttons: 1, clickCount: 1 }).toString('hex'),
    },
    {
      name: 'SCROLL',
      type: Type.SCROLL,
      sealed: true,
      hex: messages.encodeScroll({ x: 200, y: 300, deltaX: 0, deltaY: -120 }).toString('hex'),
    },
    {
      name: 'KEY',
      type: Type.KEY,
      sealed: true,
      hex: messages.encodeKey({ key: 'Enter', modifiers: 0, text: '' }).toString('hex'),
    },
    {
      name: 'TEXT',
      type: Type.TEXT,
      sealed: true,
      hex: messages.encodeText({ text: 'ciao' }).toString('hex'),
    },
    {
      name: 'RESIZE',
      type: Type.RESIZE,
      sealed: true,
      hex: messages.encodeResize({ width: 720, height: 1280, devicePixelRatio: 3 }).toString('hex'),
    },
    {
      name: 'FIND',
      type: Type.FIND,
      sealed: true,
      hex: messages.encodeFind({ text: 'news' }).toString('hex'),
    },
    {
      name: 'SETTINGS',
      type: Type.SETTINGS,
      sealed: true,
      hex: messages.encodeSettings({ nightMode: true, desktopMode: false, blockTrackers: true }).toString('hex'),
    },
    {
      name: 'PING',
      type: Type.PING,
      sealed: true,
      hex: messages.encodeNonce(0x01020304).toString('hex'),
    },
    {
      name: 'ACK',
      type: Type.ACK,
      sealed: true,
      hex: messages.encodeAck({ frameSeq: 7 }).toString('hex'),
    },
    {
      name: 'BACK',
      type: Type.BACK,
      sealed: true,
      hex: messages.encodeEmpty().toString('hex'),
    },
    {
      name: 'TITLE',
      type: Type.TITLE,
      sealed: true,
      hex: messages.encodeTitle({ title: 'Example Domain' }).toString('hex'),
    },
    {
      name: 'URL',
      type: Type.URL,
      sealed: true,
      hex: messages.encodeUrl({ url: 'https://example.com/' }).toString('hex'),
    },
    {
      name: 'LOAD_STATE',
      type: Type.LOAD_STATE,
      sealed: true,
      hex: messages.encodeLoadState({ state: 1, detail: '' }).toString('hex'),
    },
    {
      name: 'FIND_RESULT',
      type: Type.FIND_RESULT,
      sealed: true,
      hex: messages.encodeFindResult({ found: true, matches: 3 }).toString('hex'),
    },
    {
      name: 'AUDIO',
      type: Type.AUDIO,
      sealed: true,
      hex: messages.encodeAudio({ playing: true, url: 'https://render.example/audio/9f3a1c22?t=abc' }).toString('hex'),
    },
    {
      name: 'PONG',
      type: Type.PONG,
      sealed: true,
      hex: messages.encodeNonce(0x01020304).toString('hex'),
    },
    {
      name: 'FRAME_FULL',
      type: Type.FRAME,
      sealed: true,
      // Four bytes standing in for a JPEG. This vector pins the LAYOUT; a real
      // screenshot would make the file unreadable and the diff useless.
      hex: messages.encodeFullFrame({
        data: Buffer.from('ffd8ffd9', 'hex'),
        width: VECTOR_VIEWPORT.width,
        height: VECTOR_VIEWPORT.height,
      }).toString('hex'),
    },
  ];

  // Sealed frames, which is where a differently-built header shows up: the AAD
  // IS the header, so these hex strings fail to open if the two implementations
  // disagree about a single byte of it. That failure is otherwise invisible.
  const sealer = new Sealer(keys.c2s);
  const frames = [];
  for (const spec of payloads.filter((entry) => entry.sealed)) {
    const plaintext = Buffer.from(spec.hex, 'hex');
    const seq = sealer.seq + 1;
    frames.push({
      name: `${spec.name.toLowerCase()}-seq${seq}`,
      direction: 'client-to-server',
      type: spec.type,
      typeName: describeType(spec.type),
      seq,
      keyHex: keys.c2s.toString('hex'),
      nonceHex: nonceFor(seq).toString('hex'),
      aadHex: encodeHeader({ type: spec.type, seq, length: plaintext.length + 16 }).toString('hex'),
      plaintextHex: plaintext.toString('hex'),
      frameHex: sealer.seal(spec.type, plaintext).toString('hex'),
    });
  }

  const serverSealer = new Sealer(keys.s2c);
  const titlePayload = messages.encodeTitle({ title: 'Example Domain' });
  frames.push({
    name: 'title-s2c-seq1',
    direction: 'server-to-client',
    type: Type.TITLE,
    typeName: describeType(Type.TITLE),
    seq: 1,
    keyHex: keys.s2c.toString('hex'),
    nonceHex: nonceFor(1).toString('hex'),
    aadHex: encodeHeader({ type: Type.TITLE, seq: 1, length: titlePayload.length + 16 }).toString('hex'),
    plaintextHex: titlePayload.toString('hex'),
    frameHex: serverSealer.seal(Type.TITLE, titlePayload).toString('hex'),
  });

  return {
    protocolVersion: VERSION,
    magicHex: MAGIC.toString(16),
    headerSize: HEADER_SIZE,
    note: 'Deterministic. Regenerate with `npm run gen-vectors`; `npm test` fails if this file has drifted.',
    inputs: {
      tokenHex: VECTOR_TOKEN.toString('hex'),
      tokenBase64Url: VECTOR_TOKEN.toString('base64url'),
      sessionSaltHex: VECTOR_SESSION_SALT.toString('hex'),
    },
    keySchedule: {
      prkHex: keys.prk.toString('hex'),
      clientToServerKeyHex: keys.c2s.toString('hex'),
      serverToClientKeyHex: keys.s2c.toString('hex'),
    },
    nonces: [0, 1, 2, 258, 0xffffffff].map((seq) => ({ seq, hex: nonceFor(seq).toString('hex') })),
    payloads,
    frames,
  };
}
