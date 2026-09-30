// Derive an application-specific pseudonymous ID; never persist or transmit the
// OS machine identifier itself. Independent of THINKER_HOME and installation ID.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function getDeviceId({ platform = process.platform, readFile = fs.readFileSync, exec = execFileSync } = {}) {
  const commandOptions = { encoding: 'utf8', timeout: 1000, maxBuffer: 256 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  const validId = value => {
    const id = String(value || '').trim().replaceAll('-', '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) && !/^f+$/.test(id) ? id : null;
  };
  let machineId;
  try {
    if (platform === 'darwin') {
      const output = exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], commandOptions);
      machineId = validId(output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]);
    } else if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { machineId = validId(readFile(file, 'utf8')); } catch {}
        if (machineId) break;
      }
    } else if (platform === 'win32') {
      const output = exec('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], commandOptions);
      machineId = validId(output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1]);
    }
  } catch { return null; }
  if (!machineId) return null; // No fabricated device when the OS ID is unavailable.
  return 'v1:' + crypto.createHmac('sha256', Buffer.from(machineId, 'hex'))
    .update(`thinker:telemetry:device:v1:${platform}`).digest('hex');
}
