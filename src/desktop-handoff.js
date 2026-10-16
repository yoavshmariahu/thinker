// The warm-up handed to a desktop app. The installer, `thinker warmup` and the warm-up page run outside every
// app, and a desktop app's login does not sign in an agent CLI. So the warm-up can go through the app itself:
// a link opens a new session there, in the repository, with a message filled in that asks the agent to run
// `thinker warmup --answer warm`. Inside the app that answer takes the app's own route (repo-onboard.js:
// answerWarmup: a background subagent on the app's model). Nothing is sent: the person reads the message and
// presses Enter. Claude Desktop (claude://code/new) and Cursor (cursor://anysphere.cursor-deeplink/prompt)
// take such links; the Codex app needs none, its bundled CLI shares the app's ~/.codex login (llm.js:findBin).
// macOS only: the bundles, the sign-in records and `open` are the Mac's. Tried end to end in Cursor on
// 2026-10-16 (hook, app detection, session build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isTestMode } from './test-mode.js';

const support = home => path.join(home, 'Library', 'Application Support');
const bundle = (home, app) => [path.join('/Applications', app), path.join(home, 'Applications', app)];

// Signed in is read from the app's own records, by the presence of its token (never its value): Claude
// Desktop keeps an OAuth token cache in config.json, Cursor an access token in its state database. A token
// that has expired still reads as signed in; the session the link opens then asks to sign in, in the app.
export const HANDOFF_APPS = {
  claude: {
    name: 'Claude Desktop',
    bundles: home => bundle(home, 'Claude.app'),
    signedIn(home, { readFn }) {
      let j; try { j = JSON.parse(readFn(path.join(support(home), 'Claude', 'config.json'), 'utf8')); } catch { return { signedIn: false }; }
      return { signedIn: Boolean(j['oauth:tokenCacheV2'] || j['oauth:tokenCache']) };
    },
  },
  cursor: {
    name: 'Cursor',
    bundles: home => bundle(home, 'Cursor.app'),
    signedIn(home, { execFn }) {
      const db = path.join(support(home), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
      const q = sql => execFn('sqlite3', ['-readonly', db, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
      try {
        if (q("select count(*) from ItemTable where key = 'cursorAuth/accessToken' and length(value) > 0") !== '1') return { signedIn: false };
        let account = null; try { account = q("select value from ItemTable where key = 'cursorAuth/cachedEmail'").replace(/^"|"$/g, '') || null; } catch {}
        return { signedIn: true, account };
      } catch { return { signedIn: false }; }
    },
  },
};

// The desktop apps on this machine a warm-up can be handed to: [{ app, name, signedIn, account }]
// (none under the test suite unless a test passes its own home: the suite must not see the machine's apps)
export function desktopApps({ platform = process.platform, home, existsFn = fs.existsSync, readFn = fs.readFileSync, execFn = execFileSync } = {}) {
  if (platform !== 'darwin' || (!home && isTestMode())) return [];
  home ||= os.homedir();
  const out = [];
  for (const [app, a] of Object.entries(HANDOFF_APPS)) {
    if (!a.bundles(home).some(b => existsFn(b))) continue;
    out.push({ app, name: a.name, ...a.signedIn(home, { readFn, execFn }) });
  }
  return out;
}

// The message the session opens with: what thinker is, what the warm-up does, and one command to run
export function handoffMessage(app, repoName) {
  return `Warm up Thinker for this repository.\n\nThinker reads ${repoName}'s merged pull requests into notes that your future sessions here can use. It runs in the background, on this app's own sign-in, and does not change any code.\n\nPlease run \`thinker warmup --answer warm --client ${app}\` and follow what it prints.`;
}

export function handoffUrl(app, repo) {
  const q = encodeURIComponent(handoffMessage(app, path.basename(repo)));
  if (app === 'claude') return `claude://code/new?q=${q}&folder=${encodeURIComponent(repo)}&source=thinker`;
  // workspace: Cursor routes the prompt to the window that has the repository open
  if (app === 'cursor') return `cursor://anysphere.cursor-deeplink/prompt?text=${q}&workspace=${encodeURIComponent(path.basename(repo))}`;
  throw new Error(`no hand-off for ${app}`);
}

// Open the session. Cursor's prompt link fills the chat of a window, so the repository's window opens first.
export async function openHandoff(app, repo, { spawnFn = spawnSync, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const run = args => { const r = spawnFn('open', args, { stdio: 'ignore' }); if (r.error || r.status !== 0) throw new Error(r.error?.message || `open exited ${r.status}`); };
  if (app === 'cursor') { run(['-a', 'Cursor', repo]); await wait(3000); }
  run([handoffUrl(app, repo)]);
}

// How far the warm-up handed off at `since` (ms) has come: 'none'; 'started' once the session ran the answer,
// which asks for a session build (session-llm.js:requestBuild) or once that build runs (its build.json); 'working' once a
// subagent of the session takes a call off the queue (session-llm.js: a claimed or answered request). Started
// alone is not enough: a session whose thinker tools did not load (2026-10-16, click: a stale .mcp.json) runs
// the answer, then has nothing to work the queue with, and the build waits until it gives up.
export function handoffProgress(repo, since) {
  const dir = path.join(repo, '.thinker', 'state', 'session-llm');
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  // the answer asks for the build (build-request.json) and the server starts it when the subagent comes
  const b = read('build.json'), asked = read('build-request.json');
  if (!(Date.parse(b?.started) >= since)) return Date.parse(asked?.t) >= since ? 'started' : 'none';
  let files = []; try { files = fs.readdirSync(dir); } catch {}
  if (files.some(f => /\.(claimed|res)\.json$/.test(f))) return 'working';
  try { if (/PR mining: [1-9]\d*\/\d+ processed/.test(fs.readFileSync(path.join(repo, '.thinker', 'state', 'warmup.log'), 'utf8').slice(-20_000))) return 'working'; } catch {}
  return 'started';
}
