// Configuration, from the environment and nowhere else.
//
// Every value has a default that is safe to deploy, and every value is
// validated on the way in: a server that starts with port "8443abc" or a frame
// quality of 900 is a server that fails later, in a place where the cause is not
// visible. Fail here instead, where the message says which variable is wrong.

import path from 'node:path';

/**
 * Addresses that only this machine can reach. `localhost` is included because a
 * deployment may well write it, and treating it as public would refuse to start a
 * server that is in fact unreachable from anywhere else.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const DEFAULTS = Object.freeze({
  host: '0.0.0.0',
  port: 8443,
  tlsCert: '/etc/bfwp/tls/fullchain.pem',
  tlsKey: '/etc/bfwp/tls/privkey.pem',
  devicesFile: '/var/lib/bfwp/devices.json',
  publicUrl: 'https://render.browserforwp.example:8443',
  serverName: 'BrowserForWP render server',
  audioFifo: '/run/bfwp/audio.mp3',
  audioEnabled: false,
  frameQuality: 60,
  maxFrameBytes: 2 * 1024 * 1024,
  sessionIdleMs: 120000,
  maxSessions: 16,
  maxTilesPerFrame: 16,
  pageTimeoutMs: 30000,
  registerHost: '127.0.0.1',
  // 8444 is the audio endpoint (BFWP_PORT + 1), which is why this is not 8444.
  registerPort: 8445,
  registerSecret: '',
  registerPerHour: 3,
  viewportWidth: 480,
  viewportHeight: 800,
  devicePixelRatio: 2,
  blockAds: true,
  allowInsecure: false,
  logLevel: 'info',
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function intFrom(env, key, fallback, { min, max }) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be in ${min}..${max}, got ${value}`);
  }
  return value;
}

function boolFrom(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const lowered = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(raw)}`);
}

function stringFrom(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).trim();
}

function urlFrom(env, key, fallback, { allowInsecure }) {
  const raw = stringFrom(env, key, fallback);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} is not a URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol === 'http:' && !allowInsecure) {
    throw new ConfigError(`${key} must be https://. Set BFWP_ALLOW_INSECURE=1 only for a local test.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${key} must be http:// or https://, got ${parsed.protocol}`);
  }
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
}

export function loadConfig(env = process.env) {
  const allowInsecure = boolFrom(env, 'BFWP_ALLOW_INSECURE', DEFAULTS.allowInsecure);
  if (allowInsecure && env.NODE_ENV === 'production') {
    throw new ConfigError('BFWP_ALLOW_INSECURE cannot be enabled with NODE_ENV=production');
  }

  const config = {
    host: stringFrom(env, 'BFWP_HOST', DEFAULTS.host),
    port: intFrom(env, 'BFWP_PORT', DEFAULTS.port, { min: 1, max: 65535 }),
    tlsCert: stringFrom(env, 'BFWP_TLS_CERT', DEFAULTS.tlsCert),
    tlsKey: stringFrom(env, 'BFWP_TLS_KEY', DEFAULTS.tlsKey),
    devicesFile: path.resolve(stringFrom(env, 'BFWP_DEVICES_FILE', DEFAULTS.devicesFile)),
    serverName: stringFrom(env, 'BFWP_SERVER_NAME', DEFAULTS.serverName),
    audioFifo: stringFrom(env, 'BFWP_AUDIO_FIFO', DEFAULTS.audioFifo),
    audioEnabled: boolFrom(env, 'BFWP_AUDIO_ENABLED', DEFAULTS.audioEnabled),
    frameQuality: intFrom(env, 'BFWP_FRAME_QUALITY', DEFAULTS.frameQuality, { min: 1, max: 95 }),
    maxFrameBytes: intFrom(env, 'BFWP_MAX_FRAME_BYTES', DEFAULTS.maxFrameBytes, { min: 32768, max: 8 * 1024 * 1024 }),
    sessionIdleMs: intFrom(env, 'BFWP_SESSION_IDLE_MS', DEFAULTS.sessionIdleMs, { min: 5000, max: 3600000 }),
    maxSessions: intFrom(env, 'BFWP_MAX_SESSIONS', DEFAULTS.maxSessions, { min: 1, max: 512 }),
    maxTilesPerFrame: intFrom(env, 'BFWP_MAX_TILES', DEFAULTS.maxTilesPerFrame, { min: 1, max: 256 }),
    pageTimeoutMs: intFrom(env, 'BFWP_PAGE_TIMEOUT_MS', DEFAULTS.pageTimeoutMs, { min: 1000, max: 300000 }),
    registerHost: stringFrom(env, 'BFWP_REGISTER_HOST', DEFAULTS.registerHost),
    // 0 means "let the operating system choose", which is only useful to a test
    // that starts the page on an ephemeral port and reads the url back.
    registerPort: intFrom(env, 'BFWP_REGISTER_PORT', DEFAULTS.registerPort, { min: 0, max: 65535 }),
    registerSecret: stringFrom(env, 'BFWP_REGISTER_SECRET', DEFAULTS.registerSecret),
    // 0 turns the rate limit off, for a deployment that would rather accept any
    // number of registrations than ever refuse a legitimate one.
    registerPerHour: intFrom(env, 'BFWP_REGISTER_PER_HOUR', DEFAULTS.registerPerHour, { min: 0, max: 100 }),
    viewportWidth: intFrom(env, 'BFWP_VIEWPORT_WIDTH', DEFAULTS.viewportWidth, { min: 160, max: 4096 }),
    viewportHeight: intFrom(env, 'BFWP_VIEWPORT_HEIGHT', DEFAULTS.viewportHeight, { min: 160, max: 4096 }),
    devicePixelRatio: intFrom(env, 'BFWP_DEVICE_PIXEL_RATIO', DEFAULTS.devicePixelRatio, { min: 1, max: 4 }),
    blockAds: boolFrom(env, 'BFWP_BLOCK_ADS', DEFAULTS.blockAds),
    allowInsecure,
    logLevel: stringFrom(env, 'BFWP_LOG_LEVEL', DEFAULTS.logLevel),
  };

  config.publicUrl = urlFrom(env, 'BFWP_PUBLIC_URL', DEFAULTS.publicUrl, { allowInsecure });

  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.logLevel)) {
    throw new ConfigError(`BFWP_LOG_LEVEL must be debug, info, warn, error or silent, got ${config.logLevel}`);
  }

  // Two refusals, and both are the point of the feature rather than a formality.
  //
  // The port must not collide with the two listeners that already exist, because
  // the failure would be `EADDRINUSE` at startup with a message that names a port
  // nobody typed.
  if (config.registerPort === config.port || config.registerPort === config.port + 1) {
    throw new ConfigError(`BFWP_REGISTER_PORT must differ from BFWP_PORT (${config.port})`
      + ` and from the audio port (${config.port + 1}), got ${config.registerPort}`);
  }

  // AND THE ONE THAT MATTERS. This page mints credentials: anybody who can reach
  // it and pass a challenge can hold a token for a channel that carries every page
  // they read. So the default is that only this machine can reach it, and a
  // deployment that publishes it has to say so twice -- a non-loopback address AND
  // a secret long enough to not be guessed. `BFWP_REGISTER_HOST=0.0.0.0` on its own
  // is refused rather than honoured, because honouring it is how a token dispenser
  // ends up on the open internet with nobody having decided that it should.
  config.registerIsLoopback = LOOPBACK_HOSTS.has(config.registerHost);
  if (!config.registerIsLoopback && config.registerSecret.length < 16) {
    throw new ConfigError('BFWP_REGISTER_HOST is not a loopback address, so the registration'
      + ' page would be reachable from the network: set BFWP_REGISTER_SECRET (at least 16'
      + ' characters), or leave BFWP_REGISTER_HOST at 127.0.0.1 and reach the page through'
      + ' an SSH tunnel. A page that mints credentials must not be open to whoever finds it.');
  }

  return Object.freeze(config);
}
