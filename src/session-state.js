// A session's own state for the hooks: the turn counter the prompt hook advances and the later hooks read, the
// per-session file the profile and the diet keep their marks in, the lock that keeps two hooks of one session
// from reading the same state, and what a prompt that is no request looks like. These lived in ops.js beside the
// note serving until the notes went (2026-11-08).
import fs from 'node:fs';
import path from 'node:path';

export function sessionState(store, session) {
  const f = path.join(store.dir, 'state', `session-${String(session).replace(/[^\w-]/g, '')}.json`);
  let st = { turn: [] }; try { st = { ...st, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch {}
  return { st, save: () => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(st)); } };
}
// Hooks of one session can run at the same moment. Unlocked, two of them read the same state and both act.
export function locked(store, session, fn) {
  const lock = path.join(store.dir, 'state', `session-${String(session).replace(/[^\w-]/g, '')}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + 3000; ;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST' || Date.now() > until) break; } // a lock this old was left by a hook that died
    Atomics.wait(wait, 0, 0, 25);
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// `holdout` in .thinker/config.json is the share of sessions the profile is held out of (0 or false: none);
// THINKER_HOLDOUT overrides it (`0`, `off`, or a share). The proxy's clearing has a holdout of its own.
export const HOLDOUT_DEFAULT = 0.15;
export function holdoutRate(store) {
  const env = process.env.THINKER_HOLDOUT;
  const raw = env !== undefined && env !== '' ? env : store.config().holdout;
  if (raw === undefined || raw === null) return HOLDOUT_DEFAULT;
  if (raw === false || /^(off|no|false)$/i.test(String(raw))) return 0;
  const r = Number(raw);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : HOLDOUT_DEFAULT;
}

// Claude Code delivers some events of its own as prompts: a background task's notification, a subagent's
// or another session's message, a CI or side-session event. On 2026-10-18 they were a share of this
// repository's prompts, each counted a turn of the user's.
const HARNESS_EVENT = /^\s*<(task-notification|agent-message|side-sessions-event|ci-monitor-event|system-reminder|local-command-(stdout|stderr|caveat)|command-name)\b/;
// The Codex desktop app asks for a suggested next message through the prompt hook too, in plain text with no tag.
const APP_GENERATED = /^\s*(This is an app-generated request\b|# Overview\s+Generate \d+ to \d+ hyperpersonalized suggestions\b)/;
// The Cline CLI fires its prompt hook for its own nudges, never for the person's prompt (cline 3.0.73, 2026-10-19).
const CLINE_NUDGE = /^\s*\[SYSTEM\] This run is not complete\b/;
export const isHarnessEvent = prompt => { const p = String(prompt || ''); return HARNESS_EVENT.test(p) || APP_GENERATED.test(p) || CLINE_NUDGE.test(p); };

// The prompt hook opens the session's next turn: its number, which the tool and stop hooks, the diet, the
// compression clock and the session's log row carry.
export function beginTurn(store, session) {
  if (!session || session === 'unknown' || !store.exists()) return { turn: 0 };
  return locked(store, session, () => {
    const { st, save } = sessionState(store, session);
    st.turnNo = (st.turnNo || 0) + 1;
    save();
    return { turn: st.turnNo };
  });
}
// The turn the tool and stop hooks are in, as the prompt hook left it; turn 0 when no prompt hook ran.
export function currentTurn(store, session) {
  if (!session || session === 'unknown' || !store.exists()) return { turn: 0 };
  const { st } = sessionState(store, session);
  return { turn: st.turnNo || 0 };
}
