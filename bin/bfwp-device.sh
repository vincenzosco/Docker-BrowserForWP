#!/bin/sh
# The device CLI, run as the user the SERVER runs as.
#
# WHY THE WRAPPER. The image starts as root so bin/entrypoint.sh can stage the
# certificate and drop, which means `docker compose exec render node
# bin/bfwp-device.js add` is a ROOT process writing /var/lib/bfwp/devices.json:
# root-owned and 0600. The server runs as pwuser and could then neither read that
# registry nor rewrite it, so a successful `add` would be followed within seconds
# by a server that refuses every device in it -- an outage caused by the command
# that was supposed to grant access.
#
# `docker compose exec --user 1000:1000` would also work and is one flag to
# remember at every call site, including the warning this repository prints at
# startup. A wrapper is remembered for you.
set -eu

exec setpriv \
  --reuid="${BFWP_RUN_UID:-1000}" \
  --regid="${BFWP_RUN_GID:-1000}" \
  --clear-groups \
  node "$(dirname "$0")/bfwp-device.js" "$@"
