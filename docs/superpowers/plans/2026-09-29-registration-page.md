# A registration page, and a token that cannot move to another device

**Goal:** a page on the server where a person can request a device token without
shell access, behind a bot check, and once that token has been used by a device it
belongs to that device: any other device id presenting it is refused, until an
operator deliberately releases it.

## Global constraints

- **No new dependencies.** The only runtime dependency is `playwright`; the whole
  suite runs with `node --test` and no network.
- **The token is the only credential.** No accounts, no passwords, no reset flow.
  `devices.json` keeps SHA-256 digests and never a token.
- **A token never reaches a log.** `src/log.js` scrubs registered secrets and every
  line; the registration path registers the token it mints.
- **The registry is written by more than one process** (the CLI, the server, and
  now the page runs inside the server's process), so `refreshIfChanged` stays the
  rule for picking up somebody else's write.
- Node >= 20.11, ESM, `node --test`.
- Two decisions taken with the owner: the page exists and is for **people asking
  for tokens** (not only the operator), and the **token is the identity** — the
  phone's device id is a label, bound on first use.

## The rule this adds, in one place

```
token presented, device id claimed
  ├─ no device row with that token digest  → BAD_TOKEN
  ├─ row disabled                          → DISABLED_DEVICE
  ├─ row unbound                           → bind to the claimed id, save, OK
  ├─ row bound to the claimed id           → OK
  └─ row bound to a different id           → TOKEN_BOUND (8), refused
```

`TOKEN_BOUND` is a new value in `protocol/index.js`. The client already prints the
numeric code and the server's sentence (`RemoteChannel.ConnectAsync`), so nothing
in the VB client has to change for it to be understandable on the glass.

**This also fixes a defect that exists today:** the phone sends its own generated
device id (`RemoteEngine.LoadOrCreateDeviceId`) and the server looked devices up BY
id, against ids that only `bfwp-device add` ever created — and there is no field on
the phone to paste one into. A real handset would be refused `UNKNOWN_DEVICE`
forever. Looking up by token makes the id an identifier instead of a secret, which
is what it was always documented to be.

## File structure

| File | Action | Why |
| --- | --- | --- |
| `src/config.js` | modify | `BFWP_REGISTER_HOST/PORT/SECRET/PER_HOUR`, and the two refusals that make publishing it deliberate |
| `src/devices.js` | modify | bind on first use, look up by token, `releaseBinding`, `TOKEN_BOUND` |
| `protocol/index.js` | modify | `TOKEN_BOUND: 8` |
| `src/challenge.js` | create | the signed, single-use, expiring challenge, as a pure module with no HTTP in it |
| `src/register.js` | create | the page: `createRegistrationServer({ config, store, log })` |
| `src/session.js` | modify | the sentence for the new code; log the device that claimed the token |
| `bin/bfwp-device.js` | modify | `list` shows the binding, `release` clears it, `add` says what the id is now for |
| `bin/bfwp-render.js` | modify | start the listener, and say where it is and how exposed |
| `docker-compose.yml`, `Dockerfile` | modify | the port, the env, and `EXPOSE` |
| `test/{config,devices,register}.test.js` | modify/create | the tests, written first |
| `docs/DEPLOY.md`, `README.md`, `docs/SECURITY.md` | modify | how to reach it, how to publish it safely, and what the bot check is not |

---

## Task 1 — Configuration: publishing the page cannot be an accident

`src/config.js`, add to `DEFAULTS`:

```js
  registerHost: '127.0.0.1',
  registerPort: 8445,
  registerSecret: '',
  registerPerHour: 3,
```

and to the returned config:

```js
    registerHost: stringFrom(env, 'BFWP_REGISTER_HOST', DEFAULTS.registerHost),
    registerPort: intFrom(env, 'BFWP_REGISTER_PORT', DEFAULTS.registerPort, { min: 1, max: 65535 }),
    registerSecret: stringFrom(env, 'BFWP_REGISTER_SECRET', DEFAULTS.registerSecret),
    registerPerHour: intFrom(env, 'BFWP_REGISTER_PER_HOUR', DEFAULTS.registerPerHour, { min: 0, max: 100 }),
```

then, after `logLevel` is validated:

```js
  // Two refusals, and both are the point of the section rather than a formality.
  if (config.registerPort === config.port || config.registerPort === config.port + 1) {
    throw new ConfigError(`BFWP_REGISTER_PORT must differ from BFWP_PORT (${config.port})`
      + ` and from the audio port (${config.port + 1})`);
  }
  config.registerIsLoopback = LOOPBACK_HOSTS.has(config.registerHost);
  if (!config.registerIsLoopback && config.registerSecret.length < 16) {
    throw new ConfigError('BFWP_REGISTER_HOST is not a loopback address, so the page is'
      + ' reachable from the network: set BFWP_REGISTER_SECRET (16 characters or more),'
      + ' or leave BFWP_REGISTER_HOST at 127.0.0.1 and reach the page through an SSH tunnel.'
      + ' A page that mints credentials must not be open to whoever finds the port.');
  }
```

with `const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);` at the top.

Run: `node --test test/config.test.js` → the two new refusals red, then green.

## Task 2 — The token is the identity, bound on first use

`protocol/index.js`: `TOKEN_BOUND: 8,` (documented beside the others as "the token
is already claimed by another device").

`src/devices.js`:

```js
  add(label) { /* ... device gains: boundDeviceId: null ... */ }

  /** The row whose token digest matches, in constant time and in constant work. */
  findByToken(token) {
    const claimedHash = hashToken(token);
    let match = null;
    for (const device of this.data.devices) {
      // No early exit: returning at the first match makes the response time say
      // WHICH row matched, which is the ordering of the registry.
      if (constantTimeEqualsHex(claimedHash, device.tokenSha256)) match = device;
    }
    return match;
  }

  verify(deviceId, token) {
    const device = this.findByToken(token);
    if (!device) return { ok: false, code: ErrorCode.BAD_TOKEN, device: null };
    if (device.disabled) return { ok: false, code: ErrorCode.DISABLED_DEVICE, device: null };
    if (!device.boundDeviceId) {
      device.boundDeviceId = String(deviceId);
      this.save();
    } else if (device.boundDeviceId !== String(deviceId)) {
      return { ok: false, code: ErrorCode.TOKEN_BOUND, device: null };
    }
    return { ok: true, code: 0, device: this._public(device) };
  }

  releaseBinding(deviceId) { /* clears boundDeviceId, saves, returns whether it changed */ }
```

`list()` gains `boundDeviceId`, so the operator can see which phone holds a token.
`load()` treats a missing `boundDeviceId` as unbound (a registry written by an
older version is not rewritten by reading it).

Tests in `test/devices.test.js`: first use binds; the same id keeps working; a
second id is `TOKEN_BOUND` and the binding is not stolen by the attempt; a disabled
device is `DISABLED_DEVICE` before the binding is consulted; `releaseBinding` lets
another id claim it; an existing entry with no `boundDeviceId` claims on first use;
the digest-as-token test still refuses; the timing shape (all rows compared) is
asserted by counting comparisons with an injected counter? No — asserted by the
source contract: `findByToken` has no `break`/`return` inside its loop.

## Task 3 — The bot check: signed, single-use, and expiring

`src/challenge.js`, pure and testable (no HTTP, no store):

```js
const MIN_AGE_MS = 2000;      // a form filled in instantly was filled by a script
const MAX_AGE_MS = 15 * 60000;

export function createChallenge({ key, now = Date.now(), random = crypto.randomBytes }) {
  const a = 2 + (random(1)[0] % 8);        // answers that are not obvious to guess
  const b = 2 + (random(1)[0] % 8);
  const payload = { n: random(16).toString('hex'), t: now, a: a + b };
  return { question: `${a} + ${b}`, nonce: sign(payload, key) };
}

export function verifyChallenge({ nonce, answer, key, now = Date.now(), used = new Set() }) {
  // "ok" | "stale" | "replay" | "wrong"
}
```

`sign` = `base64url(JSON) + '.' + base64url(HMAC-SHA256(key, json))`, compared with
`timingSafeEqual`. `verifyChallenge` checks the signature, then the age window
(minimum AND maximum), then the answer, then marks the nonce used — and it marks it
used only if everything else passed, so a wrong answer cannot burn somebody else's
nonce. The key is `sha256(registerSecret || randomBytes(32))`, built once per
process: a restart invalidates open forms, which is the right trade for a page
whose only output is a credential.

## Task 4 — The page

`src/register.js`:

```js
export function createRegistrationServer({ config, store, log, now, random }) {
  ...
  return { start, stop, url, get registrations() }
}
```

- `GET /` → the form: a label field, the question, `nonce` hidden, `website`
  (honeypot, must be empty), and a `secret` field only when one is configured.
  `Cache-Control: no-store`.
- `POST /` → in this order: the secret (constant-time compare), the honeypot, the
  rate limit for the peer address, the challenge, then `store.add(label)`. A refusal
  is one short sentence and an HTTP status (403 / 429 / 400); the reason is logged,
  the answer is not.
- Success → the token, ONCE, with the three things the person needs: where to paste
  it, that it binds to the first phone that uses it, and that it cannot be read
  again from this server. The token goes to `log.addSecret(token)` before the line
  that names the device.
- TLS with the same certificate, `minVersion: 'TLSv1.2'` (an ordinary browser, not
  the custom stack), and plain HTTP only when `BFWP_ALLOW_INSECURE=1` says the
  whole deployment is a local test.

`test/register.test.js`: the challenge unit cases (wrong answer, replay, too new,
too old, tampered payload, no key), and over a real socket: `GET /` renders a
question; a good `POST` returns a token and the device appears in the store with
the token never in the HTML twice; a replayed nonce is refused; a filled honeypot is
refused; the fourth registration from one address in an hour is 429; with a secret
set, no secret and a wrong secret are both refused, and the right one works; and
`BFWP_REGISTER_PER_HOUR=0` disables the limit (documented as "for a deployment that
wants it").

## Task 5 — Wiring, and the words that change

- `bin/bfwp-render.js` starts it and logs `registration page on http(s)://host:port
  (loopback only|public, secret required)`; the "nobody can connect until you run
  `add`" warning also names the page.
- `bin/bfwp-device.js`: `list` prints `unbound` or `claimed by <id>`; new
  `release <deviceId>`; `add` explains that the printed id is a label and that the
  token binds to the first phone that uses it. The header comment — "There is no
  web UI and no signup page, deliberately" — becomes the honest version: there is
  one now, it mints the same single-use digest, and the reason it is safe to have
  is that it is loopback by default and refuses to be public without a secret.
- `src/session.js`: `TOKEN_BOUND` maps to "this token is already registered to
  another device; ask the server's operator to release it".
- `docker-compose.yml`: `BFWP_REGISTER_PORT: "8445"` plus the three others, and the
  port mapping commented out beside the audio one; `Dockerfile`: `EXPOSE 8443 8444
  8445`.
- `docs/DEPLOY.md`: a new "Registering a device from a page" section — the tunnel
  (`ssh -L 8445:127.0.0.1:8445`), the secret, the binding rule and `release`, and
  the warning that a token used once by `bfwp-smoke.js` is bound to that run: use a
  throwaway token for a test, or release it afterwards.
- `README.md`: the quick start gets the page as the second route to a token, and
  "Honest limits" says what the bot check is not (it stops form-filling scripts, not
  a human farm; the real gate is the loopback default or the secret).
- `docs/SECURITY.md`: the registration page named as a credential-minting surface.

## Verification

- `npm test` — the new tests, and the existing 155 still green
- `node bin/bfwp-device.js add/list/release` against a temporary registry
- `BFWP_REGISTER_HOST=0.0.0.0 node bin/bfwp-render.js` with no secret → refuses to
  start, with the message above
- a real `GET`/`POST` against a running listener on loopback
