// The registration page, and the bot check under it.
//
// Two halves, and they are tested differently on purpose:
//
//   * src/challenge.js is pure, so the age window, the replay rule and the
//     signature are driven directly, with an injected clock and no socket: a form
//     whose lifetime can only be tested by waiting two seconds is a form whose
//     lifetime is not tested.
//   * src/register.js is a listener, so it is exercised over a real socket with a
//     real form, because the parts that break in a page are the parsing, the
//     escaping and the order of the refusals -- none of which a unit test of a
//     handler function would see.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { DeviceStore, hashToken } from '../src/devices.js';
import { challengeKey, createChallenge, createSpentSet, verifyChallenge } from '../src/challenge.js';
import { createRegistrationServer } from '../src/register.js';

const KEY = challengeKey('a-test-secret-long-enough');

/**
 * The same challenge every time: 2 + 3, because the two random bytes are 0 and 1
 * and the question is built as 2..9 + 2..9. The answer is RETURNED rather than
 * written down in each test, so a test cannot assert the arithmetic of a question
 * it did not read.
 */
function challengeAt({ now }) {
  const created = createChallenge({ key: KEY, now, random: () => Buffer.from([0, 1]) });
  const [left, right] = created.question.split(' + ').map(Number);
  return { ...created, answer: left + right };
}

test('the answer in the envelope is the one the question asks for', () => {
  const created = challengeAt({ now: 1_000_000 });
  assert.equal(created.question, '2 + 2');
  const verdict = verifyChallenge({
    nonce: created.nonce,
    answer: created.answer,
    key: KEY,
    now: 1_000_000 + 5000,
    spent: createSpentSet(),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'ok');
});

test('a form submitted instantly is a form filled by something that is not a person', () => {
  const spent = createSpentSet();
  const created = challengeAt({ now: 1_000_000 });
  const fast = verifyChallenge({
    nonce: created.nonce, answer: created.answer, key: KEY, now: 1_000_000 + 100, spent,
  });
  assert.equal(fast.ok, false);
  assert.equal(fast.reason, 'too-fast');

  // ...and it was NOT spent, so the person who was reading the question can still
  // answer it: a refusal that burns the envelope would punish the wrong caller.
  assert.equal(spent.size, 0);
  assert.equal(verifyChallenge({
    nonce: created.nonce, answer: created.answer, key: KEY, now: 1_000_000 + 5000, spent,
  }).ok, true);
});

test('an old form is expired, not slow', () => {
  const created = challengeAt({ now: 1_000_000 });
  const verdict = verifyChallenge({
    nonce: created.nonce,
    answer: created.answer,
    key: KEY,
    now: 1_000_000 + 60 * 60 * 1000,
    spent: createSpentSet(),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'expired');
});

test('an envelope can be spent exactly once', () => {
  const spent = createSpentSet();
  const created = challengeAt({ now: 1_000_000 });
  const first = verifyChallenge({
    nonce: created.nonce, answer: created.answer, key: KEY, now: 1_000_000 + 5000, spent,
  });
  const second = verifyChallenge({
    nonce: created.nonce, answer: created.answer, key: KEY, now: 1_000_000 + 6000, spent,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'replay');
});

// The property the bot check lives or dies on: one form is not a brute-force
// oracle. If a wrong answer left the envelope unspent, an attacker would get
// unlimited guesses at a number between 4 and 18 and would be through it in
// seconds.
test('a wrong answer spends the envelope, so a form cannot be guessed at', () => {
  const spent = createSpentSet();
  const created = challengeAt({ now: 1_000_000 });
  const wrong = verifyChallenge({
    nonce: created.nonce, answer: created.answer + 1, key: KEY, now: 1_000_000 + 5000, spent,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'wrong');
  assert.equal(spent.size, 1, 'the envelope must be spent by the attempt');

  const retry = verifyChallenge({
    nonce: created.nonce, answer: created.answer, key: KEY, now: 1_000_000 + 6000, spent,
  });
  assert.equal(retry.reason, 'replay', 'the second attempt must not get a second guess');
});

test('a tampered envelope is refused, and rubbish never fills the spent set', () => {
  const spent = createSpentSet();
  const created = challengeAt({ now: 1_000_000 });
  const [body, mac] = created.nonce.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  decoded.a = 99;
  const forged = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${mac}`;

  const verdict = verifyChallenge({ nonce: forged, answer: 99, key: KEY, now: 1_000_000 + 5000, spent });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'malformed');
  assert.equal(spent.size, 0, 'an unsigned envelope must not be remembered at all');
});

test('an envelope signed with another key is refused', () => {
  const other = createChallenge({ key: challengeKey('another-secret-entirely'), now: 1_000_000 });
  const verdict = verifyChallenge({
    nonce: other.nonce,
    answer: 5,
    key: KEY,
    now: 1_000_000 + 5000,
    spent: createSpentSet(),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'malformed');
});

test('rubbish nonces are refused without throwing', () => {
  const spent = createSpentSet();
  for (const nonce of [null, undefined, '', 'x', 'x.y', '....', 'AAAA.BBBB']) {
    const verdict = verifyChallenge({ nonce, answer: 9, key: KEY, now: 1_000_000, spent });
    assert.equal(verdict.ok, false, `${JSON.stringify(nonce)} must be refused`);
  }
});

test('the spent set is bounded, in both size and age', () => {
  const spent = createSpentSet({ max: 4, maxAgeMs: 1000 });
  for (let i = 0; i < 100; i += 1) spent.add(`nonce-${i}`, 500_000);
  assert.ok(spent.size <= 4, `expected at most 4 entries, got ${spent.size}`);

  const aging = createSpentSet({ max: 100, maxAgeMs: 1000 });
  aging.add('old', 500_000);
  aging.prune(500_000 + 5000);
  assert.equal(aging.has('old'), false);
});

// ── The page, over a socket ─────────────────────────────────────────────────

async function freshPage({ secret = '', perHour = 3, perDay = 0, httpPort = 0, url = '', open = false, now } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-register-'));
  const config = loadConfig({
    BFWP_ALLOW_INSECURE: '1',
    BFWP_REGISTER_PORT: '0',
    BFWP_REGISTER_PER_HOUR: String(perHour),
    // Zero here and one in production: the tests about the HOURLY window say so
    // with perDay: 0, because the shipped default of one per day would refuse the
    // second request of a test that is not about the day at all. config.test.js is
    // where the real default is asserted.
    BFWP_REGISTER_PER_DAY: String(perDay),
    BFWP_REGISTER_HTTP_PORT: String(httpPort),
    BFWP_REGISTER_URL: url,
    BFWP_REGISTER_SECRET: secret,
    BFWP_REGISTER_OPEN: open ? '1' : '0',
    // An open page is refused on loopback -- nobody to open it to -- so the tests
    // that use it have to bind the address the world can reach.
    ...(open ? { BFWP_REGISTER_HOST: '0.0.0.0' } : {}),
    BFWP_DEVICES_FILE: path.join(directory, 'devices.json'),
  });
  const store = new DeviceStore(config.devicesFile).load();
  const lines = [];
  const log = createLog({
    level: 'debug',
    sink: { out: { write: (line) => lines.push(line) }, err: { write: (line) => lines.push(line) } },
  });
  const clock = { at: now ?? 1_000_000 };
  const registration = createRegistrationServer({
    config,
    store,
    log,
    now: () => clock.at,
  });
  registration.start();
  // The port is 0 above, so the url is only real once the socket is up. Awaiting
  // it here keeps every test reading `registration.url` as the actual address.
  await registration.ready;
  return { registration, store, lines, clock, directory, config };
}

/**
 * A port the operating system has just agreed is free. The redirect listener cannot
 * ask for 0 the way the page does, because for THAT listener 0 means "no listener".
 */
async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function getForm(page, k = '') {
  const response = await fetch(`${page.registration.url}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
  const html = await response.text();
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  const question = html.match(/What is (\d+) \+ (\d+)\?/);
  const action = html.match(/<form method="post" action="([^"]+)"/)?.[1] ?? '/';
  // Number() and not string concatenation: '4' + '5' is '45', which is the kind of
  // bug that would look like a broken bot check rather than a broken test.
  const answer = question ? String(Number(question[1]) + Number(question[2])) : null;
  return { status: response.status, html, nonce, action, answer };
}

function post(page, fields, { query = '' } = {}) {
  return fetch(`${page.registration.url}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

/** A form filled in properly, timed so the age window is satisfied. */
async function register(page, { label = 'my phone', k = '' } = {}) {
  const form = await getForm(page, k);
  page.clock.at += 5000;
  const response = await post(page, {
    label,
    answer: form.answer,
    nonce: form.nonce,
    website: '',
    ...(k ? { secret: k } : {}),
  });
  return { form, status: response.status, html: await response.text() };
}

test('the form carries a question, a signed nonce and no token', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  assert.equal(form.status, 200);
  assert.ok(form.nonce.includes('.'), 'the nonce must be a signed envelope');
  assert.ok(form.answer !== null, 'the question must be on the page');
  // Where a token would be shown is the <pre><code> block of the success page, and
  // a GET must not have one: it hands the form to anybody who can load it.
  assert.ok(!/<pre><code>/.test(form.html), 'a GET must not mint anything');
  assert.equal(page.store.size, 0);
  assert.ok(form.action.startsWith('/'));
});

test('a correct form mints one token, which is shown once and never stored', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const { status, html } = await register(page, { label: 'my phone' });
  assert.equal(status, 200);

  const token = html.match(/<pre><code>([A-Za-z0-9_-]{43})<\/code><\/pre>/)?.[1];
  assert.ok(token, 'the page must show the token');

  assert.equal(page.store.size, 1);
  const [device] = page.store.list();
  assert.equal(device.label, 'my phone');
  assert.equal(device.boundDeviceId, null, 'nothing has claimed it yet');
  assert.ok(html.includes(device.deviceId), 'the operator needs the id to revoke it');

  const onDisk = fs.readFileSync(page.config.devicesFile, 'utf8');
  assert.ok(onDisk.includes(hashToken(token)), 'the digest is what is stored');
  assert.ok(!onDisk.includes(token), 'the token itself must never reach the disk');

  // The token appears once, and the markup it appears in is the only mention.
  assert.equal(html.split(token).length - 1, 1);

  // And the log, which is the other place a credential leaks from.
  const logged = page.lines.join('');
  assert.ok(!logged.includes(token), 'the token must never reach a log line');
  assert.ok(logged.includes(device.deviceId), 'the registration itself is logged');
});

test('a replayed nonce is refused, and mints nothing', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  page.clock.at += 5000;
  const fields = { label: 'my phone', answer: form.answer, nonce: form.nonce, website: '' };

  assert.equal((await post(page, fields)).status, 200);
  const second = await post(page, fields);
  assert.equal(second.status, 400);
  assert.match(await second.text(), /Not registered/);
  assert.equal(page.store.size, 1, 'the replay must not mint a second device');
});

test('the honeypot is refused, and nothing is minted', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  page.clock.at += 5000;
  const response = await post(page, {
    label: 'my phone',
    answer: form.answer,
    nonce: form.nonce,
    website: 'https://spam.example',
  });
  assert.equal(response.status, 403);
  assert.equal(page.store.size, 0);
});

test('a wrong answer is refused, and the envelope is spent', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  page.clock.at += 5000;
  const fields = { label: 'my phone', answer: String(Number(form.answer) + 1), nonce: form.nonce, website: '' };
  assert.equal((await post(page, fields)).status, 400);

  fields.answer = form.answer;
  assert.equal((await post(page, fields)).status, 400, 'the retry is a replay, not a second guess');
  assert.equal(page.store.size, 0);
});

test('one address cannot mint tokens all day', async (t) => {
  const page = await freshPage({ perHour: 2 });
  t.after(() => page.registration.stop());

  assert.equal((await register(page)).status, 200);
  assert.equal((await register(page)).status, 200);
  const third = await register(page);
  assert.equal(third.status, 429);
  assert.equal(page.store.size, 2);

  // ...and the window slides: an hour later the address may ask again.
  page.clock.at += 60 * 60 * 1000 + 1000;
  assert.equal((await register(page)).status, 200);
});

test('a rate limit of zero is no limit at all', async (t) => {
  const page = await freshPage({ perHour: 0 });
  t.after(() => page.registration.stop());
  for (let i = 0; i < 4; i += 1) assert.equal((await register(page)).status, 200);
  assert.equal(page.store.size, 4);
});

test('with an access code configured, nothing happens without it', async (t) => {
  const page = await freshPage({ secret: 'the-operator-code' });
  t.after(() => page.registration.stop());

  assert.equal((await getForm(page)).status, 403, 'even the form needs the code');

  const refused = await register(page, { k: 'wrong-code-entirely' });
  assert.equal(refused.status, 403);
  assert.equal(page.store.size, 0);

  const accepted = await register(page, { k: 'the-operator-code' });
  assert.equal(accepted.status, 200);
  assert.equal(page.store.size, 1);
});

test('the form carries the access code forward, so it is typed once', async (t) => {
  const page = await freshPage({ secret: 'the-operator-code' });
  t.after(() => page.registration.stop());

  const form = await getForm(page, 'the-operator-code');
  assert.match(form.action, /^\/\?k=the-operator-code$/);
});

test('anything that is not the page is not found, and other methods are refused', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  assert.equal((await fetch(`${page.registration.url}devices.json`)).status, 404);
  assert.equal((await fetch(page.registration.url, { method: 'PUT' })).status, 405);
});

test('a form that is not a form is a 413, not a crash', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const response = await fetch(page.registration.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x'.repeat(9000),
  });
  assert.equal(response.status, 413);
});

test('the page is never cached, and says what it will run', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const response = await fetch(page.registration.url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('a label is escaped rather than trusted', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const { html } = await register(page, { label: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'the label comes back from the browser and must not run');
  assert.ok(html.includes('&lt;script&gt;'));
});

// ── One token per address per day ─────────────────────────────────────────
// The limit that matters on a page the world can reach: the hourly guard is a
// burst guard, and a burst of one an hour is still twenty-four devices a day.

test('one address gets one token a day, and the refusal says when the next one comes', async (t) => {
  const page = await freshPage({ perDay: 1, perHour: 3 });
  t.after(() => page.registration.stop());

  const first = await register(page);
  assert.equal(first.status, 200);
  const token = first.html.match(/<pre><code>([A-Za-z0-9_-]+)<\/code><\/pre>/)?.[1];
  assert.ok(token && token.length > 20, 'the page showed a token');
  assert.ok(page.lines.every((line) => !line.includes(token)), 'and the log never names it');

  const second = await register(page);
  assert.equal(second.status, 429);
  assert.equal(page.store.size, 1, 'the refusal minted nothing');
  assert.match(second.html, /as many tokens as it can have today: 1/);
  // "Try again later" is not a thing a person can act on; this is.
  assert.match(second.html, /Another one becomes available in about 24 hours/);
  assert.ok(page.lines.some((line) => /over the limit of 1 per day/.test(line)));
});

test('the day is a window and not a wall: a day later the address may ask again', async (t) => {
  const page = await freshPage({ perDay: 1 });
  t.after(() => page.registration.stop());

  assert.equal((await register(page)).status, 200);
  assert.equal((await register(page)).status, 429);
  page.clock.at += 24 * 60 * 60 * 1000 + 1000;
  assert.equal((await register(page)).status, 200);
  assert.equal(page.store.size, 2);
});

test('a daily limit of zero leaves the hourly guard standing', async (t) => {
  const page = await freshPage({ perDay: 0, perHour: 2 });
  t.after(() => page.registration.stop());

  assert.equal((await register(page)).status, 200);
  assert.equal((await register(page)).status, 200);
  const third = await register(page);
  assert.equal(third.status, 429);
  assert.match(third.html, /as many tokens as it can have in the last hour: 2/);
});

test('the form says how many tokens the address may take, when there is a limit', async (t) => {
  const page = await freshPage({ perDay: 1, perHour: 0 });
  t.after(() => page.registration.stop());
  assert.match((await getForm(page)).html, /This address can be given one token per day\./);
});

// ── The page at the root of the address ───────────────────────────────────
// So that typing the bare IP in a browser arrives at the page, and nowhere near a
// form: what plain http gets is one 301 and one line of text.

test('the plain-http listener answers 301 to the page and serves no form', async (t) => {
  const port = await freePort();
  const page = await freshPage({ httpPort: port, url: 'https://render.example/' });
  t.after(() => page.registration.stop());

  const base = page.registration.redirectUrl;
  assert.equal(base, `http://127.0.0.1:${port}/`);

  const answer = await fetch(base, { redirect: 'manual' });
  assert.equal(answer.status, 301);
  assert.equal(answer.headers.get('location'), 'https://render.example/');
  assert.equal((await answer.text()).includes('<form'), false, 'no form over plain http');

  // The query string survives, so a deployment with an access code does not send
  // people to a page that refuses them.
  const withCode = await fetch(`${base}?k=the-operator-code`, { redirect: 'manual' });
  assert.equal(withCode.headers.get('location'), 'https://render.example/?k=the-operator-code');

  // A form posted here would carry a credential in the clear.
  const posted = await fetch(base, { method: 'POST', body: 'label=x' });
  assert.equal(posted.status, 405);
  assert.equal((await posted.text()).includes('<form'), false);
  assert.ok(page.lines.some((line) => /a POST to the plain-http port/.test(line)));
});

test('there is no plain-http listener unless a deployment asks for one', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());
  assert.equal(page.registration.redirectUrl, null);
});

test('every page that mentions a token says where it is removed', async (t) => {
  const page = await freshPage();
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  assert.match(form.html, /github\.com\/vincenzosco\/Docker-BrowserForWP\/issues/,
    'the form says it before a token exists, which is when it is worth knowing');

  const { html } = await register(page);
  const id = html.match(/The id to quote\s*in that request is <code>([^<]+)<\/code>/)?.[1];
  assert.ok(id, 'the page names the device id to quote in the request');
  assert.match(html, /href="https:\/\/github\.com\/vincenzosco\/Docker-BrowserForWP\/issues"/);
  assert.ok(html.includes(`bfwp-device release ${id}`),
    'and the operator half of the same request, for whoever has a shell');
});

test('a fork can point the removal requests at its own issues', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bfwp-register-'));
  const config = loadConfig({
    BFWP_ALLOW_INSECURE: '1',
    BFWP_REGISTER_PORT: '0',
    BFWP_ISSUES_URL: 'https://issues.example/bfwp',
    BFWP_DEVICES_FILE: path.join(directory, 'devices.json'),
  });
  const registration = createRegistrationServer({
    config,
    store: new DeviceStore(config.devicesFile).load(),
    log: createLog({ level: 'error', sink: { out: { write() {} }, err: { write() {} } } }),
  });
  registration.start();
  t.after(() => registration.stop());
  await registration.ready;

  const response = await fetch(registration.url);
  assert.match(await response.text(), /https:\/\/issues\.example\/bfwp/);
});

test('an open page has no code field, and mints for whoever arrives', async (t) => {
  const page = await freshPage({ open: true, perDay: 0, perHour: 0 });
  t.after(() => page.registration.stop());

  const form = await getForm(page);
  assert.equal(form.status, 200);
  assert.equal(form.html.includes('name="secret"'), false, 'an open page has no code field');
  assert.equal((await register(page)).status, 200);
  assert.equal(page.store.size, 1);
  assert.ok(page.lines.some((line) => /NO ACCESS CODE/.test(line)),
    'the log says which page this is, in those words');
});
