# The page at the root of the address, and one token per address per day

Status: in progress. Server repository (`Docker-BrowserForWP`), Round 2 of the
registration page.

## What was asked

Three things, in the user's words: the page must be reachable at **the root of the
IP** (`ip/` in a browser, not `ip:8445/?k=...`), the rate limit must be **one token
per address per day**, and — asked as a question — whether a cheaper engine could
be used.

## What was measured first, because it decides the design

| measurement | value |
| --- | --- |
| the address the page sees for a request through the tunnel/host | `172.18.0.1` (the Docker bridge gateway) |
| free memory on `docker1` | 441 MB available of 953 MB |
| `BFWP_MAX_SESSIONS` on `docker1` | **512** — a number this box cannot hold |
| RSS of a 480x800 page of example.com, Chromium with the flags in `src/browser.js` | 358 MiB in 6 processes |
| the same with `--single-process --renderer-process-limit=1 --js-flags=--max-old-space-size=128` | **213 MiB in 3 processes** |
| the same under Playwright's WebKit | 344 MiB in 4 processes |
| the same under Playwright's Firefox | does not launch (180 s timeout) |

So: every client that arrives through a published port reached over loopback looks
like one address, which turns a per-address limit into a global one. This has to be
measured again for a *public* client before the daily limit can be claimed to work,
and that measurement is part of the verification below.

## Changes

1. **`BFWP_REGISTER_HTTP_PORT`** (default `0`, off): a plain-HTTP listener whose
   only answer is a `301` to `BFWP_REGISTER_URL`. The page itself never speaks
   plain HTTP, because the thing it hands over is a credential and the form posts
   it. `BFWP_REGISTER_URL` (e.g. `https://34.132.106.149/`) is required when that
   port is set, and must be `https://` unless `BFWP_ALLOW_INSECURE=1`.
2. **`BFWP_REGISTER_PER_DAY`** (default `1`): the daily window beside the existing
   hourly burst guard. The refusal says which window was hit and roughly when it
   frees, because "try again later" is not an answer a person can act on.
3. **`BFWP_REGISTER_OPEN`** (default `0`): the page takes no access code, so the
   people holding the phones can ask for a token themselves. Refused together with
   a loopback bind (a page nobody can reach) and together with a secret (two
   contradictory answers to the same question).
4. **The compose file** publishes the page three ways, all on one bind IP: `8445`
   for the tunnel, `443` for the page at the root, `80` for the redirect. The host
   ports are mapped to the container's unprivileged ones (`8080`, `8445`) because
   the server runs as uid 1000 and a privileged bind would need a capability the
   image deliberately does not have.
5. **`BFWP_MAX_SESSIONS=2`** on `docker1`, from the measurement above: 512 was a
   number nothing on this box could ever honour.

## What this costs, stated rather than hidden

An open page that mints credentials is what the operator asked for, and it makes
the render capacity reachable by whoever finds the page: one token per address per
day, a challenge under every form, and two sessions on a 1 GB VM. `docs/SECURITY.md`
and the README say so, and the page goes back behind the access code — or back to
loopback — with one variable.

## Verification

* `npm test` (the new tests: the daily window frees after 24 h, the second
  submission from one address is refused with the window named, the redirect
  listener answers `301` and never serves the form, the three config refusals).
* On `docker1`: `curl -I http://<ip>/` → `301`; `curl https://<ip>/` → the form
  without an access-code field; a POST from this Mac solves the challenge and gets
  a token, and the container's log names **this Mac's address** — the measurement
  the per-address limit depends on.
* The deployment still renders: `bin/bfwp-smoke.js --verify` from outside, and the
  same token offered by a second device id is refused (`TOKEN_BOUND`).
