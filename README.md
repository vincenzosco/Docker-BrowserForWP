# Docker-BrowserForWP

The render server for [BrowserForWP](https://github.com/vincenzosco/BrowserForWP).

It runs a real Chromium on a machine that has one, draws the page there, and
streams what it drew to a Windows Phone 8.1 handset, which sends back taps,
scrolls and keystrokes. To the phone it looks like a browser. It is not: the
phone is a viewer with an input device, and this server is the browser.

## Why this exists

Windows Phone 8.1 cannot host a modern engine, and that is a property of the
operating system rather than a thing to work around:

- The AppContainer forbids writable-and-executable memory, so there is no JIT.
- No third-party engine can be deployed to the platform at all.
- The system engine is Trident, frozen at IE11.

The old phones that shipped modern pages anyway -- Opera Mini, the cloud
browsers -- did it exactly this way, by rendering somewhere else. There is no
other route. What this buys is everything the handset cannot do itself: real
JavaScript, real CSS, real HTML5, video, and the audio a headless Chromium can be
coaxed into producing.

## Read this before you deploy it

**This server sees everything.** TLS terminates here, so the page a user reads --
and every password they type into it -- is plaintext in this process, in this
machine's memory. That is not a bug or a misconfiguration; it is what
remote rendering IS. Everything below is about doing it carefully, not about
making that untrue.

If you are deploying this for other people, tell them. If you are using somebody
else's server, know that they can read your traffic. `docs/SECURITY.md` states
this properly, including what the sealing layer does and does not protect.

## How it fits together

```
   Windows Phone 8.1 app                     this server
  ┌──────────────────────┐                 ┌───────────────────────────┐
  │  shell: address bar, │                 │  TLS 1.3 listener         │
  │  tabs, history       │                 │    ↓                      │
  │         ↓            │  TLS 1.3        │  sealed frames            │
  │  IBrowserEngine      │◄───────────────►│    ↓                      │
  │   (RemoteEngine)     │  over one TCP   │  Session (state machine)  │
  │         ↓            │  connection     │    ↓                      │
  │  Image in ContentHost│                 │  Playwright → Chromium    │
  │  input events out ───┼────────────────►│  screencast frames ───────┼──►
  └──────────────────────┘                 └───────────────────────────┘
```

The phone never fetches the page. It sends the URL, and receives JPEG frames.
Nothing about the page -- its HTML, its scripts, its cookies -- is on the device.

One consequence worth naming, because it is the reason a message exists for it:
the phone is holding a picture, so it cannot see where the page's focus is. It
asks, and the server answers with `FOCUS` (`0x27`): one byte, sent when the answer
changes, meaning *the focused element takes text*. That single byte is what the
handset raises its soft keyboard on, so the keyboard no longer covers half the
page on every tap. `docs/PROTOCOL.md` has the field and the rules.

## Quick start

```bash
git clone https://github.com/vincenzosco/Docker-BrowserForWP
cd Docker-BrowserForWP

# 1. A certificate. The phone validates the chain and the name before it sends a
#    byte, so this must be a real one -- and it can be for a NAME or for the bare
#    IP: Let's Encrypt issues for addresses too, under its 6-day `shortlived`
#    profile. See docs/DEPLOY.md, "HTTPS without a domain", which also installs
#    the renewal timer such a certificate cannot outlive.
mkdir -p tls && cp /etc/letsencrypt/live/render.example.com/fullchain.pem tls/
cp /etc/letsencrypt/live/render.example.com/privkey.pem tls/

# 2. Configure and start.
export BFWP_PUBLIC_URL=https://render.example.com:8443
docker compose up -d --build

# 3. Register the phone and copy the token it prints. It is shown ONCE.
docker compose exec render node bin/bfwp-device.js add "my phone"

# 4. On the phone: Settings → Rendering engine → this server, and paste the
#    url and the token.
```

The client ships pointing at the project's own hosted server, so the address
field already has something in it: **replace it with yours** in step 4 (or leave
it, if you are the one running the hosted one). Until a token is pasted, the
phone draws pages with its own engine and says why, so a self-hosted server that
is not registered yet costs nothing but a missing picture.

Running it without Docker, for development:

```bash
npm install
BFWP_ALLOW_INSECURE=1 BFWP_PORT=8443 npm start
```

`BFWP_ALLOW_INSECURE=1` speaks plain TCP. It exists for a local loopback test and
refuses to combine with `NODE_ENV=production`.

## The protocol

One TCP connection per device, TLS 1.3 only, carrying length-prefixed binary
frames. Every frame after the handshake is sealed with AES-256-GCM under a key
derived from the device token, so a TLS terminator in front of this process still
cannot read a page.

| Layer | What it is |
| --- | --- |
| Transport | TLS 1.3, `TLS_AES_128_GCM_SHA256` / `TLS_CHACHA20_POLY1305_SHA256`, nothing older |
| Framing | 16-byte header, big-endian, `length` authenticated as AAD |
| Sealing | HKDF-SHA256 from the device token, one key per direction, per-frame AEAD |
| Messages | 24 types, binary, no JSON and no base64 anywhere |

`docs/PROTOCOL.md` is the field-by-field reference. `protocol/vectors.json` is
the same protocol as concrete bytes, and it is what the phone's VB
re-implementation is checked against.

## Tests

```bash
npm test
```

155 tests, no network, no Chromium, no Docker. They cover the wire format, the
key schedule against the RFC 5869 vectors, sealing against tampering, replay and
reordering, the device registry, the configuration refusals, the log scrubber,
the session state machine, and -- with real sockets -- the listener, the TLS 1.3
configuration and the frame backpressure.

Three things are deliberately NOT tested here, and `docs/DEPLOY.md` says how to
exercise each by hand: the Chromium paths (they need a browser), the audio
capture (it needs a virtual sound device), and the container image (it needs
Docker). This repository was written on a machine with none of the three.

`bin/bfwp-smoke.js` is what covers the first and the third instead: a real client
that dials a real deployment, completes TLS 1.3, navigates, receives a JPEG from
Chromium, taps a text field and checks the answer. It says `10/10` on a working
server, and it is the only thing in here that has ever spoken to one.

## Honest limits

- **The handset has never spoken to a deployment.** The server has: it runs on a
  1 GB `e2-micro` with a publicly trusted certificate for its own address and
  port 8443 open, and `bin/bfwp-smoke.js` completes a full session against it --
  TLS 1.3 with the chain verified, a real frame, and a tap that reports where the
  page's focus is. What is still unrun is the client's whole device-side half: the
  picture, the soft keyboard, the audio element, and the two things a phone must
  do before any of it -- trust one of the ISRG roots the IP chain ends at, and
  match an address that appears in the certificate as an `iPAddress` entry rather
  than a `dNSName`. The client's TLS stack reads only `dNSName` at the time of
  writing, from a 2014-era platform whose root store we cannot inspect from here.
  See `docs/DEPLOY.md` and the verification table in the client repository.
- **One page held 231 MiB peak** in its container, measured on that host. The
  compose default of 16 sessions assumes 2.5 GB and up; on a small machine set
  `BFWP_MAX_SESSIONS` to what the box can actually hold.
- **Audio is the least finished part.** Headless Chromium has no audio device,
  so "the phone hears the sound" needs PulseAudio and ffmpeg inside the image and
  a capture FIFO. The delivery half is built and tested; the capture half is a
  documented manual step, because it cannot be tested without a sound card.
- **Every frame is a whole viewport.** Chromium's screencast hands back the full
  frame, so the protocol carries a tile list with one tile in it. Sending only
  the changed rectangles is designed for and not yet implemented.
- **One page per device, and no session survives a reconnect.** A dropped
  connection loses the page's scroll position and its form state.
- **Bandwidth is real.** A JPEG per viewport change on 3G is slow. The frame
  acknowledgement exists so the server never queues frames at a slow reader, but
  it cannot make the link faster.
- **`0.1.0`.** The wire format is frozen by vectors and can still change; the
  vectors are how a change is noticed rather than how it is prevented.

## Licence

MIT. See `LICENSE`.
