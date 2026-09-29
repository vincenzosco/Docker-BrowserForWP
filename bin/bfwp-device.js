#!/usr/bin/env node
// Device administration.
//
// There is no web UI and no signup page, deliberately: an account system is a
// password database, a reset flow and a support burden, and this server needs
// none of that to hand a phone a token. One command per device is the entire
// interface.
//
// `add` prints the token once and never again, because only its digest is
// stored. Losing it costs one command, not the registry.

import { loadConfig } from '../src/config.js';
import { DeviceStore } from '../src/devices.js';

const USAGE = `BrowserForWP render server — device registry

  bfwp-device add "<label>"       register a device and print its token ONCE
  bfwp-device list                list registered devices
  bfwp-device remove <deviceId>   forget a device
  bfwp-device disable <deviceId>  refuse a device without forgetting it
  bfwp-device enable <deviceId>   allow it again

The registry is ${'${BFWP_DEVICES_FILE}'} (default /var/lib/bfwp/devices.json).
`;

function usage(stream = process.stdout) {
  stream.write(USAGE);
}

function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return command ? 0 : 1;
  }

  const config = loadConfig();
  const store = new DeviceStore(config.devicesFile).load();

  switch (command) {
    case 'add': {
      const label = rest.join(' ').trim();
      if (!label) {
        process.stderr.write('add needs a label, so a device you no longer recognise can be revoked\n');
        return 1;
      }
      const { device, token } = store.add(label);
      process.stdout.write(
        `registered ${device.deviceId}\n`
        + `label       ${device.label}\n`
        + `created     ${device.createdAt}\n`
        + `\n`
        + `token       ${token}\n`
        + `\n`
        + 'This token is shown once and is not recoverable: only its SHA-256 is stored.\n'
        + 'Put it in the phone under Settings -> Server -> Device token, together with\n'
        + `this server's url. If you lose it, run \`bfwp-device add\` again and remove the old device.\n`,
      );
      return 0;
    }

    case 'list': {
      const devices = store.list();
      if (devices.length === 0) {
        process.stdout.write('no devices are registered\n');
        return 0;
      }
      for (const device of devices) {
        process.stdout.write(
          `${device.disabled ? 'disabled' : 'enabled '}  ${device.deviceId}  ${device.createdAt}  ${device.label}\n`,
        );
      }
      return 0;
    }

    case 'remove': {
      const deviceId = rest[0];
      if (!deviceId) {
        process.stderr.write('remove needs a device id\n');
        return 1;
      }
      if (!store.remove(deviceId)) {
        process.stderr.write(`no device with id ${deviceId}\n`);
        return 1;
      }
      process.stdout.write(`removed ${deviceId}\n`);
      return 0;
    }

    case 'disable':
    case 'enable': {
      const deviceId = rest[0];
      if (!deviceId) {
        process.stderr.write(`${command} needs a device id\n`);
        return 1;
      }
      const disabled = command === 'disable';
      if (!store.setDisabled(deviceId, disabled)) {
        process.stderr.write(`no device with id ${deviceId}\n`);
        return 1;
      }
      process.stdout.write(`${disabled ? 'disabled' : 'enabled'} ${deviceId}\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      usage(process.stderr);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)));
