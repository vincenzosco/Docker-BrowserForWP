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

test('every default is present in the frozen defaults table', () => {
  const config = loadConfig({});
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in config, `${key} is a default with no configuration field`);
  }
  assert.equal(ConfigError.prototype instanceof Error, true);
});
