import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../protocol/index.js';
import { DeviceStore, hashToken, newDeviceToken } from '../src/devices.js';

function freshStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-devices-'));
  const store = new DeviceStore(path.join(directory, 'devices.json'));
  store.load();
  return { store, directory };
}

test('a new token is 32 bytes of base64url and hashes to a 64-character digest', () => {
  const token = newDeviceToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
});

test('adding a device returns the token once and stores only its hash', () => {
  const { store, directory } = freshStore();
  const { device, token } = store.add('my phone');

  assert.match(device.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(device.disabled, false);

  const written = fs.readFileSync(path.join(directory, 'devices.json'), 'utf8');
  assert.ok(written.includes(hashToken(token)), 'the digest should be on disk');
  assert.ok(!written.includes(token), 'the token itself must never be on disk');
});

test('the registry file is written owner-read-only', () => {
  const { store, directory } = freshStore();
  store.add('my phone');
  const mode = fs.statSync(path.join(directory, 'devices.json')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('the public list never exposes the digest', () => {
  const { store } = freshStore();
  store.add('my phone');
  const [entry] = store.list();
  assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'deviceId', 'disabled', 'label']);
});

test('a correct token verifies and names the device', () => {
  const { store } = freshStore();
  const { device, token } = store.add('my phone');
  const verdict = store.verify(device.deviceId, token);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.device.deviceId, device.deviceId);
  assert.equal(verdict.device.label, 'my phone');
});

test('a wrong token is BAD_TOKEN, and says nothing about the device beyond its existence', () => {
  const { store } = freshStore();
  const { device } = store.add('my phone');
  const verdict = store.verify(device.deviceId, newDeviceToken());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ErrorCode.BAD_TOKEN);
  assert.equal(verdict.device, null);
});

test('an unknown device id is UNKNOWN_DEVICE', () => {
  const { store } = freshStore();
  store.add('my phone');
  const verdict = store.verify('00000000-0000-0000-0000-000000000000', newDeviceToken());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ErrorCode.UNKNOWN_DEVICE);
});

test('a disabled device is DISABLED_DEVICE even with the right token', () => {
  const { store } = freshStore();
  const { device, token } = store.add('stolen phone');
  assert.equal(store.setDisabled(device.deviceId, true), true);

  const verdict = store.verify(device.deviceId, token);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ErrorCode.DISABLED_DEVICE);

  store.setDisabled(device.deviceId, false);
  assert.equal(store.verify(device.deviceId, token).ok, true);
});

test('a token equal to the digest is not accepted', () => {
  // A plausible bug: comparing the presented token against the stored digest
  // without hashing it first. It would accept the digest as a password, which is
  // exactly the string that is sitting on disk and in every backup of it.
  const { store } = freshStore();
  const { device, token } = store.add('my phone');
  assert.equal(store.verify(device.deviceId, hashToken(token)).ok, false);
});

test('an empty or missing token is refused, never treated as a match', () => {
  const { store } = freshStore();
  const { device } = store.add('my phone');
  assert.equal(store.verify(device.deviceId, '').ok, false);
  assert.equal(store.verify(device.deviceId, null).ok, false);
  assert.equal(store.verify(device.deviceId, undefined).ok, false);
});

test('removing a device takes its credential away immediately', () => {
  const { store } = freshStore();
  const { device, token } = store.add('old phone');
  assert.equal(store.remove(device.deviceId), true);
  assert.equal(store.remove(device.deviceId), false, 'removing twice is not an error, just false');
  assert.equal(store.verify(device.deviceId, token).code, ErrorCode.UNKNOWN_DEVICE);
  assert.equal(store.size, 0);
});

test('the registry survives a reload', () => {
  const { store, directory } = freshStore();
  const { device, token } = store.add('my phone');

  const reloaded = new DeviceStore(path.join(directory, 'devices.json'));
  reloaded.load();
  assert.equal(reloaded.verify(device.deviceId, token).ok, true);
  assert.equal(reloaded.size, 1);
});

test('a missing registry file is an empty registry, not a crash', () => {
  const store = new DeviceStore(path.join(os.tmpdir(), 'bfwp-does-not-exist', 'devices.json'));
  assert.doesNotThrow(() => store.load());
  assert.equal(store.size, 0);
});

test('a corrupt registry file fails loudly instead of starting empty', () => {
  // Starting empty would silently invalidate every device, and the symptom would
  // be "my token stopped working" with nothing in the log to explain it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-devices-'));
  const file = path.join(directory, 'devices.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new DeviceStore(file).load(), /not valid JSON/);

  fs.writeFileSync(file, '{"version":1}');
  assert.throws(() => new DeviceStore(file).load(), /no devices array/);
});

test('saving does not leave a temporary file behind', () => {
  const { store, directory } = freshStore();
  store.add('one');
  store.add('two');
  const leftovers = fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
