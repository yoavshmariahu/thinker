// Derive an application-specific pseudonymous ID; never persist or transmit the
// OS machine identifier itself. Independent of THINKER_HOME and installation ID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DEVICE_ID = /^v1:[a-f0-9]{64}$/;   // the shape the metrics server accepts (infra/metrics/report.mjs)
const commandOptions = { encoding: 'utf8', timeout: 1000, maxBuffer: 256 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

export function getDeviceId(opts = {}) {
  return deviceIdentity(opts).id;
}

// { id, source }: 'os' when the OS machine identifier was hashed, 'saved' when a previous run's `os` id was
// read back, 'user' when neither was available (containers ship an empty /etc/machine-id: node:22,
// node:22-slim and the devcontainer images, 2026-10-16) and the user name and an email were hashed instead,
// 'set' when the machine names its own id, and `null` when the device cannot be identified at all.
//
// Devcontainers copy the host's git config in, so the user ID survives container rebuilds; it is saved under
// THINKER_HOME so it stays put while the home does. Without an email the device stays unknown: the user name
// alone (root, node) is shared by everyone, and a guess would merge every container on earth into one device.
//
// Two faults this answers, both read off production telemetry on 2026-11-05 (18 of 256 latest snapshots had
// no device):
//   * `ioreg` and `reg.exe` are run with a 1s timeout, and a timeout is indistinguishable here from a machine
//     with no identifier. One slow moment on a Mac used to drop it to the user-derived id -- a different id
//     for the same machine, so it read as a second device. An `os` id is written down the first time it is
//     found and read back when the command fails, so the identity does not move.
//   * the email came from `git config --global user.email` alone, so a machine configured at system level
//     (`/etc/gitconfig`, common in a built image), per repository, or through the environment had none. The
//     lookup is now the one a commit would use.
export function deviceIdentity({
  platform = process.platform, readFile = fs.readFileSync, exec = execFileSync,
  home, writeFile = fs.writeFileSync, username = () => os.userInfo().username, env = process.env,
} = {}) {
  // A fleet that wants to be one device -- a CI runner, a devcontainer image, a cloud workspace -- says so
  // itself. Hashed, never sent as given, so naming a hostname or an account here discloses nothing.
  const set = String(env.THINKER_DEVICE_ID || '').trim();
  if (set) return { id: DEVICE_ID.test(set) ? set : 'v1:' + crypto.createHmac('sha256', 'thinker:telemetry:device:set:v1').update(set).digest('hex'), source: 'set' };

  const file = home ? path.join(home, 'state', 'device-id') : null;
  const machineId = osMachineId({ platform, readFile, exec });
  if (machineId) {
    const id = 'v1:' + crypto.createHmac('sha256', Buffer.from(machineId, 'hex'))
      .update(`thinker:telemetry:device:v1:${platform}`).digest('hex');
    remember(file, { id, source: 'os' }, { writeFile, readFile });
    return { id, source: 'os' };
  }
  const saved = recall(file, { readFile });
  // An id this machine's OS gave before: the command failed this once, the machine did not change.
  if (saved?.source === 'os') return { id: saved.id, source: 'saved' };
  if (saved?.id) return { id: saved.id, source: 'user' };
  if (!file) return { id: null, source: null };
  let email = '', user = '';
  try { email = String(exec('git', ['config', 'user.email'], commandOptions)).trim().toLowerCase(); } catch {}
  for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    if (!email) email = String(env[name] || '').trim().toLowerCase();
  }
  try { user = username(); } catch {}
  if (!email) return { id: null, source: null };
  const id = 'v1:' + crypto.createHmac('sha256', 'thinker:telemetry:device:user:v1').update(`${user}\n${email}`).digest('hex');
  remember(file, { id, source: 'user' }, { writeFile, readFile });
  return { id, source: 'user' };
}

// The id and which door produced it, so a saved `os` id is not mistaken for a derived one. A bare id on a
// line is what versions before 2026-11-05 wrote, and that was always the user-derived one.
function recall(file, { readFile }) {
  if (!file) return null;
  let text = '';
  try { text = String(readFile(file, 'utf8')).trim(); } catch { return null; }
  if (DEVICE_ID.test(text)) return { id: text, source: 'user' };
  try {
    const r = JSON.parse(text);
    if (DEVICE_ID.test(String(r?.id || ''))) return { id: r.id, source: r.source === 'os' ? 'os' : 'user' };
  } catch {}
  return null;
}

function remember(file, { id, source }, { writeFile, readFile = fs.readFileSync }) {
  if (!file) return;
  const saved = recall(file, { readFile });
  if (saved?.id === id && saved?.source === source) return;   // nothing to write on the ordinary run
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  try { writeFile(file, JSON.stringify({ id, source }) + '\n'); } catch { /* a read-only home identifies by the OS anyway */ }
}

function osMachineId({ platform, readFile, exec }) {
  const validId = value => {
    const id = String(value || '').trim().replaceAll('-', '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) && !/^f+$/.test(id) ? id : null;
  };
  try {
    if (platform === 'darwin') {
      const output = exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], commandOptions);
      return validId(output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]);
    } else if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        let id = null;
        try { id = validId(readFile(file, 'utf8')); } catch {}
        if (id) return id;
      }
    } else if (platform === 'win32') {
      const output = exec('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], commandOptions);
      return validId(output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1]);
    }
  } catch {}
  return null;
}
