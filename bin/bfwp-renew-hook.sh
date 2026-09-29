#!/usr/bin/env bash
#
# certbot DEPLOY hook for the render server.
#
# WHY THIS EXISTS. The certificate is a six-day Let's Encrypt IP certificate
# (the `shortlived` profile, which is the only profile that issues for an IP
# address). It is renewed by a timer, and a renewal nobody deploys is a server
# presenting an expired certificate a few days later -- the phone validates the
# chain and the name before it sends a byte, so that is a dead server, not a
# warning. Two things have to happen after EVERY renewal, and both are here:
#
#   1. the new pair is copied into the deployment's ./tls, the only path the
#      container mounts; and
#   2. the container is restarted, because the server reads the certificate
#      once, at startup.
#
# WHY A COPY AND NOT A MOUNT. /etc/letsencrypt/live/<name> is a directory of
# symlinks into ../../archive/<name>/<version>N.pem, so bind-mounting just
# `live` gives the container a set of dangling links; bind-mounting all of
# /etc/letsencrypt hands the app user the ACME account key (which can issue and
# revoke for the whole account) for no reason at all. ./tls stays the single
# mount point, the files stay root:root 0600, and the entrypoint already stages
# a readable copy for the app user on every start -- so nothing here has to
# reason about which uid the server runs as.
#
# WHY IT PARSES THE CERTIFICATE. `certbot certonly --cert-name X` silently does
# nothing when a certificate named X already exists and is not yet due for
# renewal. That is how a staging certificate stays in place after a production
# run that reported no error: the command exits 0 and the file is unchanged. So
# this hook states what it is deploying and checks, from the file it just
# copied, that the certificate is for the address it is supposed to serve. A
# hook that only copies bytes would have reported success through exactly that
# mistake.
#
# Exit codes are load-bearing: certbot records a failed deploy hook and exits
# non-zero, which the timer surfaces. A hook that swallowed errors would leave
# a healthy-looking server with a stale certificate.

set -euo pipefail

CERT_NAME="${BFWP_CERT_NAME:-34.132.106.149}"
REPO="${BFWP_REPO:-/home/vincenzo/Docker-BrowserForWP}"
SERVICE="${BFWP_COMPOSE_SERVICE:-render}"
HEALTH_TIMEOUT="${BFWP_HEALTH_TIMEOUT:-90}"

# Optional overrides, so the same file can serve a different deployment without
# being edited: CERT_NAME, REPO, SERVICE, HEALTH_TIMEOUT.
if [ -r /etc/default/bfwp-render ]; then
  # shellcheck disable=SC1091
  . /etc/default/bfwp-render
fi

LIVE="/etc/letsencrypt/live/${CERT_NAME}"
SRC_CHAIN="${LIVE}/fullchain.pem"
SRC_KEY="${LIVE}/privkey.pem"
DST_CHAIN="${REPO}/tls/fullchain.pem"
DST_KEY="${REPO}/tls/privkey.pem"

log() { echo "bfwp-renew-hook: $*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

[ -r "$SRC_CHAIN" ] || fail "no certificate at ${SRC_CHAIN}"
[ -r "$SRC_KEY" ] || fail "no private key at ${SRC_KEY}"
[ -r "${REPO}/docker-compose.yml" ] || fail "no compose file under ${REPO}"

# Cheap guard with a specific failure in mind: an IP certificate whose SAN is
# some other address still installs cleanly, still serves, and is refused by
# every client. `openssl x509 -checkip` answers about the SAN, which is the only
# place the address appears (the shortlived profile issues no common name).
if command -v openssl >/dev/null 2>&1; then
  if ! openssl x509 -in "$SRC_CHAIN" -noout -checkip "$CERT_NAME" >/dev/null 2>&1; then
    fail "$SRC_CHAIN is not a certificate for ${CERT_NAME}"
  fi
fi

expiry="$(openssl x509 -in "$SRC_CHAIN" -noout -enddate 2>/dev/null | cut -d= -f2 || true)"

install -d -m 0755 "${REPO}/tls"
# install(1) and not cp: it sets the mode, so the copy is 0600 by construction
# rather than by whatever umask the timer happens to run under.
install -m 0600 "$SRC_CHAIN" "$DST_CHAIN"
install -m 0600 "$SRC_KEY" "$DST_KEY"
log "staged $(basename "$CERT_NAME") into ${REPO}/tls (chain ${expiry:-expiry unknown})"

cd "$REPO"
docker compose restart "$SERVICE" || fail "docker compose restart ${SERVICE} failed"
log "restarted ${SERVICE}; waiting for healthy (up to ${HEALTH_TIMEOUT}s)"

# Restarting is not deploying. The server reloads the certificate only if the
# process really starts, and a bad key file makes it exit instead -- so the
# hook waits for the health check the image already defines rather than
# trusting the exit code of `restart`, which is happy the moment the container
# is signalled.
container="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
[ -n "$container" ] || fail "no container for service ${SERVICE}"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo unknown)"
  case "$status" in
    healthy)
      log "OK: ${SERVICE} is healthy with the certificate expiring ${expiry:-unknown}"
      exit 0
      ;;
    unhealthy|exited|dead)
      log "container state: ${status}; last 20 log lines:"
      docker logs --tail 20 "$container" >&2 || true
      fail "container became ${status} after the renewal"
      ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "container still '${status}' after ${HEALTH_TIMEOUT}s"
  sleep 3
done
