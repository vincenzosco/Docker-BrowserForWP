# Deploying

## What you need

- A host with **at least 2 GB of RAM** and a couple of cores. Each connected
  device is a Chromium page; the default `BFWP_MAX_SESSIONS` of 16 assumes more
  memory than 2 GB, so lower it if you are small. `docker-compose.yml` limits the
  container to 2 GB and that limit is real.
- **A domain and a certificate from a real CA.** The phone validates the chain
  and the host name before it sends a byte, so a self-signed certificate is not a
  shortcut to test with -- it is a wall. `certbot certonly --standalone -d
  render.example.com`, then copy `fullchain.pem` and `privkey.pem` into `tls/`,
  **and make them readable by the container's user**:

  ```bash
  sudo chown 1000:1000 tls/fullchain.pem tls/privkey.pem
  sudo chmod 600 tls/privkey.pem
  sudo chmod 644 tls/fullchain.pem
  ```

  The container runs as `pwuser`, uid 1000, and a bind mount keeps the HOST's
  numeric owner: certbot writes the key `0600` for `root`, so without this the
  server starts, logs `could not listen: EACCES: permission denied, open
  '/etc/bfwp/tls/privkey.pem'` and restarts forever. 0600 is kept on purpose --
  the key has to be readable by uid 1000, not by everybody.
- **Open port 8443** (and 8444 if you enable audio) inbound.
- **Docker with the compose plugin.**

## Build arguments

| Argument | Default | Notes |
| --- | --- | --- |
| `PLAYWRIGHT_TAG` | `v1.49.1-jammy` | Must match `playwright` in `package.json`, which is pinned to an exact version. The build checks the pair and REFUSES to produce the image if they differ. |
| `WITH_AUDIO` | `0` | Adds ffmpeg and PulseAudio, roughly doubling the image. |

Checking the tag against the package: the base image ships the browsers, and the
`playwright` npm package has to be a version that knows how to drive them. Run

```bash
docker run --rm mcr.microsoft.com/playwright:v1.49.1-jammy npx playwright --version
```

and make sure the printed version is the version in `package.json`.

You no longer have to remember this: the build installs the package, reads the
version back and fails when it does not equal the tag, because the failure it
prevents is invisible at build time and specific in production. An open range
("any 1.x") once resolved to a version years ahead of the tag, and the server
built, started, accepted a device, sealed frames -- and then could not launch a
browser at all:

```
ERROR could not start a browser session: browserType.launch: Executable doesn't
  exist at /ms-playwright/chromium_headless_shell-1243/chrome-headless-shell
Looks like Playwright was just updated to 1.63.0. Please update docker image as well.
```

## First deployment

```bash
export BFWP_PUBLIC_URL=https://render.example.com:8443
export BFWP_SERVER_NAME="render.example.com"
docker compose up -d --build
docker compose logs -f render
```

You should see:

```
INFO BrowserForWP render server starting (render.example.com)
WARN no devices are registered in /var/lib/bfwp/devices.json. Nobody can connect until you run:
WARN   npm run device -- add "my phone"
INFO listening on 0.0.0.0:8443 (TLS 1.3 only), 16 session(s) allowed
INFO audio is off; a page cannot be heard through this server
```

## Registering a device

```bash
docker compose exec render node bin/bfwp-device.js add "Vincenzo's Lumia"
```

It prints a device id and a token, and the token is shown **once**. Only its
SHA-256 is stored, so it is not recoverable. Put both into the phone.

Managing devices:

```bash
docker compose exec render node bin/bfwp-device.js list
docker compose exec render node bin/bfwp-device.js disable <deviceId>
docker compose exec render node bin/bfwp-device.js enable  <deviceId>
docker compose exec render node bin/bfwp-device.js remove  <deviceId>
```

`disable` is the one to reach for when a phone is lost: it refuses the device
without forgetting it, so it can be brought back if it turns up.

The server re-reads the registry whenever the file changes, so **no restart is
needed** after `add`, `disable`, `enable` or `remove` -- it logs `device registry
reloaded: 2 device(s)` when it notices. That is not only a convenience: a `disable`
the running server could not see would be a lost phone that still connects.

Back up the `devices` volume. Losing it means re-registering every phone, and a
device that is in nobody's registry is a device nobody can revoke.

## Verifying a deployment

`bin/bfwp-smoke.js` is a client. It is the only thing in this repository that
exercises the whole path against a live server -- TLS 1.3, the handshake, the
sealed frames, a real page drawn by a real Chromium, a tap that reaches it and the
answer that comes back:

```bash
docker compose exec render node bin/bfwp-smoke.js \
  --host 127.0.0.1 --port 8443 \
  --device <device id> --token <token> \
  --focus-url http://<host-address>:8080/
```

From another machine it takes `--host` and `--port` of the server, and it does not
validate the certificate unless you pass `--verify` -- the phone is the client that
validates, and being able to diagnose a server behind a self-signed certificate is
worth more than the check.

Ten checks. Nine of them pass or fail on their own; the tenth is silence.

`--focus-url` needs a page whose layout is known, because a tap is a pair of
coordinates and a public homepage is a guess. Serve this and the coordinates in the
tool's header are the ones to use:

```bash
mkdir -p /tmp/bfwp-testpage && cat > /tmp/bfwp-testpage/index.html <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><title>bfwp smoke</title></head>
<body style="margin:0;font:16px sans-serif">
  <input id="name" type="text" style="position:absolute;left:20px;top:20px;width:200px;height:40px">
  <button id="go" type="button" style="position:absolute;left:20px;top:80px;width:200px;height:40px">Not a text field</button>
  <p style="position:absolute;left:20px;top:140px;width:300px">plain text</p>
</body></html>
HTML
(cd /tmp/bfwp-testpage && python3 -m http.server 8080)
```

Chromium runs inside the container, so the address has to be one the CONTAINER can
reach: the host's own address, not `127.0.0.1`. Without `--focus-url` the four
FOCUS checks report SKIPPED, never passed.

A run of a working deployment ends like this:

```
  ✓ the server accepts this device — docker1, audio off
  ✓ a sealed NAVIGATE produces a FRAME — landed on https://example.com/, 1 tile(s), 480x800, 2533 bytes
  ✓ the frame is a JPEG
  ✓ the ACK releases the next frame — seq 8
  ✓ the focus page draws — http://10.128.0.3:8080/
  ✓ the page's own focus on load is reported — editable=false
  ✓ a tap on a text field reports an editable focus — editable=true
  ✓ typing changes the page — a new frame, seq 18
  ✓ Tab moves the answer with the focus — editable=false
  ✓ an unchanged answer stays quiet — nothing for 2.5 s, as the protocol promises

10/10 checks passed.
```

The tool's own first two versions reported a HEALTHY server as broken: once because
it acknowledged a frame and then treated the next one as unacknowledged, so the
screencast stayed stopped and it waited for a picture it had already been sent; once
because it took any frame as proof that the page it had asked for was in front, and
then tapped the page it was leaving. Both mistakes are written into the file. A
verification tool that lies in the pessimistic direction wastes as much of an
afternoon as one that lies in the optimistic one.

## Configuration

Every setting comes from the environment. `src/config.js` validates all of them
at startup and refuses to start on a bad value, so a typo fails loudly instead of
behaving strangely later.

| Variable | Default | What it does |
| --- | --- | --- |
| `BFWP_PORT` | `8443` | The render channel. |
| `BFWP_HOST` | `0.0.0.0` | Bind address. |
| `BFWP_PUBLIC_URL` | placeholder | The https url the phones use. **Set this.** It is what the audio URL is built from. |
| `BFWP_SERVER_NAME` | `BrowserForWP render server` | Shown to the client. |
| `BFWP_TLS_CERT` / `BFWP_TLS_KEY` | `/etc/bfwp/tls/...` | PEM paths. |
| `BFWP_DEVICES_FILE` | `/var/lib/bfwp/devices.json` | The registry. |
| `BFWP_MAX_SESSIONS` | `16` | Connected devices at once. This is your memory ceiling. |
| `BFWP_FRAME_QUALITY` | `60` | JPEG quality, 1..95. |
| `BFWP_MAX_FRAME_BYTES` | `2097152` | Refuse a larger frame before allocating. |
| `BFWP_SESSION_IDLE_MS` | `120000` | Hang up on a device that has gone quiet. |
| `BFWP_VIEWPORT_WIDTH` / `_HEIGHT` | `480` / `800` | Default viewport until the client declares one. |
| `BFWP_DEVICE_PIXEL_RATIO` | `2` | Default device scale factor, 1..4. |
| `BFWP_PAGE_TIMEOUT_MS` | `30000` | Navigation timeout. |
| `BFWP_BLOCK_ADS` | `true` | Block a small host list before navigation. |
| `BFWP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `BFWP_AUDIO_ENABLED` | `false` | See below. |
| `BFWP_AUDIO_FIFO` | `/run/bfwp/audio.mp3` | The capture source for audio. |
| `BFWP_ALLOW_INSECURE` | `false` | Plain TCP. Refuses to combine with `NODE_ENV=production`. |

## Audio, which is the part that is not finished

This is the honest state of it. The delivery half is built and tested; the
capture half is a manual step, because it needs a sound card and this repository
was written on a machine that has none.

A headless Chromium has no audio device, so the sound never leaves the browser
unless something gives it one:

1. Build with `WITH_AUDIO=1` to get ffmpeg and PulseAudio.
2. Inside the container, start PulseAudio with a null sink:

   ```bash
   pulseaudio --start --exit-idle-time=-1
   pactl load-module module-null-sink sink_name=bfwp \
     sink_properties=device.description=bfwp
   pactl set-default-sink bfwp
   ```

3. Launch Chromium against that sink. Chromium needs to actually play to it, so
   the `--mute-audio` flag in `src/browser.js` has to come off when audio is
   enabled.
4. Capture the sink's monitor and encode it into the FIFO:

   ```bash
   ffmpeg -nostdin -f pulse -i bfwp.monitor \
     -ac 2 -ar 44100 -b:a 96k -f mp3 -y /run/bfwp/audio.mp3
   ```

5. Set `BFWP_AUDIO_ENABLED=1` and publish port 8444.

Then a session is told audio is available, and its `AUDIO` message carries a
presigned url that the phone plays with `MediaElement`.

**Why the phone uses MediaElement rather than the custom TLS stack:** the client's
TLS 1.3 implementation is a byte stream designed for HTTP, and it cannot feed
`MediaElement`. So the audio endpoint is ordinary HTTPS over Schannel, which
means it accepts TLS 1.2 -- a deliberate asymmetry between the two listeners, and
the only place in this project where anything older than 1.3 is spoken.

## Behind a reverse proxy

You can, and if you do, know two things:

- The proxy must pass the connection through rather than terminating and
  re-originating it in a way that loses the framing. A plain TCP/SNI passthrough
  is the safe configuration. Terminating TLS and forwarding works too, and the
  sealed frame layer is what keeps the content unreadable to the proxy.
- `BFWP_PUBLIC_URL` still has to be the url the phones reach.

## Sizing

| Devices | Rough RAM | Notes |
| --- | --- | --- |
| 1-2 | 700 MB | A single Chromium process plus the Node process. |
| 4-8 | 1.5 GB | Raise `shm_size` with it. |
| 16 | 2.5 GB+ | The compose default; raise the memory limit too, or lower `BFWP_MAX_SESSIONS`. |

**Measured, not estimated:** one live session with a page in it held the container
at **231 MiB peak** on a 953 MB `e2-micro`, which is 2-3 devices and not the 16 the
default allows. Lower `BFWP_MAX_SESSIONS` to match the host rather than the
aspiration -- a server that accepts a session it cannot hold fails at the browser
launch, which the phone sees as a page that never arrives.

Scaling out means more instances behind a TCP-aware load balancer, with the
registry shared or duplicated by hand. The protocol is one connection per device
for its whole life, so there is no per-request affinity to arrange -- but a
device that reconnects can land on a different instance, and it will get a fresh
page when it does.

## Operating it

- `docker compose logs -f render` is the whole observability story so far. Tokens
  are scrubbed from it; device ids, session ids and refusal reasons are not.
- The healthcheck opens a TCP connection and hangs up. It deliberately does not
  complete a TLS handshake, because that would need a device token and a
  healthcheck that breaks when a credential rotates reports a healthy server as
  dead.
- Upgrading is `docker compose up -d --build`. The wire format is versioned in
  the header, and a mismatched phone is refused with code 1 and both version
  numbers named rather than being fed frames it cannot read.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The phone says the certificate is not valid | It is self-signed, or the name does not match `BFWP_PUBLIC_URL`. |
| The phone connects and immediately gets code 1 | Protocol version mismatch: rebuild one side. |
| Code 3 | The device id is not in this server's registry. `bfwp-device list`. |
| Code 2 | The token is wrong, or was copied with a trailing space. |
| Code 6 | `BFWP_MAX_SESSIONS` is reached. Check for devices holding idle sessions. |
| The screen goes black after the first frame | A frame was never acknowledged, so the tap stayed stopped. The client must `ACK`. |
| Chromium dies with no error | `shm_size` is too small. 1 GB, not the 64 MB default. |
| `Could not start a browser session` | Playwright was installed without a browser, or the image tag and the package version disagree. The build refuses that pair now, so this means an image built before that check existed: rebuild. |
| `could not listen: EACCES ... privkey.pem` | The mounted key belongs to the host user, not to uid 1000. See "What you need". |
| Code 3 immediately after `bfwp-device add` | The server is an image old enough to read the registry once at startup. Rebuild it; the current one reloads and logs it. |
