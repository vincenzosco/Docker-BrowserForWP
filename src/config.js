// Configuration, from the environment and nowhere else.
//
// Every value has a default that is safe to deploy, and every value is
// validated on the way in: a server that starts with port "8443abc" or a frame
// quality of 900 is a server that fails later, in a place where the cause is not
// visible. Fail here instead, where the message says which variable is wrong.

import path from 'node:path';

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

  return Object.freeze(config);
}
