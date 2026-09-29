import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_SIZE, ProtocolError, Type, encodeHeader } from '../protocol/index.js';
import {
  Channel,
  KEY_SIZE,
  Opener,
  SALT_SIZE,
  Sealer,
  TAG_SIZE,
  deriveKeys,
  expand,
  extract,
  nonceFor,
} from '../protocol/seal.js';

// ── The primitives against the RFC, not against themselves ───────────────────
// protocol/vectors.json proves the two implementations agree with each other.
// These three cases prove the implementation is HKDF at all, which is a
// different and more important claim: two implementations can agree on
// something that is not the standard.

test('RFC 5869 test case 1: the basic case', () => {
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');

  const prk = extract(salt, ikm);
  assert.equal(prk.toString('hex'), '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
  assert.equal(
    expand(prk, info, 42).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
});

test('RFC 5869 test case 2: longer inputs and outputs', () => {
  const ikm = Buffer.from(Array.from({ length: 80 }, (_, index) => index));
  const salt = Buffer.from(Array.from({ length: 80 }, (_, index) => index + 0x60));
  const info = Buffer.from(Array.from({ length: 80 }, (_, index) => index + 0xb0));

  const prk = extract(salt, ikm);
  assert.equal(prk.toString('hex'), '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244');
  assert.equal(
    expand(prk, info, 82).toString('hex'),
    'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c'
    + '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71'
    + 'cc30c58179ec3e87c14c01d5c1f3434f1d87',
  );
});

test('RFC 5869 test case 3: an EMPTY salt is 32 zero bytes, not no salt', () => {
  // This is the specification's quirk and the easiest one to get wrong, because
  // "no salt" and "a zero salt" look identical in most code and are not the same
  // key. The assertion is against the RFC's own output.
  const ikm = Buffer.alloc(22, 0x0b);

  const prk = extract(Buffer.alloc(0), ikm);
  assert.equal(prk.toString('hex'), '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04');
  assert.equal(
    expand(prk, Buffer.alloc(0), 42).toString('hex'),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  );
  assert.equal(extract(null, ikm).toString('hex'), prk.toString('hex'));
});

test('a zero-length expansion is empty and an over-long one is refused', () => {
  const prk = extract(Buffer.alloc(SALT_SIZE, 1), Buffer.alloc(32, 2));
  assert.equal(expand(prk, Buffer.alloc(0), 0).length, 0);
  assert.throws(() => expand(prk, Buffer.alloc(0), 255 * 32 + 1), RangeError);
  assert.equal(expand(prk, Buffer.alloc(0), 255 * 32).length, 255 * 32);
});

test('an expansion longer than one block is the concatenation the RFC describes', () => {
  const prk = extract(Buffer.alloc(SALT_SIZE, 9), Buffer.alloc(32, 8));
  const long = expand(prk, Buffer.from('info', 'utf8'), 80);
  const short = expand(prk, Buffer.from('info', 'utf8'), 32);
  assert.equal(long.subarray(0, 32).toString('hex'), short.toString('hex'),
    'the first block must not depend on the requested length');
});

// ── The key schedule ────────────────────────────────────────────────────────

test('the two directions get different keys from one token', () => {
  const keys = deriveKeys(Buffer.alloc(32, 3), Buffer.alloc(SALT_SIZE, 4));
  assert.equal(keys.c2s.length, KEY_SIZE);
  assert.equal(keys.s2c.length, KEY_SIZE);
  assert.notEqual(keys.c2s.toString('hex'), keys.s2c.toString('hex'));
});

test('the same token and salt give the same keys, and a new salt does not', () => {
  const token = Buffer.alloc(32, 5);
  const first = deriveKeys(token, Buffer.alloc(SALT_SIZE, 6));
  const again = deriveKeys(token, Buffer.alloc(SALT_SIZE, 6));
  const other = deriveKeys(token, Buffer.alloc(SALT_SIZE, 7));
  assert.equal(first.c2s.toString('hex'), again.c2s.toString('hex'));
  assert.notEqual(first.c2s.toString('hex'), other.c2s.toString('hex'));
});

test('a token or a salt of the wrong shape is refused, not padded', () => {
  assert.throws(() => deriveKeys(Buffer.alloc(0), Buffer.alloc(SALT_SIZE)), ProtocolError);
  assert.throws(() => deriveKeys(Buffer.alloc(32), Buffer.alloc(SALT_SIZE - 1)), ProtocolError);
  assert.throws(() => new Sealer(Buffer.alloc(16)), ProtocolError);
  assert.throws(() => new Opener(Buffer.alloc(31)), ProtocolError);
});

test('the nonce is the sequence number in the last four bytes', () => {
  assert.equal(nonceFor(0).toString('hex'), '000000000000000000000000');
  assert.equal(nonceFor(1).toString('hex'), '000000000000000000000001');
  assert.equal(nonceFor(258).toString('hex'), '000000000000000000000102');
  assert.equal(nonceFor(0xffffffff).toString('hex'), '0000000000000000ffffffff');
  assert.equal(nonceFor(1).length, 12);
});

// ── The sealed frame ────────────────────────────────────────────────────────

test('a sealed frame opens back to exactly what went in', () => {
  const { c2s, s2c } = deriveKeys(Buffer.alloc(32, 11), Buffer.alloc(SALT_SIZE, 12));
  const sealer = new Sealer(c2s);
  const opener = new Opener(c2s);
  const plaintext = Buffer.from('https://example.com/', 'utf8');

  const frame = sealer.seal(Type.NAVIGATE, plaintext);
  assert.equal(frame.length, HEADER_SIZE + plaintext.length + TAG_SIZE);

  const opened = opener.open(frame);
  assert.equal(opened.type, Type.NAVIGATE);
  assert.equal(opened.seq, 1);
  assert.deepEqual(opened.payload, plaintext);

  const otherDirection = new Opener(s2c);
  assert.throws(() => otherDirection.open(frame), ProtocolError,
    'the other direction holds a different key');
});

test('the sequence numbers advance one per frame', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 13), Buffer.alloc(SALT_SIZE, 14));
  const sealer = new Sealer(c2s);
  assert.equal(sealer.seq, 0);
  assert.equal(sealer.seal(Type.PING, Buffer.alloc(0)).readUInt32BE(8), 1);
  assert.equal(sealer.seal(Type.PING, Buffer.alloc(0)).readUInt32BE(8), 2);
  assert.equal(sealer.seq, 2);
});

test('the header is authenticated, so the type cannot be relabelled', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 15), Buffer.alloc(SALT_SIZE, 16));
  const frame = new Sealer(c2s).seal(Type.NAVIGATE, Buffer.from('x'));

  const relabelled = Buffer.from(frame);
  relabelled.writeUInt8(Type.FRAME, 3);
  assert.throws(() => new Opener(c2s).open(relabelled), /failed authentication/);
});

test('the header is authenticated, so the length cannot be edited', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 17), Buffer.alloc(SALT_SIZE, 18));
  const frame = new Sealer(c2s).seal(Type.TEXT, Buffer.from('hello'));
  const relabelled = Buffer.from(frame);
  relabelled.writeUInt32BE(frame.readUInt32BE(4) - 1, 4);
  assert.throws(() => new Opener(c2s).open(relabelled), ProtocolError);
});

test('the ciphertext cannot be edited', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 19), Buffer.alloc(SALT_SIZE, 20));
  const frame = new Sealer(c2s).seal(Type.TEXT, Buffer.from('hello'));
  const tampered = Buffer.from(frame);
  tampered[HEADER_SIZE] ^= 0x01;
  assert.throws(() => new Opener(c2s).open(tampered), /failed authentication/);
});

test('the tag cannot be edited', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 21), Buffer.alloc(SALT_SIZE, 22));
  const frame = new Sealer(c2s).seal(Type.TEXT, Buffer.from('hello'));
  const tampered = Buffer.from(frame);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => new Opener(c2s).open(tampered), /failed authentication/);
});

test('a replayed frame is refused', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 23), Buffer.alloc(SALT_SIZE, 24));
  const sealer = new Sealer(c2s);
  const opener = new Opener(c2s);
  const first = sealer.seal(Type.PING, Buffer.from('one'));
  const second = sealer.seal(Type.PING, Buffer.from('two'));

  assert.equal(opener.open(first).seq, 1);
  assert.equal(opener.open(second).seq, 2);
  assert.throws(() => opener.open(first), /replayed or reordered/);
  assert.throws(() => opener.open(second), /replayed or reordered/);
});

test('a forged frame does not move the receiver forward', () => {
  // If a failed authentication advanced lastSeq, an attacker could forge frame
  // 9 and then the genuine frame 9 would look like a replay. The counter moves
  // only after the tag verifies.
  const { c2s } = deriveKeys(Buffer.alloc(32, 25), Buffer.alloc(SALT_SIZE, 26));
  const sealer = new Sealer(c2s);
  const opener = new Opener(c2s);
  const genuine = sealer.seal(Type.PING, Buffer.from('genuine'));

  const forged = Buffer.from(genuine);
  forged.writeUInt32BE(genuine.readUInt32BE(8) + 5, 8);
  assert.throws(() => opener.open(forged), ProtocolError);

  assert.equal(opener.lastSeq, 0, 'a refused frame must not be counted as received');
  assert.equal(opener.open(genuine).seq, 1);
});

test('a sealed frame shorter than its own tag is refused', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 27), Buffer.alloc(SALT_SIZE, 28));
  const frame = new Sealer(c2s).seal(Type.PING, Buffer.alloc(0));
  const truncated = frame.subarray(0, HEADER_SIZE + TAG_SIZE - 1);
  truncated.writeUInt32BE(TAG_SIZE - 1, 4);
  assert.throws(() => new Opener(c2s).open(truncated), /shorter than its own tag/);
});

test('trailing bytes outside the declared length are refused', () => {
  const { c2s } = deriveKeys(Buffer.alloc(32, 29), Buffer.alloc(SALT_SIZE, 30));
  const frame = new Sealer(c2s).seal(Type.PING, Buffer.from('x'));
  assert.throws(() => new Opener(c2s).open(Buffer.concat([frame, Buffer.from([0])])), ProtocolError);
});

test('a Channel wires the two directions opposite ways round', () => {
  const token = Buffer.from('a-device-token-of-some-length', 'utf8');
  const salt = Buffer.alloc(SALT_SIZE, 31);
  const server = new Channel(token, salt, 'server');
  const client = new Channel(token, salt, 'client');

  const fromClient = client.out.seal(Type.NAVIGATE, Buffer.from('https://example.com/'));
  const opened = server.in.open(fromClient);
  assert.equal(opened.payload.toString('utf8'), 'https://example.com/');

  const fromServer = server.out.seal(Type.TITLE, Buffer.from('Example'));
  assert.equal(client.in.open(fromServer).payload.toString('utf8'), 'Example');

  assert.equal(server.framesSent, 1);
  assert.equal(server.framesReceived, 1);
});

test('two channels on the same side cannot talk to each other', () => {
  // The mistake this guards against is wiring one Channel object for both ends:
  // it seals successfully and can never open what the other end sent.
  const token = Buffer.from('a-device-token-of-some-length', 'utf8');
  const salt = Buffer.alloc(SALT_SIZE, 32);
  const first = new Channel(token, salt, 'server');
  const second = new Channel(token, salt, 'server');
  assert.throws(() => second.in.open(first.out.seal(Type.PING, Buffer.alloc(0))), ProtocolError);
});

test('an unknown channel role is refused', () => {
  assert.throws(() => new Channel(Buffer.from('token'), Buffer.alloc(SALT_SIZE, 1), 'both'), ProtocolError);
});

test('the AAD is exactly the header, byte for byte', () => {
  // The client rebuilds this header from the values the decoder reported. If
  // either side's encodeHeader differed, nothing would ever open -- so this
  // pins the reconstruction rather than trusting it.
  const { c2s } = deriveKeys(Buffer.alloc(32, 33), Buffer.alloc(SALT_SIZE, 34));
  const plaintext = Buffer.from('hello');
  const frame = new Sealer(c2s).seal(Type.TEXT, plaintext);
  const rebuilt = encodeHeader({
    type: Type.TEXT,
    seq: 1,
    length: plaintext.length + TAG_SIZE,
  });
  assert.deepEqual(frame.subarray(0, HEADER_SIZE), rebuilt);
});
