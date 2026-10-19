// The Claude desktop app's Code tab, for `thinker harness`. Its sessions are Claude Code sessions with
// the same transcript (harness.js:sessionHarness), but the app adds to each one what the transcript does
// not record: the claude.ai connectors it passes in (their always-loaded tool definitions), and its own
// instructions, appended to the system prompt. The app keeps both in its record of the session,
// <app data>/Claude/claude-code-sessions/<account>/<org>/local_<id>.json, keyed to the transcript by
// `cliSessionId`: `remoteMcpServersConfig` (each connector's uuid, name and tools, the always-loaded ones
// marked `_meta["anthropic/alwaysLoad"]`) and `promptAppendSnapshot.append` (the appended text).
// Read from Claude 2.42304.2 (Claude Code 2.1.299) on 2026-10-19.
//
// What switches them off: a connector by the app's Connectors switch (the composer's + menu), which the
// agent flips with `mcp__ccd_connectors__set_session_connector_enabled`; the app makes that the default
// for new sessions on the machine, so it is not per repository. The app's own instructions and its
// built-in tools (browser pane, simulator, session tools) are the app's Settings; thinker reports them and
// switches nothing. The definitions of those built-in tools are not in the record, so they are not counted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estTokens } from './rank.js';

export const CONNECTOR_TOOL = 'mcp__ccd_connectors__set_session_connector_enabled';

// The app's data directory (Electron's userData for "Claude").
export function desktopSessionsDir(home = os.homedir(), platform = process.platform, env = process.env) {
  if (env.THINKER_CLAUDE_DESKTOP_DIR) return env.THINKER_CLAUDE_DESKTOP_DIR;
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(base, 'Claude', 'claude-code-sessions');
}

// Every session record of the app on this machine, by the Claude Code session id its transcript has.
export function desktopRecords(dir = desktopSessionsDir()) {
  const out = new Map();
  const walk = (d, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(f, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (typeof j.cliSessionId === 'string') out.set(j.cliSessionId, j); } catch {}
      }
    }
  };
  walk(dir, 0);
  return out;
}

// The app's own sections of the appended prompt, by where each starts, and the tool server whose calls
// mean a session used it. A section the list does not name is not counted.
const SECTIONS = [
  { key: 'desktop:side-sessions', name: 'starting other sessions', start: /^## Starting other sessions$/m, uses: 'mcp:ccd_session' },
  { key: 'desktop:task-list', name: 'task list and wrap-up', start: /^# Task list and wrap-up\b.*$/m, uses: 'mcp:ccd_turn' },
  { key: 'desktop:browser', name: 'built-in browser', start: /^<browsers>$/m, uses: 'mcp:claude_browser', where: 'Settings → Claude Code → Browser in the desktop app' },
  { key: 'desktop:ios-simulator', name: 'iOS simulator', start: /^<simulator_tools>$/m, uses: 'mcp:claude_code_ios_simulator' },
];
export const DESKTOP_SECTIONS = Object.fromEntries(SECTIONS.map(s => [s.key, s]));

// A section runs from its start to the next known section's (<browsers> takes the <built_in_browser>
// block after it), the last one to the end of the text.
function sections(text) {
  const starts = SECTIONS.map(s => ({ s, at: text.search(s.start) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
  return starts.map((x, i) => ({ ...x.s, text: text.slice(x.at, i + 1 < starts.length ? starts[i + 1].at : text.length) }));
}

// A connector's name as thinker uses it in a question: the characters harness.js allows in an option.
export const connectorName = n => String(n || 'connector').replace(/[^\w.:@\/+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'connector';
const toolTokens = t => estTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }));

// What the app added to one session: tokens by key (connectors as `mcp:<uuid>`, the transcript's key for
// their deferred tools and calls), each connector's name, and the app's sections.
export function desktopSessionHarness(record, { serverKey }) {
  const loaded = new Map(), connectors = new Map(), texts = new Map();
  for (const s of Array.isArray(record?.remoteMcpServersConfig) ? record.remoteMcpServersConfig : []) {
    if (!s?.uuid) continue;
    const key = `mcp:${serverKey(s.uuid)}`, tools = Array.isArray(s.tools) ? s.tools : [];
    const always = tools.filter(t => t?._meta?.['anthropic/alwaysLoad']);
    loaded.set(key, always.reduce((n, t) => n + toolTokens(t), 0));
    connectors.set(serverKey(s.uuid), { id: s.uuid, name: connectorName(s.name), label: String(s.name || '') });
    texts.set(key, `${s.name || ''}. Tools: ${tools.map(t => `${t.name}: ${String(t.description || '').slice(0, 120)}`).join('; ')}`);
  }
  const append = String(record?.promptAppendSnapshot?.append || '');
  for (const s of sections(append)) loaded.set(s.key, estTokens(s.text));
  return { loaded, connectors, texts };
}

// The sessions' usage of the app's sections: a section counts as used when its tools were called.
export function desktopUsed(used) {
  const out = new Set();
  for (const s of SECTIONS) if (used.has(s.uses)) out.add(s.key);
  return out;
}
