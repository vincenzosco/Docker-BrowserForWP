#!/usr/bin/env node
// The container healthcheck.
//
// It opens a TCP connection and hangs up. It does NOT complete a TLS handshake,
// because a successful handshake requires a device token, and a healthcheck that
// needs a credential is a healthcheck that fails when the credential is rotated
// -- reporting a healthy server as dead, which is worse than no healthcheck.
//
// What this does prove: the process is up and the port is bound.

import net from 'node:net';

const port = Number.parseInt(process.env.BFWP_PORT ?? '8443', 10);
const host = process.env.BFWP_HEALTHCHECK_HOST ?? '127.0.0.1';

const socket = net.connect({ port, host });
const done = (code) => {
  socket.destroy();
  process.exit(code);
};

socket.setTimeout(3000);
socket.on('connect', () => done(0));
socket.on('timeout', () => done(1));
socket.on('error', () => done(1));
