import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceId, deviceIdentity } from '../src/device.js';

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

test('without an OS ID the user name and git email give a saved ID in the server shape', () => {
  const files = new Map();
  const home = '/h';
  const opts = (email, user = 'root') => ({
    platform: 'linux', home, username: () => user, env: {},
    readFile: file => { if (files.has(file)) return files.get(file); throw new Error('absent'); },
    writeFile: (file, data) => files.set(file, data),
    // the lookup a commit would use: system, global and repository config, not `--global` alone. A machine
    // configured in /etc/gitconfig (an image built with one) or per repository had no email at all before.
    exec: (command, args) => { assert.equal(command, 'git'); assert.deepEqual(args, ['config', 'user.email']); return email; },
  });
  const first = deviceIdentity(opts('Ct@Example.com\n'));
  assert.equal(first.source, 'user');
  assert.match(first.id, /^v1:[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(files.get('/h/state/device-id')), { id: first.id, source: 'user' });
  // saved: a later git config change keeps the ID
  assert.deepEqual(deviceIdentity(opts('other@example.com')), first);
  files.clear();
  assert.equal(deviceIdentity(opts('ct@example.com')).id, first.id, 'a rebuilt container derives the same ID');
  files.clear();
  assert.notEqual(deviceIdentity(opts('ct@example.com', 'node')).id, first.id);
  files.clear();
  assert.notEqual(deviceIdentity(opts('someone@example.com')).id, first.id);
  files.clear();
  assert.deepEqual(deviceIdentity(opts('')), { id: null, source: null }, 'the user name alone is shared by everyone');
  assert.equal(files.size, 0);
});

test('an OS ID wins over the user fallback and is reported as such', () => {
  const files = new Map();
  const identity = deviceIdentity({ platform: 'linux', home: '/h', env: {},
    readFile: file => (files.has(file) ? files.get(file) : file.startsWith('/etc/machine-id') ? uuid.replaceAll('-', '') : (() => { throw new Error('absent'); })()),
    writeFile: (file, data) => files.set(file, data), exec: () => 'x@y.z' });
  assert.deepEqual(identity, { id: getDeviceId({ platform: 'linux', readFile: () => uuid.replaceAll('-', '') }), source: 'os' });
  assert.deepEqual(JSON.parse(files.get('/h/state/device-id')), { id: identity.id, source: 'os' }, 'written down the first time it is found');
});

// 18 of 256 latest snapshots in production had no device on 2026-11-05, every one of them linux. The three
// causes below are what they were; the fourth case is a Mac that identified itself twice.
test('a command that timed out does not turn a known machine into a second device', () => {
  const files = new Map();
  const opts = over => ({
    platform: 'darwin', home: '/h', env: {}, username: () => 'me',
    readFile: file => { if (files.has(file)) return files.get(file); throw new Error('absent'); },
    writeFile: (file, data) => files.set(file, data),
    exec: () => `    "IOPlatformUUID" = "${uuid}"`, ...over,
  });
  const found = deviceIdentity(opts());
  assert.equal(found.source, 'os');
  // ioreg is run with a 1s timeout, and a timeout looks exactly like a machine with no identifier. The
  // user-derived id it used to fall to is a different id for the same Mac, so the machine read as two.
  const afterTimeout = deviceIdentity(opts({ exec: () => { throw new Error('ETIMEDOUT'); } }));
  assert.equal(afterTimeout.id, found.id, 'the same machine, the same id');
  assert.equal(afterTimeout.source, 'saved', 'and the report says the id was read back, not measured');
});

test('a machine may name its own device, for a fleet that shares none', () => {
  // A CI runner, a devcontainer image or a cloud workspace has no stable OS identifier and often no email.
  const a = deviceIdentity({ platform: 'linux', env: { THINKER_DEVICE_ID: 'ci-runner-pool' }, readFile: () => '' });
  const b = deviceIdentity({ platform: 'darwin', env: { THINKER_DEVICE_ID: 'ci-runner-pool' }, exec: () => `    "IOPlatformUUID" = "${uuid}"` });
  assert.equal(a.source, 'set');
  assert.equal(a.id, b.id, 'what the machine says wins over what its OS says');
  assert.match(a.id, /^v1:[a-f0-9]{64}$/);
  assert.ok(!a.id.includes('ci-runner-pool'), 'hashed, so a hostname or an account name is never sent');
  const given = 'v1:' + 'a'.repeat(64);
  assert.equal(deviceIdentity({ platform: 'linux', env: { THINKER_DEVICE_ID: given }, readFile: () => '' }).id, given, 'an id already in the shape is taken as it is');
});

test('an email from the environment identifies a container whose git config has none', () => {
  const files = new Map();
  const base = {
    platform: 'linux', home: '/h', username: () => 'node',
    readFile: file => { if (files.has(file)) return files.get(file); throw new Error('absent'); },
    writeFile: (file, data) => files.set(file, data),
    exec: () => { throw new Error('no git'); },
  };
  const withEnv = deviceIdentity({ ...base, env: { GIT_AUTHOR_EMAIL: 'Dev@Example.com' } });
  assert.equal(withEnv.source, 'user');
  files.clear();
  assert.equal(deviceIdentity({ ...base, env: { EMAIL: 'dev@example.com' } }).id, withEnv.id, 'the same person, the same id');
  files.clear();
  assert.deepEqual(deviceIdentity({ ...base, env: {} }), { id: null, source: null }, 'nothing to go on stays unknown, never guessed');
});
