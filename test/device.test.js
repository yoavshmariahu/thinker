import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceId } from '../src/device.js';

const uuid = '12345678-90AB-CDEF-1234-567890ABCDEF';

test('device ID is a stable application-specific hash independent of installation homes', () => {
  const options = { platform: 'linux', readFile: () => uuid.replaceAll('-', '') };
  const first = getDeviceId({ ...options, home: '/one' });
  const second = getDeviceId({ ...options, home: '/another' });
  assert.match(first, /^v1:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.equal(first, getDeviceId({ platform: 'linux', readFile: () => uuid.toLowerCase() + '\n' }));
  assert.ok(!first.includes(uuid.toLowerCase().replaceAll('-', '')));
  assert.notEqual(first, getDeviceId({ platform: 'linux', readFile: () => 'abcdef1234567890abcdef1234567890' }));
});

test('macOS and Windows read only the OS identifier with bounded commands', () => {
  for (const platform of ['darwin', 'win32']) {
    const id = getDeviceId({ platform, exec: (command, args, options) => {
      assert.equal(options.timeout, 1000);
      assert.equal(options.stdio[2], 'ignore');
      if (platform === 'darwin') {
        assert.equal(command, '/usr/sbin/ioreg');
        assert.deepEqual(args, ['-rd1', '-c', 'IOPlatformExpertDevice']);
        return `    "IOPlatformUUID" = "${uuid}"`;
      }
      assert.equal(command, 'reg.exe');
      assert.ok(args.includes('MachineGuid'));
      assert.ok(args.includes('/reg:64'));
      return `    MachineGuid    REG_SZ    ${uuid}\r\n`;
    } });
    assert.match(id, /^v1:[a-f0-9]{64}$/);
  }
});

test('Linux falls back to dbus ID and unavailable or placeholder IDs stay unknown', () => {
  const paths = [];
  assert.match(getDeviceId({ platform: 'linux', readFile: file => {
    paths.push(file);
    if (file === '/etc/machine-id') throw new Error('absent');
    return uuid;
  } }), /^v1:/);
  assert.deepEqual(paths, ['/etc/machine-id', '/var/lib/dbus/machine-id']);
  for (const value of ['', 'uninitialized', '0'.repeat(32), 'f'.repeat(32), 'hostname', '1234']) {
    assert.equal(getDeviceId({ platform: 'linux', readFile: () => value }), null);
  }
  assert.equal(getDeviceId({ platform: 'darwin', exec: () => { throw new Error('timeout'); } }), null);
  assert.equal(getDeviceId({ platform: 'win32', exec: () => 'not found' }), null);
  assert.equal(getDeviceId({ platform: 'unsupported' }), null);
});
