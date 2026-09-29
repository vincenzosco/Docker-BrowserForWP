#!/usr/bin/env node
// Device administration.
//
// There IS a page now -- src/register.js, reachable on BFWP_REGISTER_PORT -- and
// it mints the same single-use digest this command does, because the people who
// need a token are the people holding the phones and not the people with a shell
// on the server. What it did not become is an account system: no password
// database, no reset flow, no support burden. Minting is all it does.
//
// This command remains the interface for everything that is NOT minting: seeing
// which phone holds which token, refusing one, forgetting one, and the only way a
// token ever moves from one phone to another.
//
// `add` prints the token once and never again, because only its digest is
// stored. Losing it costs one command, not the registry.
//
// THE ID IS A NAME, NOT A SECRET, and the printed one is for the registry rather
// than for the phone's settings (which have no field for it). A token belongs to
// the FIRST device that uses it; `release` is how an operator hands it to a
// different phone on purpose.

import { loadConfig } from '../src/config.js';
import { DeviceStore } from '../src/devices.js';

const USAGE = `BrowserForWP render server — device registry

  bfwp-device add "<label>"       register a device and print its token ONCE
  bfwp-device list                list registered devices, and who claimed each token
  bfwp-device release <deviceId>  let a different phone claim that token
  bfwp-device remove <deviceId>   forget a device
  bfwp-device disable <deviceId>  refuse a device without forgetting it
  bfwp-device enable <deviceId>   allow it again

The registry is ${'${BFWP_DEVICES_FILE}'} (default /var/lib/bfwp/devices.json).
A token is claimed by the first device that uses it, and refused for any other
until it is released. Phones can also ask for a token on the registration page
(BFWP_REGISTER_PORT, loopback only unless you set a secret).
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
        + `this server's url. The id above is the registry's name for the device, not\n`
        + 'something to type into the phone, which has no field for it.\n'
        + '\n'
        + 'The token is claimed by the FIRST device that uses it, and refused for any\n'
        + `other: replacing the phone means \`bfwp-device release ${device.deviceId}\` first.\n`
        + 'If you lose the token, run `bfwp-device add` again and remove the old device.\n',
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
        const claim = device.boundDeviceId ? `claimed by ${device.boundDeviceId}` : 'unbound';
        process.stdout.write(
          `${device.disabled ? 'disabled' : 'enabled '}  ${device.deviceId}  ${device.createdAt}  ${claim}  ${device.label}\n`,
        );
      }
      return 0;
    }

    case 'release': {
      const deviceId = rest[0];
      if (!deviceId) {
        process.stderr.write('release needs a device id\n');
        return 1;
      }
      if (!store.find(deviceId)) {
        process.stderr.write(`no device with id ${deviceId}\n`);
        return 1;
      }
      if (!store.releaseBinding(deviceId)) {
        process.stdout.write(`${deviceId} is not claimed by any device; nothing to release\n`);
        return 0;
      }
      process.stdout.write(`released ${deviceId}: its token may be claimed by another phone now\n`);
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
