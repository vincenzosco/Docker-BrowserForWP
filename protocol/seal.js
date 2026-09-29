// The sealed frame layer: HKDF-SHA256 for the key schedule, AES-256-GCM per
// frame, and one key per direction.
//
// Why seal at all, when the transport is already TLS 1.3? Because TLS is
// terminated by whatever is in front of this process, and a deployment that puts
// a reverse proxy, a load balancer or a TLS terminator in the path silently
// downgrades "encrypted" to "encrypted as far as that box". The device token
// never leaves the phone except to the server that issued it, so sealing on top
// of TLS means a middlebox that strips nothing still cannot read a page. It is
// defence in depth, and it is cheap: one HMAC per direction per connection and
// one AEAD per frame.
//
// The primitives deliberately mirror BrowserForWP.Crypto, because the client
// implements this same layer with the values this repository already ships:
//
//   * Hkdf.Extract(salt, ikm) is HMAC-SHA256(salt, ikm), and an empty salt is
//     replaced by 32 zero bytes rather than by no key material.
//   * Hkdf.Expand(prk, info, length) is RFC 5869 section 2.3.
//   * AesGcm.Seal/Open use a 12-byte nonce and a 16-byte tag, and the wire order
//     is ciphertext followed by tag.
//
// Those three sentences are the whole contract, and protocol/vectors.json pins
// them with concrete bytes, so "the two implementations agree" is checked rather
// than asserted.

import crypto from 'node:crypto';
import {
  HEADER_SIZE,
  ProtocolError,
  decodeHeader,
  encodeHeader,
} from './index.js';

export const KEY_SIZE = 32; // AES-256-GCM
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;
export const TOKEN_SIZE = 32; // 256 bits of entropy in each device token
export const SALT_SIZE = 32;

// Domain separation: two keys, so a frame cannot be reflected back at its own
// sender, and neither direction can consume the other's sequence numbers.
export const INFO_C2S = Buffer.from('bfwp/render/v1/c2s', 'utf8');
export const INFO_S2C = Buffer.from('bfwp/render/v1/s2c', 'utf8');

const HASH_LENGTH = 32;

/** RFC 5869 section 2.2, with the spec's empty-salt quirk preserved. */
export function extract(salt, ikm) {
  const key = salt && salt.length > 0 ? salt : Buffer.alloc(HASH_LENGTH, 0);
  return crypto.createHmac('sha256', key).update(ikm ?? Buffer.alloc(0)).digest();
}

/** RFC 5869 section 2.3. */
export function expand(prk, info, length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
  if (!prk || prk.length === 0) throw new ProtocolError('prk required');
  if (length === 0) return Buffer.alloc(0);

  const infoBytes = info ?? Buffer.alloc(0);
  const blocks = Math.ceil(length / HASH_LENGTH);
  if (blocks > 255) throw new RangeError('HKDF output exceeds 255*HashLen');

  const out = Buffer.alloc(length);
  let previous = Buffer.alloc(0);
  let written = 0;
  for (let counter = 1; counter <= blocks; counter += 1) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(previous);
    hmac.update(infoBytes);
    hmac.update(Buffer.from([counter]));
    previous = hmac.digest();
    const take = Math.min(HASH_LENGTH, length - written);
    previous.copy(out, written, 0, take);
    written += take;
  }
  return out;
}

/**
 * Both directional keys, from the device token and the per-connection salt.
 *
 * The token is the IKM, so a device that never received one cannot derive
 * anything, and a session whose salt is fresh derives a different key every
 * time. That is what makes a reused sequence number harmless across
 * connections: the nonce space is only ever reused under a different key.
 */
export function deriveKeys(token, sessionSalt) {
  if (!token || token.length === 0) throw new ProtocolError('device token required');
  if (!sessionSalt || sessionSalt.length !== SALT_SIZE) {
    throw new ProtocolError(`session salt must be ${SALT_SIZE} bytes`);
  }
  const prk = extract(sessionSalt, token);
  return {
    prk,
    c2s: expand(prk, INFO_C2S, KEY_SIZE),
    s2c: expand(prk, INFO_S2C, KEY_SIZE),
  };
}

/** The nonce is the frame's own sequence number: big-endian, in the last 4 bytes. */
export function nonceFor(seq) {
  const nonce = Buffer.alloc(NONCE_SIZE, 0);
  nonce.writeUInt32BE(seq >>> 0, NONCE_SIZE - 4);
  return nonce;
}

/**
 * Seals outgoing frames for one direction. Owns the sequence counter, so no
 * caller can forget to advance it -- a repeated nonce under one key is the one
 * mistake in GCM that is both fatal and silent.
 */
export class Sealer {
  constructor(key) {
    if (!key || key.length !== KEY_SIZE) throw new ProtocolError(`key must be ${KEY_SIZE} bytes`);
    this.key = key;
    this.seq = 0;
  }

  /** Returns the whole frame: header, ciphertext, tag. */
  seal(type, plaintext) {
    const next = (this.seq + 1) >>> 0;
    if (next === 0) throw new ProtocolError('frame counter wrapped; rekey by reconnecting');
    this.seq = next;

    const body = Buffer.from(plaintext ?? Buffer.alloc(0));
    const header = encodeHeader({ type, seq: this.seq, length: body.length + TAG_SIZE });
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonceFor(this.seq));
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
  }
}

/**
 * Opens incoming frames for one direction, and refuses to move backwards.
 *
 * The counter advances only after the tag verifies, so a forged frame cannot
 * push the receiver forward and make the next genuine frame look like a replay.
 * `aes-256-gcm` raises on a bad tag rather than returning garbage, which is the
 * fail-closed behaviour this layer depends on.
 */
export class Opener {
  constructor(key) {
    if (!key || key.length !== KEY_SIZE) throw new ProtocolError(`key must be ${KEY_SIZE} bytes`);
    this.key = key;
    this.lastSeq = 0;
  }

  open(frame) {
    const { type, seq, length, header } = decodeHeader(frame);
    if (length < TAG_SIZE) throw new ProtocolError('sealed frame is shorter than its own tag');
    if (seq <= this.lastSeq) {
      throw new ProtocolError(`replayed or reordered frame: seq ${seq} after ${this.lastSeq}`);
    }

    const tagAt = HEADER_SIZE + length - TAG_SIZE;
    const ciphertext = frame.subarray(HEADER_SIZE, tagAt);
    const tag = frame.subarray(tagAt, HEADER_SIZE + length);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonceFor(seq));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    let payload;
    try {
      payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // Deliberately opaque: distinguishing "wrong key" from "tampered frame"
      // tells an attacker which of the two they achieved.
      throw new ProtocolError(`frame ${seq} failed authentication`);
    }

    // The header's declared length must be exactly what arrived.
    if (frame.length !== HEADER_SIZE + length) {
      throw new ProtocolError('sealed frame has trailing bytes outside its declared length');
    }

    this.lastSeq = seq;
    return { type, seq, payload };
  }
}

/**
 * A whole connection's crypto: one sealer and one opener per direction.
 *
 * The role is a required argument rather than a default, because the two ends
 * derive the SAME two keys and then wire them opposite ways round. Getting that
 * backwards produces a channel that seals happily and can never open anything,
 * which is a failure with no symptom until the first reply. Naming the role is
 * cheaper than debugging that.
 */
export class Channel {
  constructor(token, sessionSalt, role = 'server') {
    if (role !== 'server' && role !== 'client') {
      throw new ProtocolError("a channel's role must be 'server' or 'client'");
    }
    const keys = deriveKeys(token, sessionSalt);
    this.role = role;
    this.salt = Buffer.from(sessionSalt);
    this.prk = keys.prk;
    this.out = new Sealer(role === 'server' ? keys.s2c : keys.c2s);
    this.in = new Opener(role === 'server' ? keys.c2s : keys.s2c);
  }

  get framesSent() {
    return this.out.seq;
  }

  get framesReceived() {
    return this.in.lastSeq;
  }
}

export function randomSessionSalt() {
  return crypto.randomBytes(SALT_SIZE);
}

export function randomToken() {
  return crypto.randomBytes(TOKEN_SIZE);
}
