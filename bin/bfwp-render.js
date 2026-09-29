#!/usr/bin/env node
// The entrypoint.
//
// Two listeners, on purpose:
//
//   * The render channel, on BFWP_PORT, speaks TLS 1.3 ONLY. The client is a
//     Windows Phone 8.1 app that implements TLS 1.3 in managed code over a raw
//     socket, so the transport has to be something it can complete a handshake
//     with.
//   * The audio endpoint, when audio is enabled, is ordinary HTTPS accepting
//     TLS 1.2 and up, because the phone plays it with MediaElement through
//     Schannel and the custom stack in the client cannot feed MediaElement at
//     all. Two different constraints, two listeners, one certificate.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { DeviceStore } from '../src/devices.js';
import { createPlaywrightBrowserFactory } from '../src/browser.js';
import { createRenderServer } from '../src/server.js';
import { AudioRegistry, createAudioHandler } from '../src/audio.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exit(1);
  }

  const log = createLog({ level: config.logLevel });
  log.info(`BrowserForWP render server starting (${config.serverName})`);

  let store;
  try {
    store = new DeviceStore(config.devicesFile).load();
  } catch (error) {
    log.error(`the device registry could not be read: ${error.message}`);
    process.exit(1);
    return;
  }

  if (store.size === 0) {
    log.warn(`no devices are registered in ${config.devicesFile}. Nobody can connect until you run:`);
    log.warn('  npm run device -- add "my phone"');
  } else {
    log.info(`device registry: ${store.size} device(s)`);
  }

  const audioRegistry = new AudioRegistry({ config, log });
  const browserFactory = createPlaywrightBrowserFactory({ config, log });
  const server = createRenderServer({ config, store, browserFactory, log, audioRegistry });

  let audioServer = null;
  if (config.audioEnabled) {
    let cert;
    let key;
    try {
      cert = fs.readFileSync(config.tlsCert);
      key = fs.readFileSync(config.tlsKey);
    } catch (error) {
      log.error(`audio is enabled but the certificate could not be read: ${error.message}`);
      process.exit(1);
      return;
    }
    const handler = createAudioHandler({ config, log, audioRegistry });
    audioServer = https.createServer(
      { cert, key, minVersion: 'TLSv1.2' },
      (req, res) => {
        if ((req.url ?? '').startsWith('/audio/')) {
          handler(req, res);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
      },
    );
    audioServer.on('error', (error) => log.error('audio listener error', error));
    audioServer.listen(config.port + 1, config.host, () => {
      log.info(`audio on ${config.host}:${config.port + 1}, TLS 1.2+, `
        + `streaming ${config.audioFifo}`);
    });
  } else {
    log.info('audio is off; a page cannot be heard through this server');
  }

  try {
    server.start();
  } catch (error) {
    log.error(`could not listen: ${error.message}`);
    process.exit(1);
    return;
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    if (audioServer) await new Promise((resolve) => audioServer.close(resolve));
    await server.stop();
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (error) => {
    // A renderer for strangers must not die from one page's nonsense.
    log.error('uncaught exception, the process stays up', error);
  });
}

// http is imported for the type it documents: there is no plain-HTTP listener in
// production, and importing it here is a reminder that there is exactly one
// place that would create one, and it is not this file.
void http;

main().catch((error) => {
  process.stderr.write(`fatal: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
