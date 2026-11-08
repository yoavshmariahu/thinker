// Background maintenance: what a user would otherwise have to remember to run. Since the knowledge notes went
// (2026-11-08) it spends no tokens of its own: it prunes state files no session will read again, reads the
// repository's pull requests so `thinker prs` knows what the sessions delivered, looks for a container thinker is
// not in, and schedules the weekly context suggestion. It starts from the catch-up learning run (at most every ten
// minutes, from the prompt hooks) and from the git post-commit hook, and runs at most once every four hours, on the
// next activity after it is due. The daily token cap it keeps is what the profile's reads of sessions are bounded
// by (learn.js, profile.js): tokens, not dollars, since the agents run on subscriptions as often as on metered keys.
import fs from 'node:fs';
import path from 'node:path';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { isTestMode } from './test-mode.js';
import { pruneState } from './state-prune.js';
import { syncPrs, ghAvailable, WINDOW_DAYS as DELIVERY_WINDOW_DAYS } from './delivery.js';
import { recordError } from './error-report.js';

export const DEFAULTS = {
  enabled: true,    // `maintain: { enabled: false }` in .thinker/config.json switches it off
  // tokens of reported generative model usage per day that learning may spend (the profile's reads of sessions,
  // about 25k each on Opus); 0: no cap
  dailyTokens: 2_000_000,
  // the one question about a container (containers-offer.js): on, because a session in a container is served
  // nothing at all and the weekly context message cannot carry it (it is built from the sessions thinker can
  // see). `maintain: { containers: false }` stops the machine being looked at.
  containers: true,
  // the week's five highest-leverage context changes (context-suggest.js), passed on at the next prompt with a link to
  // the local page; no model call, nothing changed but by the person on the page. `maintain: { contextSuggest: false }`
  contextSuggest: true,
  // read the repository's pull requests from GitHub, so `thinker prs` and the telemetry know what the
  // sessions here delivered (delivery.js). Free: the person's own `gh` login, read-only, no model call and
  // no token. At most once a day, and only back to the last sync. `maintain: { prSync: false }` turns it off.
  prSync: true,
};
export const MAINTENANCE_INTERVAL_MS = 4 * 60 * 60_000;
export const PRS_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
const LOCK_MS = 15 * 60_000;

export function maintainConfig(store) {
  const c = store.config().maintain;
  return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
}

// Tokens the model calls of learning and maintenance reported since local midnight.
export function spentToday(store, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const since = start.toISOString();
  let total = 0;
  for (const e of readLog(store)) {
    if (e.t >= since && e.op === 'model' && ['learning', 'maintenance'].includes(e.phase) && typeof e.tokens?.totalTokens === 'number') total += e.tokens.totalTokens;
  }
  return total;
}

// The daily cap has always been documented as covering learning and maintenance together, but
// only maintenance consulted it: the end-of-turn distillation of a session, which is where most
// of the tokens go, spent freely. Every caller about to spend asks this first. A cap of 0
// means no cap. The cap was in dollars (`dailyCap`) until October 2026; that key is ignored
// now, except that a `dailyCap` of 0 or false still means no cap.
export function withinDailyCap(store, { now = new Date(), spentFn = spentToday } = {}) {
  const cfg = maintainConfig(store);
  const set = store.config().maintain;
  const legacyOff = 'dailyCap' in cfg && !cfg.dailyCap && !(set && typeof set === 'object' && 'dailyTokens' in set);
  const cap = legacyOff ? 0 : Number(cfg.dailyTokens);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true, spent: 0, cap: 0 };
  const spent = spentFn(store, now);
  return { ok: spent < cap, spent, cap };
}

function capDay(now) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
}
function capNoticeFile(store) { return path.join(store.dir, 'state', 'cap-notice.json'); }
function capWasReported(store, day) {
  try { return JSON.parse(fs.readFileSync(capNoticeFile(store), 'utf8')).day === day; } catch { return false; }
}

// Said once per local day, at the end of a turn: learning stopped because the day's tokens are used up.
export function reportCapped(store, { spent, cap }, { now = new Date() } = {}) {
  const day = capDay(now);
  if (capWasReported(store, day)) return;
  const state = readState(store);
  const u = state.unreported || {};
  u.capped = { spent, cap, day };
  state.unreported = u;
  try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
}

// A step that fails is named, with its message: the count alone ("1 failed") sent a person running the
// steps by hand to find that the pull-request sync wanted a github.com origin (2026-11-01).
const ERROR_MESSAGE = 200;
const failMessage = e => String(e?.message || e || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, ERROR_MESSAGE);

function stateFile(store) { return path.join(store.dir, 'state', 'maintain.json'); }
function readState(store) { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return {}; } }

// One run. `fns` lets the CLI pass PR mining in and tests pass everything in.
export async function maintain(store, repo, { dry = false, fns = {}, now = Date.now() } = {}) {
  const cfg = maintainConfig(store);
  if (!cfg.enabled || /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '')) return { skipped: 'disabled' };
  const stateDir = path.join(store.init().dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'maintain.lock');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' };
    if (!dry) fs.rmSync(lock, { force: true });
  } catch {}
  if (!dry) {
    // Exclusive creation keeps simultaneous prompt/commit hooks from starting two batches.
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') return { skipped: 'locked' }; throw e; }
  }
  const state = readState(store);
  const lastRun = Date.parse(state.startedAt || state.at);
  if (!dry && Number.isFinite(lastRun) && now - lastRun < MAINTENANCE_INTERVAL_MS) {
    fs.rmSync(lock, { force: true });
    // A cooldown is not recovery from the previous batch's errors. Queued session work
    // must retain its retry until a due batch actually succeeds.
    return { skipped: 'not-due', ...(state.last?.errors ? { errors: state.last.errors, ...(state.last.errorList?.length ? { errorList: state.last.errorList } : {}) } : {}) };
  }
  // Persist before any model calls: failed/interrupted batches must not retry every prompt.
  if (!dry) {
    state.startedAt = new Date(now).toISOString();
    fs.writeFileSync(stateFile(store), JSON.stringify(state));
  }
  const r = { prSynced: 0, tokens: 0, errors: 0, errorList: [] };
  // every swallowed step error: counted, named on the result and in the state file, and recorded for the
  // consent-gated error report (error-report.js, which scrubs paths and does nothing in test mode)
  const failed = (step, e) => {
    r.errors++;
    r.errorList.push({ step, message: failMessage(e) });
    try { recordError(`maintain.${step.split(' ')[0]}`, e, { repo: store.repo }); } catch {}
  };
  const spent = (fns.spentToday || spentToday)(store);
  const cap = withinDailyCap(store, { spentFn: () => spent }).cap;
  try {
    // 1. state files no session will read again (state-prune.js)
    if (!dry) { try { r.pruned = pruneState(store.dir, { now }).length; } catch (e) { failed('prune', e); } }
    // 2. the repository's pull requests, so what a session delivered is known without anybody typing a
    // command (delivery.js). Free and model-free: the person's own gh login, read-only. Once a day, back to
    // the last sync, so the usual run is one listing page and a detail call for the branches worked on here.
    // A test never reaches GitHub; a test that injects its own reader is testing this step and does.
    const syncFn = fns.syncPrs || (isTestMode() ? null : syncPrs);
    if (cfg.prSync !== false && !dry && syncFn) {
      const last = Date.parse(state.prsSyncedAt || '');
      if (!Number.isFinite(last) || now - last >= PRS_SYNC_INTERVAL_MS) {
        try {
          if (fns.syncPrs || ghAvailable(store.repo)) {
            // The first sync covers the whole report window, so a fresh install is not reporting a third of
            // what it delivered; later ones go back only to the last one.
            const days = Math.min(DELIVERY_WINDOW_DAYS, Number.isFinite(last) ? Math.max(2, Math.ceil((now - last) / 86400_000) + 1) : DELIVERY_WINDOW_DAYS);
            r.prSynced = (await syncFn(store, { days, now })).synced;
          }
        } catch (e) { failed('pr-sync', e); }
        // Recorded whether it worked or not: a repository with no GitHub origin must not try every run.
        state.prsSyncedAt = new Date(now).toISOString();
        try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
      }
    }
    // 3. at most daily, and never from the prompt path: is an agent on this machine running in a container
    // thinker is not inside (containers-offer.js)? The hook asks about what this records; a yes installs it.
    if (cfg.containers !== false && !dry) {
      try { const { scheduleContainersOffer } = await (fns.containers ? { scheduleContainersOffer: fns.containers } : import('./containers-offer.js')); const c = scheduleContainersOffer(store, { now }); if (c) r.containerFound = c.name || c.id; } catch (e) { failed('containers', e); }
    }
    // 4. at most weekly, the five highest-leverage changes the Context view finds (context-suggest.js), for the next prompt
    if (cfg.contextSuggest !== false && !dry) {
      try { const { scheduleContextSuggestion } = await (fns.contextSuggest ? { scheduleContextSuggestion: fns.contextSuggest } : import('./context-suggest.js')); const c = await scheduleContextSuggestion(store, { now }); if (c) r.contextSuggested = c.length; } catch (e) { failed('context-suggest', e); }
    }
    const u = state.unreported || {};
    state.unreported = u; state.at = new Date().toISOString(); state.last = r;
    if (!dry) fs.writeFileSync(stateFile(store), JSON.stringify(state));
    store.log({ op: 'maintain', ...r, spentBefore: spent, cap, dry });
    return r;
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}

// One line for the user about what maintenance did since they last saw it; then cleared.
// The prompt hook took the entries of an older copy of thinker out of the checkout: tell the user at the end of the turn.
export function reportPruned(store, lines) {
  const state = readState(store);
  const u = state.unreported || {};
  u.pruned = [...new Set([...(u.pruned || []), ...lines])];
  state.unreported = u;
  try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
}

// A background learning job thinker has given up on (session-work.js): said once at the end of a turn.
// A job that retried for ever and told nobody is how one failing job on a user's machine reached ten
// attempts unseen; the person can run it themselves, or leave it.
export function reportGaveUp(store, lines) {
  const state = readState(store);
  const u = state.unreported || {};
  u.gaveUp = [...new Set([...(u.gaveUp || []), ...lines])];
  state.unreported = u;
  try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
}

export function maintenanceNotice(store, { now = new Date() } = {}) {
  const state = readState(store);
  const u = state.unreported;
  if (!u) return '';
  const parts = [];
  if (u.pruned?.length) parts.push('Thinker setup updated');
  if (u.capped) {
    const day = capDay(now);
    if ((!u.capped.day || u.capped.day === day) && !capWasReported(store, day)) {
      parts.push('learning paused at the daily token limit');
      try { fs.writeFileSync(capNoticeFile(store), JSON.stringify({ day })); } catch {}
    }
    delete u.capped;
    try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  }
  if (u.gaveUp?.length) parts.push(...u.gaveUp);
  if (!parts.length) return '';
  delete state.unreported;
  try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  return `🧠 thinker: ${parts.join('; ')}`;
}

// After a commit: one maintenance run in the background.
// Worktrees share the main repository's hooks, so the checkout is the one being committed
// in, not the one the hook was installed from.
export function postCommitHook(cli, repo, learn) {
  const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh\n# thinker: maintain the cache in the background\n` +
    `[ "$THINKER_TEST" = 1 ] && exit 0\n` +
    `case "$THINKER_NO_LEARN" in 1|true|yes) exit 0 ;; esac\n` +
    `repo="$(git rev-parse --show-toplevel 2>/dev/null)"\n` +
    `[ -n "$repo" ] || repo=${quote(repo)}\n` +
    `nohup node ${quote(cli)} maintain --quiet --repo "$repo" >/dev/null 2>&1 &\n`;
}

export function renderMaintain(r) {
  if (r.skipped) return `maintenance skipped (${r.skipped})`;
  const bits = [];
  if (r.pruned) bits.push(`${r.pruned} state ${r.pruned === 1 ? 'file' : 'files'} pruned`);
  if (r.prSynced) bits.push(`${r.prSynced} pull ${r.prSynced === 1 ? 'request' : 'requests'} read`);
  if (r.containerFound) bits.push(`a container found (${r.containerFound})`);
  if (r.contextSuggested) bits.push(`${r.contextSuggested} context ${r.contextSuggested === 1 ? 'change' : 'changes'} suggested`);
  return `maintained: ${bits.join(', ') || 'nothing to do'}${r.errors ? `; ${r.errors} failed${renderFailures(r.errorList)}` : ''}`;
}

// "(pr-sync: Reading pull requests needs a github.com origin)": the first three, on the one line
const RENDER_FAILURES = 3;
function renderFailures(list) {
  if (!list?.length) return '';
  const shown = list.slice(0, RENDER_FAILURES).map(e => `${e.step}: ${e.message}`);
  const more = list.length - shown.length;
  return ` (${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''})`;
}
