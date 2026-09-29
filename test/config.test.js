import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULTS, loadConfig } from '../src/config.js';

test('an empty environment produces a safe configuration', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8443);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.allowInsecure, false, 'plain TCP must be opt-in');
  assert.equal(config.audioEnabled, false, 'a virtual sound device is opt-in');
  assert.equal(config.frameQuality, 60);
  assert.equal(config.maxSessions, 16);
  assert.equal(config.viewportWidth, 480);
  assert.equal(config.devicePixelRatio, 2);
  assert.equal(config.logLevel, 'info');
});

test('the result is frozen, so nothing downstream can mutate it', () => {
  const config = loadConfig({});
  assert.throws(() => {
    config.port = 1;
  }, TypeError);
});

test('overrides are read, and numbers become numbers', () => {
  const config = loadConfig({
    BFWP_PORT: '9443',
    BFWP_HOST: '127.0.0.1',
    BFWP_FRAME_QUALITY: '40',
    BFWP_MAX_SESSIONS: '4',
    BFWP_VIEWPORT_WIDTH: '360',
    BFWP_SERVER_NAME: 'my box',
  });
  assert.equal(config.port, 9443);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.frameQuality, 40);
  assert.equal(config.maxSessions, 4);
  assert.equal(config.viewportWidth, 360);
  assert.equal(config.serverName, 'my box');
});

test('an unparseable integer is refused and named', () => {
  assert.throws(() => loadConfig({ BFWP_PORT: '8443abc' }), /BFWP_PORT must be an integer/);
  assert.throws(() => loadConfig({ BFWP_PORT: '80.5' }), /BFWP_PORT must be an integer/);
});

test('out-of-range numbers are refused rather than clamped', () => {
  assert.throws(() => loadConfig({ BFWP_PORT: '0' }), /BFWP_PORT must be in 1\.\.65535/);
  assert.throws(() => loadConfig({ BFWP_PORT: '70000' }), /BFWP_PORT must be in 1\.\.65535/);
  assert.throws(() => loadConfig({ BFWP_FRAME_QUALITY: '100' }), /BFWP_FRAME_QUALITY must be in 1\.\.95/);
  assert.throws(() => loadConfig({ BFWP_DEVICE_PIXEL_RATIO: '5' }), /BFWP_DEVICE_PIXEL_RATIO/);
  assert.throws(() => loadConfig({ BFWP_MAX_SESSIONS: '99999' }), /BFWP_MAX_SESSIONS/);
});

test('booleans accept the usual spellings and refuse the rest', () => {
  for (const yes of ['1', 'true', 'YES', 'on']) {
    assert.equal(loadConfig({ BFWP_AUDIO_ENABLED: yes }).audioEnabled, true);
  }
  for (const no of ['0', 'false', 'No', 'off']) {
    assert.equal(loadConfig({ BFWP_AUDIO_ENABLED: no }).audioEnabled, false);
  }
  assert.throws(() => loadConfig({ BFWP_AUDIO_ENABLED: 'maybe' }), /must be a boolean/);
});

test('the public url must be https unless insecurity was opted into', () => {
  assert.throws(() => loadConfig({ BFWP_PUBLIC_URL: 'http://example.com' }), /must be https/);
  assert.equal(
    loadConfig({ BFWP_PUBLIC_URL: 'http://example.com', BFWP_ALLOW_INSECURE: '1' }).publicUrl,
    'http://example.com',
  );
  assert.throws(() => loadConfig({ BFWP_PUBLIC_URL: 'not a url' }), /is not a URL/);
  assert.throws(() => loadConfig({ BFWP_PUBLIC_URL: 'ftp://example.com' }), /must be http/);
});

test('a trailing slash on the public url is removed, so paths never double up', () => {
  assert.equal(loadConfig({ BFWP_PUBLIC_URL: 'https://example.com/' }).publicUrl, 'https://example.com');
  assert.equal(loadConfig({ BFWP_PUBLIC_URL: 'https://example.com/base/' }).publicUrl, 'https://example.com/base');
});

test('plain TCP cannot be enabled in production', () => {
  assert.throws(
    () => loadConfig({ BFWP_ALLOW_INSECURE: '1', NODE_ENV: 'production' }),
    /cannot be enabled with NODE_ENV=production/,
  );
});

test('an unknown log level is refused', () => {
  assert.throws(() => loadConfig({ BFWP_LOG_LEVEL: 'chatty' }), /BFWP_LOG_LEVEL/);
  assert.equal(loadConfig({ BFWP_LOG_LEVEL: 'debug' }).logLevel, 'debug');
});

test('the devices file is an absolute path, whatever it was given', () => {
  const config = loadConfig({ BFWP_DEVICES_FILE: './data/devices.json' });
  assert.equal(path.isAbsolute(config.devicesFile), true);
  assert.ok(config.devicesFile.endsWith(path.join('data', 'devices.json')));
});

// ── The registration page ─────────────────────────────────────────────────
// It mints credentials, so the two refusals below are the feature: loopback by
// default, and a page reachable from the network only with an access code. A token
// dispenser on the open internet has to be a decision, not a typo.

test('the registration page is loopback, rate-limited, and secret-free by default', () => {
  const config = loadConfig({});
  assert.equal(config.registerHost, '127.0.0.1');
  assert.equal(config.registerIsLoopback, true);
  assert.equal(config.registerPort, 8445);
  assert.equal(config.registerSecret, '');
  assert.equal(config.registerPerHour, 3);
});

test('publishing the page without an access code is refused, not warned about', () => {
  assert.throws(() => loadConfig({ BFWP_REGISTER_HOST: '0.0.0.0' }), /BFWP_REGISTER_SECRET/);
  assert.throws(() => loadConfig({ BFWP_REGISTER_HOST: '0.0.0.0', BFWP_REGISTER_SECRET: 'too-short' }),
    /at least 16/);

  const config = loadConfig({ BFWP_REGISTER_HOST: '0.0.0.0', BFWP_REGISTER_SECRET: 'a-code-long-enough' });
  assert.equal(config.registerIsLoopback, false);
});

test('localhost is a loopback address, because a deployment may well write it', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(loadConfig({ BFWP_REGISTER_HOST: host }).registerIsLoopback, true, host);
  }
});

test('the registration port cannot collide with the other two listeners', () => {
  assert.throws(() => loadConfig({ BFWP_REGISTER_PORT: '8443' }), /must differ from BFWP_PORT/);
  assert.throws(() => loadConfig({ BFWP_REGISTER_PORT: '8444' }), /audio port/);
  assert.equal(loadConfig({ BFWP_REGISTER_PORT: '9445' }).registerPort, 9445);
});

test('a rate limit of zero is allowed, and means no limit', () => {
  assert.equal(loadConfig({ BFWP_REGISTER_PER_HOUR: '0' }).registerPerHour, 0);
  assert.throws(() => loadConfig({ BFWP_REGISTER_PER_HOUR: '1000' }), /BFWP_REGISTER_PER_HOUR/);
});

test('the page may be opened to whoever finds it, and only deliberately', () => {
  // The default is still one token per address per day, on a page that takes a
  // code: opening it is the operator saying so.
  assert.equal(loadConfig({}).registerOpen, false);
  assert.equal(loadConfig({}).registerPerDay, 1);

  // A page nobody can reach, with no code, protects nothing: refused.
  assert.throws(() => loadConfig({ BFWP_REGISTER_OPEN: '1' }), /nobody to open it to/);

  // Two answers to one question: refused rather than one of them quietly winning.
  assert.throws(() => loadConfig({
    BFWP_REGISTER_OPEN: '1', BFWP_REGISTER_HOST: '0.0.0.0', BFWP_REGISTER_SECRET: 'a-code-long-enough',
  }), /Set one or the other/);

  const open = loadConfig({ BFWP_REGISTER_OPEN: '1', BFWP_REGISTER_HOST: '0.0.0.0' });
  assert.equal(open.registerIsLoopback, false);
  assert.equal(open.registerOpen, true);
});

test('the page says where a token is removed, and that address must be https', () => {
  assert.equal(loadConfig({}).issuesUrl,
    'https://github.com/vincenzosco/Docker-BrowserForWP/issues',
    'a person who lost a token needs somewhere to ask, by default');
  assert.equal(loadConfig({ BFWP_ISSUES_URL: 'https://example.com/issues/' }).issuesUrl,
    'https://example.com/issues', 'the trailing slash is not part of the path');
  assert.throws(() => loadConfig({ BFWP_ISSUES_URL: 'http://example.com/issues' }), /must be https/);
  assert.throws(() => loadConfig({ BFWP_ISSUES_URL: 'not a url' }), /is not a URL/);
});

test('the low-memory chromium flags are opt-in, because isolation is the trade', () => {
  assert.equal(loadConfig({}).chromiumLowMemory, false);
  assert.equal(loadConfig({ BFWP_CHROMIUM_LOW_MEMORY: '1' }).chromiumLowMemory, true);
  assert.throws(() => loadConfig({ BFWP_CHROMIUM_LOW_MEMORY: 'sometimes' }), /must be a boolean/);
});

test('the plain-http listener needs a target, and the target must be https', () => {
  assert.equal(loadConfig({}).registerHttpPort, 0, 'off unless asked for');
  assert.throws(() => loadConfig({ BFWP_REGISTER_HTTP_PORT: '8080' }), /nowhere to send anyone/);
  assert.throws(() => loadConfig({
    BFWP_REGISTER_HTTP_PORT: '8080', BFWP_REGISTER_URL: 'http://render.example/',
  }), /must be https/);
  assert.throws(() => loadConfig({
    BFWP_REGISTER_HTTP_PORT: '8080', BFWP_REGISTER_URL: 'not a url',
  }), /is not a URL/);

  const config = loadConfig({
    BFWP_REGISTER_HTTP_PORT: '8080', BFWP_REGISTER_URL: 'https://render.example',
  });
  assert.equal(config.registerHttpPort, 8080);
  assert.equal(config.registerUrl, 'https://render.example/');
});

test('the plain-http port cannot collide with the other three listeners', () => {
  assert.throws(() => loadConfig({
    BFWP_REGISTER_HTTP_PORT: '8443', BFWP_REGISTER_URL: 'https://render.example/',
  }), /must differ from BFWP_PORT/);
  assert.throws(() => loadConfig({
    BFWP_REGISTER_HTTP_PORT: '8445', BFWP_REGISTER_URL: 'https://render.example/',
  }), /BFWP_REGISTER_PORT/);
});

test('every default is present in the frozen defaults table', () => {
  const config = loadConfig({});
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in config, `${key} is a default with no configuration field`);
  }
  assert.equal(ConfigError.prototype instanceof Error, true);
});
