// Which coding agents are on this machine, supported by thinker or not, and how long ago each was used.
// Telemetry sends the names, a supported flag and an age in days (telemetry.js:buildTelemetryPayload,
// clients.harnesses), nothing else. 2026-10-17: installs on machines with no supported agent could not be
// told from empty machines on the dashboard, and nothing said whether they ran an agent thinker cannot
// wire; `thinker update` reaches every install daily, so the detection ships with the next release and
// each install reports it right after updating (telemetry.js:sendTelemetryAfterUpdate).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_SCOPE_CLIENTS } from './clients.js';

const DAY = 864e5;

// Evidence per harness: directories or files under the home directory, binaries on PATH, and VS Code
// extension ids (their state lives under an editor's User/globalStorage). The first eight are the
// agents thinker wires (clients.js:USER_SCOPE_CLIENTS); the rest are counted so that an install on a
// machine that runs one of them reads as what it is.
export const HARNESSES = [
  { name: 'claude', dirs: ['.claude'], bins: ['claude'] },
  { name: 'codex', dirs: ['.codex'], bins: ['codex'] },
  { name: 'cursor', dirs: ['.cursor'], bins: ['cursor', 'cursor-agent'] },
  { name: 'gemini', dirs: ['.gemini'], bins: ['gemini', 'agy'] },
  { name: 'pi', dirs: ['.pi'], bins: ['pi'] },
  { name: 'opencode', dirs: ['.config/opencode'], bins: ['opencode'] },
  { name: 'copilot', dirs: ['.copilot'], bins: ['copilot'] },
  { name: 'windsurf', dirs: ['.codeium/windsurf'], bins: ['windsurf'] },
  { name: 'cline', dirs: ['.cline'], bins: ['cline'], extensions: ['saoudrizwan.claude-dev'] },
  { name: 'roo', dirs: ['.roo'], extensions: ['rooveterinaryinc.roo-cline'] },
  { name: 'kilo', dirs: ['.kilocode'], extensions: ['kilocode.kilo-code'] },
  { name: 'continue', dirs: ['.continue'], extensions: ['continue.continue'] },
  { name: 'augment', dirs: ['.augment'], bins: ['auggie'], extensions: ['augment.vscode-augment'] },
  { name: 'copilot-chat', extensions: ['github.copilot-chat'] },
  { name: 'aider', dirs: ['.aider.conf.yml', '.aider.chat.history.md', '.aider'], bins: ['aider'] },
  { name: 'zed', dirs: ['.config/zed', 'Library/Application Support/Zed'], bins: ['zed'] },
  { name: 'kiro', dirs: ['.kiro'], bins: ['kiro', 'kiro-cli'] },
  { name: 'junie', dirs: ['.junie'] },
  { name: 'amp', dirs: ['.config/amp'], bins: ['amp'] },
  { name: 'goose', dirs: ['.config/goose'], bins: ['goose'] },
  { name: 'openhands', dirs: ['.openhands'] },
  { name: 'crush', dirs: ['.config/crush'], bins: ['crush'] },
  { name: 'droid', dirs: ['.factory'], bins: ['droid'] },
  { name: 'qwen', dirs: ['.qwen'], bins: ['qwen'] },
  { name: 'antigravity', dirs: ['.antigravity', 'Library/Application Support/Antigravity'] },
];

const EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

// The globalStorage directories of the VS Code family on this platform.
export function editorStorageDirs({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return EDITORS.map(e => path.join(base, e, 'User', 'globalStorage'));
}

const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };
const onPath = (bin, env) => (env.PATH || '').split(path.delimiter).some(d => d && exists(path.join(d, bin)));

// Days since the newest change in the places found: each place itself and its immediate children.
function ageDays(places, now) {
  let newest = 0;
  for (const p of places) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) continue;
    let names = []; try { names = fs.readdirSync(p).slice(0, 200); } catch {}
    for (const n of names) { try { newest = Math.max(newest, fs.statSync(path.join(p, n)).mtimeMs); } catch {} }
  }
  return newest ? Math.max(0, Math.floor((now - newest) / DAY)) : null;
}

// { name: { supported, lastUsedDays } } for every harness with evidence; lastUsedDays is null when only
// a binary was found. Names only: no paths, versions or settings.
export function detectHarnesses({ home = os.homedir(), platform = process.platform, env = process.env, now = Date.now() } = {}) {
  const storage = editorStorageDirs({ home, platform, env });
  const out = {};
  for (const h of HARNESSES) {
    const places = [...(h.dirs || []).map(d => path.join(home, d)), ...storage.flatMap(s => (h.extensions || []).map(e => path.join(s, e)))].filter(exists);
    if (!places.length && !(h.bins || []).some(b => onPath(b, env))) continue;
    out[h.name] = { supported: USER_SCOPE_CLIENTS.includes(h.name), lastUsedDays: places.length ? ageDays(places, now) : null };
  }
  return out;
}
