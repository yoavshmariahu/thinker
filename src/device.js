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

// { id, source }: source 'os' when the OS machine identifier was hashed, 'user' when it was unavailable
// (containers ship an empty /etc/machine-id: node:22, node:22-slim and the devcontainer images, 2026-10-16)
// and the user name and git email were hashed instead. Devcontainers copy the host's git config in, so the
// user ID survives container rebuilds; it is saved under THINKER_HOME so it stays put while the home does.
// Without a git email the device stays unknown: the user name alone (root, node) is shared by everyone.
export function deviceIdentity({
  platform = process.platform, readFile = fs.readFileSync, exec = execFileSync,
  home, writeFile = fs.writeFileSync, username = () => os.userInfo().username,
} = {}) {
  const machineId = osMachineId({ platform, readFile, exec });
  if (machineId) {
    return { id: 'v1:' + crypto.createHmac('sha256', Buffer.from(machineId, 'hex'))
      .update(`thinker:telemetry:device:v1:${platform}`).digest('hex'), source: 'os' };
  }
  if (!home) return { id: null, source: null };
  const file = path.join(home, 'state', 'device-id');
  try {
    const saved = String(readFile(file, 'utf8')).trim();
    if (DEVICE_ID.test(saved)) return { id: saved, source: 'user' };
  } catch {}
  let email = '', user = '';
  try { email = String(exec('git', ['config', '--global', 'user.email'], commandOptions)).trim().toLowerCase(); } catch {}
  try { user = username(); } catch {}
  if (!email) return { id: null, source: null };
  const id = 'v1:' + crypto.createHmac('sha256', 'thinker:telemetry:device:user:v1').update(`${user}\n${email}`).digest('hex');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  try { writeFile(file, id + '\n'); } catch {}
  return { id, source: 'user' };
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
