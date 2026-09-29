// The bot check, as a pure module: no HTTP, no store, no clock it does not own.
//
// WHAT THIS IS HONESTLY WORTH. It stops a script that fills a form: the form
// carries a question a script has to answer, a signed nonce it cannot forge, a
// nonce that expires and can be spent exactly once, and a field a person never
// fills. What it does NOT stop is somebody solving it by hand, or a farm of them,
// and it is not sold as that here or in the README. The gate that actually matters
// is where the page listens -- loopback by default, and a secret the operator
// chooses before it can be anything else.
//
// THE NONCE IS SIGNED, NOT STORED, which is what lets a stateless handler hand out
// a challenge: the envelope carries its own answer and the HMAC makes it
// unchangeable. The one fact that cannot live in the envelope is "this one has
// been used", because only the server can remember that, so that is the one thing
// this module keeps in memory.
//
// A MODULE OF ITS OWN, rather than functions inside the request handler, because
// every rule here is a rule that can be tested without a socket: the age window,
// the replay refusal, the JSON that must parse, and the comparison that must not
// leak the answer through timing.

import crypto from 'node:crypto';

/** A form filled in faster than this was filled by something that is not a person. */
const MIN_AGE_MS = 2000;

/** And a form left open longer than this is stale, not slow. */
const MAX_AGE_MS = 15 * 60 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sign(payload, key) {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = base64url(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

/** The payload of a well-signed envelope, or null. Never throws on rubbish. */
function open(nonce, key) {
  const parts = String(nonce ?? '').split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;

  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest();
  // Buffer.from(..., 'base64url') does not throw on rubbish: it decodes what it
  // can. The length check is what refuses it, and timingSafeEqual refuses the rest.
  const presented = Buffer.from(parts[1], 'base64url');
  if (presented.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(expected, presented)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload.n !== 'string' || !Number.isInteger(payload.t)
      || !Number.isInteger(payload.a)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The key the challenges are signed with.
 *
 * WITH a secret configured, the key is derived from it and therefore survives a
 * restart: an operator who restarts the server while somebody has the form open
 * does not invalidate it. WITHOUT one -- the loopback default, where the secret
 * would be theatre -- the key is per-process, so a restart invalidates every open
 * form. That is the right trade for a page whose only output is a credential, and
 * it is why this is not simply a random key in both cases.
 */
export function challengeKey(secret = '', random = crypto.randomBytes) {
  const material = String(secret ?? '').length >= 16
    ? `bfwp-register|${secret}`
    : `bfwp-register|${random(32).toString('hex')}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest();
}

/** A question, and the signed envelope that carries its answer. */
export function createChallenge({ key, now = Date.now(), random = crypto.randomBytes }) {
  // 2..9 each, so the answer is 4..18: a person answers it in a second and a
  // script cannot do better than guessing one of fifteen values -- which it does
  // not get to do twice with the same envelope, because a spent nonce is spent.
  const left = 2 + (random(1)[0] % 8);
  const right = 2 + (random(1)[0] % 8);
  const payload = {
    n: random(16).toString('hex'),
    t: now,
    a: left + right,
  };
  return { question: `${left} + ${right}`, nonce: sign(payload, key) };
}

/**
 * Whether a submitted answer is acceptable.
 *
 * THE ORDER OF THESE CHECKS IS THE DESIGN, not an implementation detail:
 *
 *   1. the signature, because nothing else in the envelope can be believed until
 *      it holds;
 *   2. the age window, both ends;
 *   3. the spend, BEFORE the answer is looked at. A wrong answer has to burn the
 *      envelope, or one form would allow unlimited guesses at a number between 4
 *      and 18 -- which is a bot check that a loop walks through in one second.
 *      The cost is that a person who mistypes answers the new question, and that
 *      is a form they reload, not a wall they hit.
 *
 * An envelope that fails an earlier check is never spent, so rubbish cannot fill
 * the spent set: forging a signature is what that would take.
 */
export function verifyChallenge({ nonce, answer, key, now = Date.now(), spent }) {
  const payload = open(nonce, key);
  if (!payload) return { ok: false, reason: 'malformed' };

  const age = now - payload.t;
  if (age < MIN_AGE_MS) return { ok: false, reason: 'too-fast' };
  if (age > MAX_AGE_MS) return { ok: false, reason: 'expired' };

  if (spent.has(nonce)) return { ok: false, reason: 'replay' };
  spent.add(nonce, now);

  const given = String(answer ?? '').trim();
  if (!/^\d{1,3}$/.test(given) || Number.parseInt(given, 10) !== payload.a) {
    return { ok: false, reason: 'wrong' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * The nonces that have been spent, bounded in both directions.
 *
 * A Set would be enough for correctness and a leak in practice: every envelope the
 * server signs can be spent once by whoever holds it, so a caller willing to fetch
 * forms and waste them would grow this without limit. Entries older than the
 * challenge lifetime are useless anyway -- the envelope they name is expired -- so
 * they are the first to go, and the size cap is the second line.
 */
export function createSpentSet({ max = 4096, maxAgeMs = MAX_AGE_MS } = {}) {
  const entries = new Map();
  return {
    has(nonce) {
      return entries.has(nonce);
    },
    add(nonce, now = Date.now()) {
      entries.set(nonce, now);
      if (entries.size > max) this.prune(now);
      return this;
    },
    prune(now = Date.now()) {
      for (const [nonce, at] of entries) {
        if (now - at > maxAgeMs) entries.delete(nonce);
      }
      if (entries.size > max) {
        for (const nonce of entries.keys()) {
          if (entries.size <= max) break;
          entries.delete(nonce);
        }
      }
      return this;
    },
    get size() {
      return entries.size;
    },
  };
}

export { MAX_AGE_MS, MIN_AGE_MS };
