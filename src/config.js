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
  // 0 is "no plain-http listener". When it is set, that listener answers 301 and
  // nothing else, so that typing the bare address in a browser lands on the page,
  // over https, without the address bar having to carry a port number.
  registerHttpPort: 0,
  registerUrl: '',
  registerSecret: '',
  // An open page mints tokens for whoever finds it: no access code, and the
  // challenge and the per-address limits are all that is left. Off by default.
  registerOpen: false,
  registerPerHour: 3,
  // The limit that actually matters for a public page: one token per address per
  // day, so a stranger cannot fill the box with devices in an afternoon.
  registerPerDay: 1,
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
    registerHttpPort: intFrom(env, 'BFWP_REGISTER_HTTP_PORT', DEFAULTS.registerHttpPort, { min: 0, max: 65535 }),
    registerUrl: stringFrom(env, 'BFWP_REGISTER_URL', DEFAULTS.registerUrl),
    registerSecret: stringFrom(env, 'BFWP_REGISTER_SECRET', DEFAULTS.registerSecret),
    registerOpen: boolFrom(env, 'BFWP_REGISTER_OPEN', DEFAULTS.registerOpen),
    // 0 turns the rate limit off, for a deployment that would rather accept any
    // number of registrations than ever refuse a legitimate one.
    registerPerHour: intFrom(env, 'BFWP_REGISTER_PER_HOUR', DEFAULTS.registerPerHour, { min: 0, max: 100 }),
    registerPerDay: intFrom(env, 'BFWP_REGISTER_PER_DAY', DEFAULTS.registerPerDay, { min: 0, max: 100 }),
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

  // Ports, first, because the failure would otherwise be `EADDRINUSE` at startup
  // with a message that names a port nobody typed.
  if (config.registerPort === config.port || config.registerPort === config.port + 1) {
    throw new ConfigError(`BFWP_REGISTER_PORT must differ from BFWP_PORT (${config.port})`
      + ` and from the audio port (${config.port + 1}), got ${config.registerPort}`);
  }
  if (config.registerHttpPort !== 0
      && [config.port, config.port + 1, config.registerPort].includes(config.registerHttpPort)) {
    throw new ConfigError(`BFWP_REGISTER_HTTP_PORT must differ from BFWP_PORT (${config.port}),`
      + ` from the audio port (${config.port + 1}) and from BFWP_REGISTER_PORT`
      + ` (${config.registerPort}), got ${config.registerHttpPort}`);
  }

  // The plain-http listener has exactly one job, so it needs exactly one thing:
  // somewhere to send people. Checked here rather than at the first request,
  // because a redirect listener with no target is a listener that answers 500 to
  // the one request it will ever get.
  if (config.registerHttpPort !== 0) {
    if (config.registerUrl.length === 0) {
      throw new ConfigError('BFWP_REGISTER_HTTP_PORT is set, so the plain-http listener has'
        + ' nowhere to send anyone: set BFWP_REGISTER_URL to the https address of the page,'
        + ' for example https://render.example/');
    }
    let target;
    try {
      target = new URL(config.registerUrl);
    } catch {
      throw new ConfigError(`BFWP_REGISTER_URL is not a URL: ${JSON.stringify(config.registerUrl)}`);
    }
    if (target.protocol !== 'https:' && !allowInsecure) {
      throw new ConfigError('BFWP_REGISTER_URL must be https://: the whole point of the'
        + ' plain-http listener is to send people to the encrypted page, and a redirect to'
        + ' another http url would leave the token on the wire.');
    }
    config.registerUrl = target.origin + (target.pathname === '' ? '/' : target.pathname);
  }

  // AND THE REFUSALS THAT MATTER, because this page mints credentials: anybody who
  // can reach it and pass a challenge holds a token for a channel that carries
  // every page they read. Three combinations are contradictory, and each one is
  // refused rather than quietly resolved.
  config.registerIsLoopback = LOOPBACK_HOSTS.has(config.registerHost);

  // A page nobody can reach, with no access code: the only thing it would protect
  // is nothing.
  if (config.registerOpen && config.registerIsLoopback) {
    throw new ConfigError('BFWP_REGISTER_OPEN says the page takes no access code, but'
      + ` BFWP_REGISTER_HOST (${config.registerHost}) is a loopback address, so there is`
      + ' nobody to open it to. Set BFWP_REGISTER_BIND_IP/BFWP_REGISTER_HOST to the address'
      + ' people use, or leave BFWP_REGISTER_OPEN unset.');
  }

  // Two answers to the same question: one says the page asks for a code, the other
  // says it does not. Honouring either would leave the operator believing the other.
  if (config.registerOpen && config.registerSecret.length > 0) {
    throw new ConfigError('BFWP_REGISTER_OPEN says the page takes no access code and'
      + ' BFWP_REGISTER_SECRET sets one. Set one or the other.');
  }

  // The default path: published without a code, but NOT opened, so the code is
  // required and long enough not to be guessed. `BFWP_REGISTER_HOST=0.0.0.0` on its
  // own is refused rather than honoured, because honouring it is how a token
  // dispenser ends up on the open internet with nobody having decided that it should.
  if (!config.registerIsLoopback && !config.registerOpen && config.registerSecret.length < 16) {
    throw new ConfigError('BFWP_REGISTER_HOST is not a loopback address, so the registration'
      + ' page would be reachable from the network: set BFWP_REGISTER_SECRET (at least 16'
      + ' characters), set BFWP_REGISTER_OPEN=1 to mint tokens for whoever finds the page,'
      + ' or leave BFWP_REGISTER_HOST at 127.0.0.1 and reach the page through an SSH tunnel.');
  }

  return Object.freeze(config);
}
