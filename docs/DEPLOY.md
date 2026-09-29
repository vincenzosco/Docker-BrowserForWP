# Deploying

## What you need

- A host with **at least 2 GB of RAM** and a couple of cores. Each connected
  device is a Chromium page; the default `BFWP_MAX_SESSIONS` of 16 assumes more
  memory than 2 GB, so lower it if you are small. `docker-compose.yml` limits the
  container to 2 GB and that limit is real.
- **A domain and a certificate from a real CA.** The phone validates the chain
  and the host name before it sends a byte, so a self-signed certificate is not a
  shortcut to test with -- it is a wall. `certbot certonly --standalone -d
  render.example.com`, then copy `fullchain.pem` and `privkey.pem` into `tls/`.
- **Open port 8443** (and 8444 if you enable audio) inbound.
- **Docker with the compose plugin.**

## Build arguments

| Argument | Default | Notes |
| --- | --- | --- |
| `PLAYWRIGHT_TAG` | `v1.49.1-jammy` | Must match the `playwright` range in `package.json`. See below. |
| `WITH_AUDIO` | `0` | Adds ffmpeg and PulseAudio, roughly doubling the image. |

Checking the tag against the package: the base image ships the browsers, and the
`playwright` npm package has to be a version that knows how to drive them. Run

```bash
docker run --rm mcr.microsoft.com/playwright:v1.49.1-jammy npx playwright --version
```

and make sure the printed version satisfies the range in `package.json`.

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

Back up the `devices` volume. Losing it means re-registering every phone, and a
device that is in nobody's registry is a device nobody can revoke.

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
| `Could not start a browser session` | Playwright was installed without a browser, or the image tag and the package version disagree. |
