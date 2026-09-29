import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog, redact } from '../src/log.js';

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    sink: {
      out: { write: (line) => out.push(line) },
      err: { write: (line) => err.push(line) },
    },
  };
}

test('a registered secret never reaches a line', () => {
  const { out, err, sink } = capture();
  const token = 'G7kQ2mN8pR4sT6vW9yB1cD3fH5jL7nP1qS4uV6xZ8a';
  const log = createLog({ level: 'debug', sink, secrets: [token] });

  log.info('opening a session for', token);
  log.debug(`token=${token}`);
  log.warn('refused', { token });
  log.error('failed with', `Bearer ${token}`);

  // warn and error go to the error stream, so both are checked: a scrubber that
  // only covers the stream nobody reads is not a scrubber.
  assert.ok(out.length >= 1);
  assert.ok(err.length >= 1);
  for (const line of [...out, ...err]) {
    assert.ok(!line.includes(token), `a line leaked the token: ${line}`);
    assert.ok(line.includes('[redacted]'), `the token should be visibly redacted: ${line}`);
  }
});

test('a token-shaped string is redacted even when nobody registered it', () => {
  // The second net: a token that reached a line by a path this module did not
  // anticipate -- a stack trace, an unhandled rejection, a dependency's log.
  const { out, sink } = capture();
  const log = createLog({ level: 'info', sink });
  log.info('something unexpected: 0Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd');

  assert.equal(out.length, 1);
  assert.ok(out[0].includes('[redacted]'));
  assert.ok(!out[0].includes('0Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd'));
});

test('a short string is left alone, because redacting every word is useless', () => {
  assert.equal(redact('the port is 8443', ['8443']), 'the port is 8443');
  assert.equal(redact('ok', []), 'ok');
});

test('redaction applies to an object that carries the secret', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  assert.ok(!redact(JSON.stringify({ token }), [token]).includes(token));
});

test('the level threshold is respected', () => {
  const { out, err, sink } = capture();
  const log = createLog({ level: 'warn', sink });
  log.debug('debug line');
  log.info('info line');
  log.warn('warn line');
  log.error('error line');

  assert.equal(out.length, 0, 'debug and info are below the threshold');
  assert.equal(err.length, 2, 'warn and error go to the error stream');
  assert.ok(err[0].includes('warn line'));
  assert.ok(err[1].includes('error line'));
});

test('silent silences everything, including errors', () => {
  const { out, err, sink } = capture();
  const log = createLog({ level: 'silent', sink });
  log.debug('a');
  log.info('b');
  log.warn('c');
  log.error('d');
  assert.equal(out.length, 0);
  assert.equal(err.length, 0);
});

test('a line is stamped with a level and an ISO time', () => {
  const { out, sink } = capture();
  createLog({ level: 'info', sink }).info('hello');
  assert.match(out[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO hello\n$/);
});

test('a child prefixes its lines and inherits the parent secrets', () => {
  const { out, sink } = capture();
  const token = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const parent = createLog({ level: 'info', sink, secrets: [token] });
  const child = parent.child('9f3a1c22');
  child.info('hello', token);

  assert.equal(out.length, 1);
  assert.ok(out[0].includes('9f3a1c22 hello'), out[0]);
  assert.ok(!out[0].includes(token));
});

test('an Error is rendered as its name and message, not as a JSON blob', () => {
  const { out, sink } = capture();
  createLog({ level: 'info', sink }).info(new TypeError('boom'));
  assert.ok(out[0].includes('TypeError: boom'), out[0]);
});

test('a circular object does not throw inside the logger', () => {
  const { out, sink } = capture();
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => createLog({ level: 'info', sink }).info(circular));
  assert.equal(out.length, 1);
});
