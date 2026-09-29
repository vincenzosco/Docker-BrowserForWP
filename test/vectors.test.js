import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_SIZE, MAGIC, VERSION } from '../protocol/index.js';
import { Opener, nonceFor } from '../protocol/seal.js';
import { buildVectors } from '../protocol/vectors.js';

const VECTORS_PATH = new URL('../protocol/vectors.json', import.meta.url);
const onDisk = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

test('protocol/vectors.json is exactly what the code produces now', () => {
  // The point of this test is the diff it produces: the moment someone changes a
  // field order, a width or the AAD, this fails with the old and the new bytes
  // side by side, and the client's copy is visibly stale.
  assert.deepEqual(onDisk, buildVectors());
});

test('the constants in the vectors match the constants in the code', () => {
  assert.equal(onDisk.protocolVersion, VERSION);
  assert.equal(onDisk.headerSize, HEADER_SIZE);
  assert.equal(onDisk.magicHex, MAGIC.toString(16));
});

test('no vector is empty and the file explains how to regenerate it', () => {
  assert.ok(onDisk.payloads.length >= 20, 'every message type should have a vector');
  assert.ok(onDisk.frames.length >= 10, 'several sealed frames should be pinned');
  // The field-less messages are legitimately empty, and pinning that is worth as
  // much as pinning a field: a stray byte in one of them is a layout bug.
  const fieldLess = new Set(['BACK', 'FORWARD', 'RELOAD', 'STOP']);
  for (const payload of onDisk.payloads) {
    if (fieldLess.has(payload.name)) {
      assert.equal(payload.hex, '', `${payload.name} carries no fields and should be empty`);
    } else {
      assert.ok(payload.hex.length > 0, `${payload.name} has no bytes`);
    }
    assert.match(payload.name, /^[A-Z][A-Z0-9_]*$/);
  }
  assert.match(onDisk.note, /npm run gen-vectors/);
});

test('every nonce vector is the sequence number in its last four bytes', () => {
  for (const nonce of onDisk.nonces) {
    assert.equal(nonce.hex, nonceFor(nonce.seq).toString('hex'));
  }
  assert.equal(onDisk.nonces.length, 5);
});

test('every sealed frame opens with its own key to exactly its own plaintext', () => {
  for (const vector of onDisk.frames) {
    const keyHex = vector.direction === 'client-to-server'
      ? onDisk.keySchedule.clientToServerKeyHex
      : onDisk.keySchedule.serverToClientKeyHex;
    assert.equal(vector.keyHex, keyHex, `${vector.name} claims the wrong direction key`);

    const frame = Buffer.from(vector.frameHex, 'hex');
    // A fresh opener per vector, because each vector is the first frame of its
    // own stream and carries its own sequence number.
    const opened = new Opener(Buffer.from(keyHex, 'hex')).open(frame);

    assert.equal(opened.type, vector.type, `${vector.name} opened as the wrong type`);
    assert.equal(opened.seq, vector.seq);
    assert.equal(opened.payload.toString('hex'), vector.plaintextHex, `${vector.name} opened to the wrong bytes`);
  }
});

test('every frame vector pins its nonce and its AAD separately from its bytes', () => {
  // These two assertions are the ones that make a mismatch diagnosable: when a
  // client fails to open a frame, this says whether the nonce or the header is
  // the part that differs, which is otherwise a guess.
  for (const vector of onDisk.frames) {
    assert.equal(vector.nonceHex, nonceFor(vector.seq).toString('hex'), `${vector.name} nonce`);
    const frame = Buffer.from(vector.frameHex, 'hex');
    assert.equal(frame.subarray(0, HEADER_SIZE).toString('hex'), vector.aadHex, `${vector.name} AAD`);
    assert.equal(
      frame.length,
      HEADER_SIZE + Buffer.from(vector.plaintextHex, 'hex').length + 16,
      `${vector.name} length`,
    );
  }
});

test('the frame vectors cover both directions', () => {
  const directions = new Set(onDisk.frames.map((vector) => vector.direction));
  assert.deepEqual([...directions].sort(), ['client-to-server', 'server-to-client']);
});
