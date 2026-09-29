// The registration page: where a person asks for a device token.
//
// WHY THIS EXISTS, given that `bin/bfwp-device.js` already mints tokens. Because
// minting one needed a shell on the server, and the people who need a token are
// the people holding the phones. The alternative considered and rejected was an
// account system: this page has no password database, no reset flow and no
// support burden, because it has no accounts either -- it mints the same
// single-use digest the CLI does, shows it once, and keeps only the digest.
//
// WHAT IT CANNOT DO. It cannot list tokens, cannot reveal one, and cannot choose
// which device a token belongs to (a token is claimed by the first device that uses
// it; see src/devices.js).
//
// WHO CAN REACH IT, in order of how much the operator had to decide:
//
//   loopback (the default)      nobody but this machine, through a tunnel
//   published, access code      anyone who has been told the code
//   BFWP_REGISTER_OPEN=1        anyone who finds it, and src/config.js refuses
//                               that together with a loopback bind (a page nobody
//                               can reach) or with a secret (two answers to one
//                               question)
//
// Open mode is a decision with a consequence, so the log says it in those words,
// and what stands in its place is the challenge under every form plus the
// per-address limits: one token per address per day by default, with an hourly
// burst guard beneath it.
//
// AND THE FORM IS NEVER SERVED OVER PLAIN HTTP. When BFWP_REGISTER_HTTP_PORT is
// set there is a second listener whose entire answer is a 301 to
// BFWP_REGISTER_URL, so that typing the bare address in a browser arrives at the
// encrypted page instead of at nothing.
//
// WHAT IT WRITES. One line per attempt, at info or warn, naming the device and
// never the token: the token is registered with the log's scrubber before the line
// that could contain it.
//
// THE PAGE HAS NO JAVASCRIPT. It is a form and a result, and a page that mints a
// credential is the last place to want a script running -- there is nothing for an
// injected script to do here, and `Content-Security-Policy: default-src 'none'`
// says so to the browser as well as to a reader.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { challengeKey, createChallenge, createSpentSet, verifyChallenge } from './challenge.js';

/** A form is small. Anything larger is not a form. */
const MAX_BODY_BYTES = 4096;

/** The two windows the per-address limits count over: the burst guard, and the day. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_LABEL_LENGTH = 120;

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Constant-time, and by way of a hash so the two lengths do not have to match. */
function secretMatches(presented, expected) {
  const left = crypto.createHash('sha256').update(String(presented ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-top: 0; }
  label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
  input[type=text], input[type=number] { width: 100%; box-sizing: border-box;
    padding: .5rem; font: inherit; }
  button { margin-top: 1.25rem; padding: .6rem 1rem; font: inherit; font-weight: 600; }
  code, pre { background: rgba(127,127,127,.15); border-radius: 4px; }
  code { padding: .1rem .3rem; }
  pre { padding: .75rem; overflow-x: auto; font-size: 1rem; }
  .muted { opacity: .75; font-size: .9rem; }
  .trap { position: absolute; left: -9999px; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function respond(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    // A page that shows a credential once must not be in a browser's cache, a
    // proxy's cache, or a "resend this request" prompt.
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export function createRegistrationServer({ config, store, log, now = Date.now, random }) {
  const key = challengeKey(config.registerSecret, random);
  const spent = createSpentSet();
  /** Address -> the times it asked to register, newest last. */
  const attempts = new Map();
  let server = null;
  let redirect = null;
  let ready = Promise.resolve();

  const scheme = config.allowInsecure ? 'http' : 'https';

  /**
   * Whether the address may try again now, and the attempt is recorded either way.
   *
   * Two windows over one list of times: the DAY is the limit that matters on a
   * published page, and the hour is the burst guard under it. Returns null when the
   * attempt may proceed, or else which window refused it and how long it has left --
   * "try again later" is not something a person can act on.
   */
  function limitRefusal(address) {
    const at = now();
    // Kept for one day and no longer: past that an attempt can neither bind nor
    // explain itself.
    const recent = (attempts.get(address) ?? []).filter((time) => at - time < DAY_WINDOW_MS);
    attempts.set(address, recent);

    if (config.registerPerDay > 0 && recent.length >= config.registerPerDay) {
      // The oldest attempt still counted is the one whose expiry frees the address.
      const oldest = recent[recent.length - config.registerPerDay];
      return { scope: 'day', freesInMs: Math.max(0, oldest + DAY_WINDOW_MS - at) };
    }

    const inHour = recent.filter((time) => at - time < RATE_WINDOW_MS);
    if (config.registerPerHour > 0 && inHour.length >= config.registerPerHour) {
      return { scope: 'hour', freesInMs: Math.max(0, inHour[0] + RATE_WINDOW_MS - at) };
    }

    recent.push(at);
    return null;
  }

  /** "in about three hours": the shape of answer a person can wait on. */
  function waitPhrase(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes <= 1) return 'in less than a minute';
    if (minutes < 60) return `in about ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
  }

  /** What the limits are, in the log, so the operator need not read config.js. */
  function describeLimits() {
    const parts = [];
    if (config.registerPerDay > 0) parts.push(`${config.registerPerDay} per address per day`);
    if (config.registerPerHour > 0) parts.push(`${config.registerPerHour} per address per hour`);
    return parts.length > 0 ? parts.join(', ') : 'no rate limit';
  }

  function secretFrom(url, params) {
    return params.get('secret') ?? url.searchParams.get('k') ?? '';
  }

  function secretRefused(presented) {
    if (config.registerSecret.length === 0) return false;
    return !secretMatches(presented, config.registerSecret);
  }

  /**
   * The one sentence this page repeats wherever a token is mentioned: where a token
   * is removed. It is a link and not an instruction to find the operator, because
   * the person holding the phone has no way to find one -- and an issue is the one
   * request channel a self-hosted server is guaranteed to have.
   */
  function removalsNote() {
    return 'To have a token removed, open a request at '
      + `<a href="${escapeHtml(config.issuesUrl)}">${escapeHtml(config.issuesUrl)}</a>`
      + ' and quote the device id it belongs to.';
  }

  function formBody({ question, nonce, action, label = '' }) {
    const secretField = config.registerSecret.length > 0
      ? `<label for="secret">Access code</label>
<input type="text" id="secret" name="secret" autocomplete="off" required>`
      : '';
    return `<h1>Get a device token</h1>
<p>This server draws the pages your phone reads, and only registered phones may
connect. Fill this in and it will give you a token to paste into
<strong>Settings &rarr; Server</strong> on the phone.</p>
<form method="post" action="${escapeHtml(action)}">
${secretField}
<label for="label">What is this phone?</label>
<input type="text" id="label" name="label" maxlength="${MAX_LABEL_LENGTH}"
       placeholder="my phone" value="${escapeHtml(label)}" required>

<label for="answer">What is ${escapeHtml(question)}?</label>
<input type="number" id="answer" name="answer" inputmode="numeric" required>

<div class="trap" aria-hidden="true">
  <label for="website">Website</label>
  <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
</div>

<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit">Register</button>
</form>
${config.registerPerDay > 0
      ? `<p class="muted">This address can be given ${config.registerPerDay === 1
        ? 'one token' : `${config.registerPerDay} tokens`} per day.</p>\n`
      : ''}<p class="muted">A token belongs to the first phone that uses it. If you lose the
token, you will need a new one; it is stored here only as a digest and cannot be
shown again.</p>
<p class="muted">${removalsNote()}</p>`;
  }

  // `now` and `random` are injected so the tests can drive the age window and the
  // question instead of sleeping through them. Nothing else in this file owns a
  // clock, and that is deliberate: a form whose lifetime can only be tested by
  // waiting two seconds is a form whose lifetime is not tested.
  function newForm(action) {
    const challenge = createChallenge({ key, now: now(), random });
    return formBody({ question: challenge.question, nonce: challenge.nonce, action });
  }

  function handleGet(res, url) {
    if (secretRefused(url.searchParams.get('k') ?? '')) {
      log.warn('registration page: a GET without the access code');
      respond(res, 403, page('Access code needed', '<h1>Access code needed</h1>'
        + '<p>This page needs the access code the operator gave you. Add it to the'
        + ' address as <code>?k=...</code>.</p>'));
      return;
    }
    const action = config.registerSecret.length > 0 ? `/?k=${encodeURIComponent(config.registerSecret)}` : '/';
    respond(res, 200, page('Get a device token', newForm(action)));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handlePost(req, res, url) {
    let params;
    try {
      params = new URLSearchParams(await readBody(req));
    } catch (error) {
      log.warn(`registration page: a body that is not a form (${error.message})`);
      respond(res, 413, page('Too large', '<h1>Too large</h1><p>That was not a form.</p>'));
      return;
    }

    const address = req.socket.remoteAddress ?? 'unknown';
    const refused = limitRefusal(address);
    if (refused) {
      const limit = refused.scope === 'day' ? config.registerPerDay : config.registerPerHour;
      const windowName = refused.scope === 'day' ? 'today' : 'in the last hour';
      log.warn(`registration page: ${address} is over the limit of ${limit} per ${refused.scope}; refused`);
      respond(res, 429, page('Too many', '<h1>Too many registrations</h1>'
        + `<p>This address has already been given as many tokens as it can have ${windowName}:`
        + ` ${limit}. Another one becomes available ${escapeHtml(waitPhrase(refused.freesInMs))}.</p>`
        + '<p class="muted">A token belongs to one phone and is shown once, so a token'
        + ' that was not written down is a token to ask about.</p>'
        + `<p class="muted">${removalsNote()}</p>`));
      return;
    }

    if (secretRefused(secretFrom(url, params))) {
      log.warn(`registration page: ${address} presented no or the wrong access code; refused`);
      respond(res, 403, page('Access code', '<h1>Access code missing or wrong</h1>'
        + '<p>Nothing was registered.</p>'));
      return;
    }

    // A field a person never sees and never fills. Filled means a script that read
    // the HTML and did not understand it -- which is worth refusing quietly, with
    // the same answer a successful registration gets and nothing minted, so the
    // script cannot tell that it was caught.
    if (String(params.get('website') ?? '').length > 0) {
      log.warn(`registration page: ${address} filled the honeypot; refused`);
      respond(res, 403, page('Try again', '<h1>Please try again</h1>'
        + '<p>The form was not filled in by hand. Reload the page and answer the'
        + ' question.</p>'));
      return;
    }

    const verdict = verifyChallenge({
      nonce: params.get('nonce'),
      answer: params.get('answer'),
      key,
      spent,
      now: now(),
      // The spend is what makes a second submission of the same envelope a
      // replay rather than a second guess at a number between 4 and 18.
      // See src/challenge.js for the order of the checks.
    });
    if (!verdict.ok) {
      log.warn(`registration page: ${address} failed the challenge (${verdict.reason}); refused`);
      const why = verdict.reason === 'expired' || verdict.reason === 'too-fast'
        ? 'The form had expired. Reload the page and answer the new question.'
        : 'The answer was wrong, or the form had already been used. Reload the page and'
          + ' try again.';
      respond(res, 400, page('Not registered', `<h1>Not registered</h1><p>${why}</p>`));
      return;
    }

    const label = String(params.get('label') ?? '').trim().slice(0, MAX_LABEL_LENGTH)
      || 'registered from the page';
    const { device, token } = store.add(label);

    // BEFORE the line that names the device, so no path can print it: the log's
    // scrubber is the rule, not the discipline of this call site.
    log.addSecret(token);
    log.info(`registration page: ${address} registered ${device.deviceId} (${device.label})`);

    respond(res, 200, page('Your token', `<h1>Your token</h1>
<p>Paste this into the phone now. It is shown once and cannot be shown again:</p>
<pre><code>${escapeHtml(token)}</code></pre>
<p>On the phone: <strong>Settings &rarr; Server</strong>, with</p>
<ul>
<li><em>Server address</em> &mdash; <code>${escapeHtml(config.publicUrl)}</code></li>
<li><em>Device token</em> &mdash; the token above</li>
<li><em>Draw pages on the server</em> &mdash; on</li>
</ul>
<p>Then <strong>Settings &rarr; Rendering engine &rarr; Server (Chromium
remotely)</strong>.</p>
<p class="muted">This token belongs to the first phone that uses it. Another phone
presenting it will be refused, so a token that is passed on stops working for
everybody rather than working for two.</p>
<p class="muted">${removalsNote()}</p>
<p class="muted">Registered as <code>${escapeHtml(device.label)}</code>. The id to quote
in that request is <code>${escapeHtml(device.deviceId)}</code>; the operator of this
server removes it with <code>bfwp-device release ${escapeHtml(device.deviceId)}</code>.</p>`));
  }

  function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://registration.local');
    } catch {
      respond(res, 400, page('Bad request', '<h1>Bad request</h1>'));
      return;
    }

    if (url.pathname !== '/') {
      respond(res, 404, page('Not found', '<h1>Not found</h1><p>The page is at <code>/</code>.</p>'));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      handleGet(res, url);
      return;
    }
    if (req.method === 'POST') {
      handlePost(req, res, url).catch((error) => {
        log.error('registration page: the request failed', error);
        if (!res.headersSent) respond(res, 500, page('Failed', '<h1>Failed</h1><p>Nothing was registered.</p>'));
        else res.end();
      });
      return;
    }

    respond(res, 405, page('Not allowed', '<h1>Not allowed</h1>'));
  }

  /** The host as it belongs in a url: an IPv6 literal needs brackets. */
  function hostForUrl() {
    return config.registerHost.includes(':') ? `[${config.registerHost}]` : config.registerHost;
  }

  /**
   * The listener that exists so that `ip/` works in a browser.
   *
   * It answers 301 to BFWP_REGISTER_URL and NOTHING ELSE: no form, no page, not even
   * a body that could be mistaken for one. The token is a credential and the form
   * carries it, so the form is never served over plain http -- what plain http gets
   * is one line saying where to go.
   */
  function startRedirect() {
    if (config.registerHttpPort === 0 || redirect) return redirect;
    redirect = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://registration.local');
      } catch {
        respond(res, 400, page('Bad request', '<h1>Bad request</h1>'));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // A form posted here would carry a token, or an access code, in the clear.
        log.warn(`registration page: a ${req.method} to the plain-http port; refused`);
        respond(res, 405, page('Use https', '<h1>Use https</h1><p>The page that mints tokens is at'
          + ` <a href="${escapeHtml(config.registerUrl)}">${escapeHtml(config.registerUrl)}</a>,`
          + ' over https.</p>'));
        return;
      }
      // The query string is carried over unchanged: `?k=` is how a deployment with
      // an access code is reached, and dropping it would send people to a page that
      // refuses them.
      const target = config.registerUrl + (url.search ?? '');
      const body = Buffer.from(`The page that mints device tokens is at ${target}\n`, 'utf8');
      res.writeHead(301, {
        location: target,
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end(body);
    });
    redirect.on('error', (error) => log.error('registration redirect listener error', error));
    redirect.listen(config.registerHttpPort, config.registerHost, () => {
      log.info(`registration page: plain http on port ${config.registerHttpPort} answers 301 to`
        + ` ${config.registerUrl} and serves nothing else`);
    });
    return redirect;
  }

  function start() {
    if (server) return server;
    if (config.allowInsecure) {
      server = http.createServer(handler);
    } else {
      const cert = fs.readFileSync(config.tlsCert);
      const privateKey = fs.readFileSync(config.tlsKey);
      // TLS 1.2 and up, unlike the render channel: this is an ordinary browser,
      // and the phone's settings screen will be opened in the handset's own
      // browser, which tops out at TLS 1.2 through Schannel.
      server = https.createServer({ cert, key: privateKey, minVersion: 'TLSv1.2' }, handler);
    }

    // Resolved when the socket is up, which is what lets a caller (the tests, and
    // anything that wants the port the operating system chose) know that the url
    // is real. It deliberately does NOT reject: a listener that cannot bind is
    // reported by the 'error' handler above, which has the log, and a rejected
    // promise nobody awaits would be an unhandled rejection instead.
    ready = new Promise((resolve) => server.once('listening', resolve));

    server.on('error', (error) => log.error('registration listener error', error));
    // Before the listener reports itself, because the two lines belong together.
    startRedirect();
    server.listen(config.registerPort, config.registerHost, () => {
      // The port the socket actually took, which is the configured one except when
      // the configuration said 0 and the operating system chose.
      const bound = server.address();
      const port = bound && typeof bound === 'object' ? bound.port : config.registerPort;
      log.info(`registration page on ${scheme}://${hostForUrl()}:${port} `
        // A statement about the BIND, not about reachability: in a container this
        // address is the only one a published port can reach, and what limits who
        // gets here is the publish (see docker-compose.yml). Claiming more than
        // the bind would be this line guessing about a network it cannot see.
        + `(${config.registerIsLoopback ? 'loopback only'
          : config.registerOpen
            ? 'bound on every interface, NO ACCESS CODE: open to whoever finds it'
            : 'bound on every interface, access code required'}), `
        + describeLimits());
      if (config.registerIsLoopback) {
        log.info('the registration page is loopback only: reach it with an SSH tunnel, e.g.'
          + ` ssh -L ${port}:127.0.0.1:${port} the-server`);
      }
    });
    return server;
  }

  async function stop() {
    const closing = [redirect, server].filter(Boolean);
    redirect = null;
    server = null;
    await Promise.all(closing.map((listener) => new Promise((resolve) => listener.close(resolve))));
  }

  return {
    start,
    stop,
    /** Resolves once the socket is up. See start(). */
    get ready() {
      return ready;
    },
    get url() {
      const address = server?.address();
      const port = address && typeof address === 'object' ? address.port : config.registerPort;
      return `${scheme}://${hostForUrl()}:${port}/`;
    },
    /** The plain-http listener, or null when the deployment did not ask for one. */
    get redirectUrl() {
      const address = redirect?.address();
      if (!address || typeof address !== 'object') return null;
      return `http://${hostForUrl()}:${address.port}/`;
    },
    /** Read by tests, and by nothing that serves a page. */
    get pendingChallenges() {
      return spent.size;
    },
  };
}

export { MAX_BODY_BYTES, RATE_WINDOW_MS, DAY_WINDOW_MS };
