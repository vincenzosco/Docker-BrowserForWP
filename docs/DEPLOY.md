# Deploying

## What you need

- A host with **at least 2 GB of RAM** and a couple of cores. Each connected
  device is a Chromium page; the default `BFWP_MAX_SESSIONS` of 16 assumes more
  memory than 2 GB, so lower it if you are small. `docker-compose.yml` limits the
  container to 2 GB and that limit is real.
- **A certificate from a real CA, for the name or the address phones use.** The
  phone validates the chain *and* the name before it sends a byte, so a
  self-signed certificate is not a shortcut to test with -- it is a wall. Two
  ways to get one:
  * **with a domain**: `certbot certonly --standalone -d render.example.com`,
    then copy `fullchain.pem` and `privkey.pem` into `tls/`;
  * **with the bare IP, no domain**: Let's Encrypt issues for IP addresses under
    its `shortlived` profile, a **six-day** certificate renewed by a timer. See
    *HTTPS without a domain* below, which is what the live deployment does.

  Leave the files owned by root at `0600`, which is how certbot writes them: the
  container stages its own readable copy at startup and drops privileges, so a
  renewal that rewrites the key cannot break the deployment. `bin/entrypoint.sh`
  has the whole story, and `BFWP_TLS_CERT` / `BFWP_TLS_KEY` still name where the
  originals are.
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
WARN   docker compose exec render bin/bfwp-device.sh add "my phone"
WARN   (or `npm run device -- add` outside a container, where you already are the right user)
INFO listening on 0.0.0.0:8443 (TLS 1.3 only), 16 session(s) allowed
INFO audio is off; a page cannot be heard through this server
```

## HTTPS without a domain

Let's Encrypt began issuing certificates for **IP addresses** in January 2026, so
a deployment can be addressed the way this one is -- `BFWP_PUBLIC_URL` holds an
address, not a name -- and still present a chain a stranger's client validates.
Three things are required, and each one is why a command below looks the way it
does.

**1. certbot 5.4 or newer.** `--ip-address` arrived in 5.3 and the webroot
support for addresses in 5.4; Ubuntu 24.04's archive predates both, so certbot
comes from a virtualenv:

```bash
sudo apt-get install -y python3-venv
sudo python3 -m venv /opt/certbot
sudo /opt/certbot/bin/pip install --upgrade pip certbot
/opt/certbot/bin/certbot --version    # 5.4 or newer
```

**2. The `shortlived` profile.** It is the only profile that issues for an IP
address, and it is why these certificates live **160 hours** (six days and a
half). This is not a fire-and-forget certificate: the renewal timer is part of
the installation, not an improvement to it. The profile also issues **no common
name** -- the address appears only in the `subjectAltName`, as an `iPAddress`
entry -- which is what a client has to match against.

**3. Port 80 reachable from the Internet while issuing**, because HTTP-01 is the
only challenge available for an address. Nothing has to serve on it afterwards:
`--standalone` binds it only to answer the challenge.

```bash
IP=203.0.113.7        # the address in BFWP_PUBLIC_URL, without the scheme

# Always rehearse against staging first. The staging server has far higher rate
# limits, which is the entire point of it.
sudo /opt/certbot/bin/certbot certonly --staging --standalone \
  --preferred-profile shortlived --ip-address "$IP" --cert-name "$IP" \
  --non-interactive --agree-tos --register-unsafely-without-email

# ...then the real one.
sudo /opt/certbot/bin/certbot certonly --standalone \
  --preferred-profile shortlived --ip-address "$IP" --cert-name "$IP" \
  --non-interactive --agree-tos --register-unsafely-without-email
```

> **The staging certificate is a trap, and it is quiet.** Run the staging command
> and then the production one with the same `--cert-name`, and certbot answers
> *"Certificate not yet due for renewal; no action taken"*: exit code 0, no
> change to the file, and a deployment still serving `(STAGING)` issuers that no
> phone trusts. Check the issuer of what you are about to serve, or delete the
> staging lineage (`certbot delete --cert-name "$IP"`) before requesting the real
> one. Both were measured here.

### Renewing it

The pair has to be copied into `tls/` and the container restarted after every
renewal, because the server reads the certificate once, at startup.
`bin/bfwp-renew-hook.sh` does both, waits for the container's own health check,
and exits non-zero if the server did not come back -- a hook that swallowed the
failure would leave a healthy-looking server with a stale certificate:

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 0755 bin/bfwp-renew-hook.sh \
  /etc/letsencrypt/renewal-hooks/deploy/bfwp-renew-hook.sh
sudo install -m 0644 deploy/certbot-renew.service deploy/certbot-renew.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer
systemctl list-timers certbot-renew.timer
```

The hook defaults to `CERT_NAME=203.0.113.7` and
`REPO=/home/vincenzo/Docker-BrowserForWP`; both, plus the compose service name,
can be set in `/etc/default/bfwp-render`. Rehearse the whole loop rather than
waiting six days for it:

```bash
sudo systemctl start certbot-renew.service
journalctl -u certbot-renew.service -n 20 --no-pager
```

Two rate limits bound this arrangement, and the second is the one to respect:
**50 certificates per IPv4 address every 7 days**, and **5 per exact set of
identifiers every 7 days** (refilling at one per 34 hours) -- with a single
identifier, "the exact set" is that address. A six-day certificate renewed at
roughly two thirds of its life is two or three issuances a week, inside the five.
Certbot 5.x renews through ACME Renewal Information, and ARI renewals are exempt
from every rate limit; the way to lose that exemption is to delete
`/etc/letsencrypt` "to start clean", which is exactly the *common cause* Let's
Encrypt names for this limit.

### What a phone has to do with it

Serving an IP certificate is half the arrangement; the other half is a client
that matches it. Two facts, both checkable from the certificate:

* the chain presented is the leaf, `YE1`, `ISRG Root YE`, and **`ISRG Root X2`
  cross-signed by `ISRG Root X1`** -- so a device needs one of those two roots in
  its trust store, and a 2014-era phone that stopped receiving root updates will
  not have been issued either by us;
* the address is in the `subjectAltName` as an `iPAddress` entry and nowhere
  else, so a client whose hostname matching reads only `dNSName` entries rejects
  this certificate even though the chain validates. That is not a rare mistake --
  OpenSSL's own `s_client -verify_hostname` has it, reported here on the first
  attempt -- and `BrowserForWP`'s TLS stack had it too, until commit `d36a07d` in
  the client repository added `iPAddress` matching, verified against this very
  server (`tools/proto/tls13.mjs 34.132.106.149 8443 --handshake-only`).

## Registering a device

```bash
docker compose exec render bin/bfwp-device.sh add "Vincenzo's Lumia"
```

The wrapper and not `node bin/bfwp-device.js` directly: the image starts as root
(so `bin/entrypoint.sh` can stage the certificate and drop), which means a bare
`exec` is a root process writing a `0600` registry that the server, as `pwuser`,
could then neither read nor rewrite. Use `bin/bfwp-device.sh` and the ownership
stays right.

It prints a device id and a token, and the token is shown **once**. Only its
SHA-256 is stored, so it is not recoverable. Put both into the phone.

Managing devices:

```bash
docker compose exec render bin/bfwp-device.sh list
docker compose exec render bin/bfwp-device.sh disable <deviceId>
docker compose exec render bin/bfwp-device.sh enable  <deviceId>
docker compose exec render bin/bfwp-device.sh remove  <deviceId>
```

`disable` is the one to reach for when a phone is lost: it refuses the device
without forgetting it, so it can be brought back if it turns up.

The server re-reads the registry whenever the file changes, so **no restart is
needed** after `add`, `disable`, `enable` or `remove` -- it logs `device registry
reloaded: 2 device(s)` when it notices. That is not only a convenience: a `disable`
the running server could not see would be a lost phone that still connects.

Back up the `devices` volume. Losing it means re-registering every phone, and a
device that is in nobody's registry is a device nobody can revoke.

### The registration page

`bfwp-device add` needs a shell on the server, and the people who need a token are
the people holding the phones. So the server also serves a page, on
`BFWP_REGISTER_PORT` (default `8445`), where somebody fills in a form and is given
a token once -- the same single-use digest the CLI mints, with no account, no
password and no reset flow.

**In Docker it is published on the HOST'S LOOPBACK** -- `127.0.0.1:8445:8445` in
the compose file, which is what makes a tunnel work rather than a port on the
network:

```bash
# from the machine you are sitting at
gcloud compute ssh docker1 -- -N -L 8445:127.0.0.1:8445
# then open http://127.0.0.1:8445/?k=<the access code>
```

**The access code is required, and the reason is a Docker detail worth knowing.**
A published port is forwarded to the container's own address, never to the
container's loopback, so a page bound to `127.0.0.1` inside the container would be
reachable from nowhere at all. The container therefore binds `0.0.0.0`
(`BFWP_REGISTER_HOST` in the compose file), and `src/config.js` refuses that
without a code -- which is the rule doing its job rather than a nuisance: what
limits who reaches the page is the publish above, and the code is what makes
changing that publish a safe edit instead of an incident.

Set it once, in `.env`:

```bash
BFWP_REGISTER_SECRET="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
```

What the container logs then says what it is bound to and nothing more, because a
process inside a container cannot see how its port was published:

```
INFO registration page on http://0.0.0.0:8445 (bound on every interface, access code required), 3 per address per hour
```

Every request must then carry it, and the operator shares the link
(`https://host:8445/?k=<the code>`) with the people who should have a token.

**To let people reach it themselves**, one more variable:

```bash
BFWP_REGISTER_BIND_IP=0.0.0.0        # .env, plus the port in the host's firewall
```

and the page is on the internet behind its access code, its bot check and its
per-address limit. What is NOT recommended is removing the code at the same time:
the code is cheap, and the page mints credentials.

The form is behind a bot check: an arithmetic question whose answer is inside a
signed, single-use, expiring envelope, a field a person never fills, a minimum
time on the form, and `BFWP_REGISTER_PER_HOUR` registrations per address per hour
(`3` by default; `0` disables the limit). That stops a script that fills forms. It
does not stop a person solving the question by hand, and nothing here pretends it
does -- the gate that matters is the publish above (and, outside Docker, the
loopback default), together with the access code.

### A token belongs to one phone

A token is bound to the **first** device that uses it, and the binding is written
to the registry immediately. A second phone presenting it is refused with
`TOKEN_BOUND`, and the refused attempt does not move the binding -- so a token
copied to another handset is refused rather than shared. `bfwp-device list` shows
who holds what:

```
enabled   03a74ae5-...  2026-09-29T16:48:50.653Z  claimed by 4f2b...  my phone
```

Replacing a phone therefore means releasing the token first -- and this is the one
way a token ever moves:

```bash
docker compose exec render bin/bfwp-device.sh release <deviceId>
```

Until it is claimed, a row reads `unbound`, and any phone that presents the token
takes it.

> **A token used by `bfwp-smoke.js` is claimed by it.** The smoke client sends a
device id like any other, so if you verify a deployment with the token you were
going to paste into a phone, the phone will be refused afterwards -- correctly, and
with a sentence that says so. Use a throwaway token for the smoke test and remove
it afterwards, or run `release` on it before handing it over.

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

**The token you give it is claimed by it.** The smoke client presents a device id
like any other client, and a token belongs to the first device that uses it (see
"A token belongs to one phone"): verifying a deployment with the token destined for
a phone leaves that phone refused with `TOKEN_BOUND`. Mint a throwaway device for
the test and `remove` it afterwards, or `release` its token before handing it over.

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
FOCUS checks report SKIPPED, never passed, and the run says so instead of counting
them as failures.

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

The tool's own first three versions reported a HEALTHY server as broken: once because
it acknowledged a frame and then treated the next one as unacknowledged, so the
screencast stayed stopped and it waited for a picture it had already been sent; once
because it took any frame as proof that the page it had asked for was in front, and
then tapped the page it was leaving; and once because a SKIPPED check was counted as a
failed one, so a run without `--focus-url` -- every executed check green -- printed
`0/4 checks passed` and the verdict below it. All three are written into the file. A
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
| `BFWP_REGISTER_HOST` | `127.0.0.1` | Bind address of the registration page. Beyond loopback it requires `BFWP_REGISTER_SECRET`, and the compose file sets `0.0.0.0` because a published port cannot reach a container's loopback. |
| `BFWP_REGISTER_PORT` | `8445` | Where the page listens. Must differ from `BFWP_PORT` and `BFWP_PORT + 1` (the audio port). |
| `BFWP_REGISTER_SECRET` | empty | The access code for the page, 16 characters or more. Required whenever the bind address is not loopback. |
| `BFWP_REGISTER_PER_HOUR` | `3` | Registrations per address per hour. `0` turns the limit off. |
| `BFWP_REGISTER_BIND_IP` | `127.0.0.1` | **Compose only**, not read by the server: the host address the page's port is published on. `0.0.0.0` puts it on the network. |
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
| Code 3 | The device id is not in this server's registry. `bin/bfwp-device.sh list`. |
| Code 2 | The token is wrong, or was copied with a trailing space. |
| Code 6 | `BFWP_MAX_SESSIONS` is reached. Check for devices holding idle sessions. |
| The screen goes black after the first frame | A frame was never acknowledged, so the tap stayed stopped. The client must `ACK`. |
| Chromium dies with no error | `shm_size` is too small. 1 GB, not the 64 MB default. |
| `Could not start a browser session` | Playwright was installed without a browser, or the image tag and the package version disagree. The build refuses that pair now, so this means an image built before that check existed: rebuild. |
| `could not listen: EACCES ... privkey.pem` | The entrypoint could not read the mounted key either -- it is not a permissions question you can fix with `chown` alone if the mount is read-protected for root too, e.g. an encrypted volume nobody unlocked. Check `docker compose logs` for the `entrypoint:` lines, which say which path was taken. |
| Code 3 immediately after adding a device | Either the server is an image old enough to read the registry once at startup (rebuild; the current one reloads and logs it), or the registry was written by a root `exec` and the server cannot read it -- use `bin/bfwp-device.sh`. |
