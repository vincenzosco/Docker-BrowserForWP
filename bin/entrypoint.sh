#!/bin/sh
# Stage the TLS material, become the app user, and run the server.
#
# WHY THIS IS A SCRIPT. `tls/` is a bind mount, and a bind mount keeps the HOST's
# numeric owner. The server runs as pwuser (uid 1000) and a private key is written
# 0600, so a key created by certbot or by openssl is readable only by root: the
# server starts, logs
#
#     ERROR could not listen: EACCES: permission denied, open '/etc/bfwp/tls/privkey.pem'
#
# and restart-loops forever. A one-off `chown 1000:1000` in the deployment notes
# fixes that once -- and certbot REWRITES the key on every renewal, as root, so the
# fix expires silently about sixty days later, at the hour the renewal timer ran,
# with nobody watching.
#
# So the container does it, on every start: it begins as root, makes a copy of the
# pair that the app user can read, and drops privileges. The mounted originals stay
# root-owned and read-only, which is what a certificate directory should be.
#
# Measured on the first real deployment: this is failure mode 2 of 3, and it bit
# twice in one afternoon -- once on the first start, once after a chown -R that
# covered the tls directory as well.

set -eu

CERT="${BFWP_TLS_CERT:-/etc/bfwp/tls/fullchain.pem}"
KEY="${BFWP_TLS_KEY:-/etc/bfwp/tls/privkey.pem}"
STAGE="${BFWP_TLS_STAGE:-/run/bfwp/tls}"
APP_UID="${BFWP_RUN_UID:-1000}"
APP_GID="${BFWP_RUN_GID:-1000}"

# Runs a command as the app user, WITHOUT exec.
#
# The `exec` is deliberately reserved for the final call. This function is also
# called inside an `if`, to test whether the app user can read the mounted key --
# and `exec` there replaces the entrypoint with the test, so the container's main
# process becomes `test -r`, exits 0, and Docker reports "Restarting (0)" with no
# log lines at all. That is exactly what the first version of this file did, and it
# is a shape worth naming: exec belongs in the last line of a script, never in a
# helper that a condition can call.
#
# setpriv and not su: no PAM, no login shell, no home directory to care about.
as_app() {
  setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
}

if [ "$(id -u)" != "0" ]; then
  # Started as an unprivileged user -- a plain `docker run --user`, a rootless
  # runtime, or a deployment that already solved this. Whatever ownership the
  # mounts have is then what we live with, and the server says so itself if it
  # cannot read them.
  echo "entrypoint: running as uid $(id -u); the mounted certificate must already be readable" >&2
  exec "$@"
fi

# Readability is tested AS THE APP USER. `[ -r ]` as root answers yes for a file
# nobody else can open, which is exactly the case this script exists for.
if as_app test -r "$CERT" && as_app test -r "$KEY"; then
  echo "entrypoint: the mounted certificate is readable by uid $APP_UID; nothing to stage"
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
fi

echo "entrypoint: the mounted certificate is not readable by uid $APP_UID; staging a copy under $STAGE" >&2
mkdir -p "$STAGE"
cp "$CERT" "$STAGE/fullchain.pem"
cp "$KEY" "$STAGE/privkey.pem"

# chmod BEFORE chown, and the order is load-bearing. The copies are root's right
# now, so root can set their modes as the owner. After the chown they belong to a
# user we are not, and changing another user's file needs CAP_FOWNER -- which this
# container drops, and which it should not have to add back for a line the other
# order makes unnecessary. Measured: the first version of this file chowned first
# and died on `chmod: changing permissions of '/run/bfwp/tls/fullchain.pem':
# Operation not permitted`.
chmod 644 "$STAGE/fullchain.pem"
chmod 600 "$STAGE/privkey.pem"
chown "$APP_UID:$APP_GID" "$STAGE/fullchain.pem" "$STAGE/privkey.pem"

# The server reads these from the environment, which is also how a deployment that
# puts the certificate somewhere else tells it where.
BFWP_TLS_CERT="$STAGE/fullchain.pem"
BFWP_TLS_KEY="$STAGE/privkey.pem"
export BFWP_TLS_CERT BFWP_TLS_KEY

# The last line, and the only place exec belongs: this one becomes the server, so
# it keeps PID 1 and the SIGTERM handling the server has for shutting down.
exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
