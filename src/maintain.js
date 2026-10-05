// Background maintenance of the cache: what a user would otherwise have to remember to
// run. It re-verifies stale notes, writes phrasings for notes that lack them, and distills
// pull requests merged since it first ran. It starts from the catch-up learning run (at most every ten minutes, from the
// prompt hooks) and from the git post-commit hook, and is bounded by a daily cap on the
// tokens learning and maintenance may use, so it can run unattended. The cap counts the
// tokens the model calls of learning and maintenance reported in the machine's log; a call
// that reported none counts as zero. Tokens, not dollars: the agents run on subscriptions as
// often as on metered keys, and a dollar figure from list prices misled more than it warned.
import fs from 'node:fs';
import path from 'node:path';
import { refresh, verifyNote, phraseNotes, phraseKey, archiveNotes } from './ops.js';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { reconcileLocal, readyToShareNotice } from './share.js';
import { writeSystemMarkdown } from './behavior.js';

export const DEFAULTS = {
  enabled: true,    // `maintain: { enabled: false }` in .thinker/config.json switches it off
  dailyTokens: 2_000_000, // tokens of reported model usage per day, learning and maintenance together (about 80 distillations); 0: no cap
  verifyPerRun: 10, // stale notes re-verified per run, most served first
  verifyServedDays: 14, // only notes served this recently are re-verified ahead of time (0: all); the rest wait to be served
  verifyChurn: 3,   // a note re-verified this many times in a week is left stale and reported (0: never)
  phrasePerRun: 8,  // notes given phrasings per run (one model call)
  prs: true,        // distill pull requests merged since maintenance first ran here
  prsPerRun: 3,
  archive: true,    // take notes the sessions showed are not worth serving out of serving and upkeep (ops.js:archiveNotes; `archive` in the config sets the rules)
};
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
  const legacyOff = 'dailyCap' in cfg && !cfg.dailyCap && cfg.dailyTokens === DEFAULTS.dailyTokens;
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

// Verify calls per note in the last seven days, from the machine's log.
export function verifyCounts(store, now = Date.now()) {
  const since = new Date(now - 7 * 86400_000).toISOString();
  const counts = new Map();
  for (const e of readLog(store)) if (e.op === 'verify' && e.t >= since && e.id) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  return counts;
}

// Which stale notes a run re-verifies. Serving verifies a stale note in the background anyway
// (ops.js:scheduleVerify), so maintenance only gets ahead of serving: notes served lately, in
// the order of how much they are served. A note that has had to be re-verified `verifyChurn`
// times this week rests on code under active change; rewriting it again each day costs a call
// per day and settles nothing, so it is left stale, with the ⚠ banner, and named once to the
// user, who can narrow its pointers or retire it.
export function pickStale(notes, cfg, { counts = new Map(), now = Date.now() } = {}) {
  const recent = cfg.verifyServedDays > 0 ? now - cfg.verifyServedDays * 86400_000 : -Infinity;
  const churning = [];
  const stale = notes
    .filter(n => n.status === 'stale' && !n.archived && !(n.verifying && now - Date.parse(n.verifying) < 10 * 60_000))
    .filter(n => recent === -Infinity || (n.lastUsed && Date.parse(n.lastUsed) >= recent))
    .filter(n => { if (cfg.verifyChurn > 0 && (counts.get(n.id) || 0) >= cfg.verifyChurn) { churning.push(n); return false; } return true; })
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, cfg.verifyPerRun);
  return { stale, churning };
}

function stateFile(store) { return path.join(store.dir, 'state', 'maintain.json'); }
function readState(store) { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return {}; } }

// One run. `fns` lets the CLI pass PR mining in and tests pass everything in.
export async function maintain(store, repo, { dry = false, fns = {} } = {}) {
  const cfg = maintainConfig(store);
  if (!cfg.enabled || /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '')) return { skipped: 'disabled' };
  const stateDir = path.join(store.init().dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'maintain.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' }; } catch {}
  if (!dry) fs.writeFileSync(lock, String(process.pid));
  const state = readState(store);
  const r = { verified: 0, updated: 0, retired: 0, churning: [], archived: 0, phrased: 0, prs: 0, sync: null, tokens: 0, capped: false, errors: 0 };
  const spent = (fns.spentToday || spentToday)(store);
  const cap = withinDailyCap(store, { spentFn: () => spent }).cap;
  const afford = () => !cap || cap - spent - r.tokens > 0;
  try {
    if (!dry) reconcileLocal(store);
    // 0. the team's central cache, when this checkout syncs with one (sync.js): free, network only
    if (fns.sync) { try { r.sync = await fns.sync(); } catch { r.errors++; } }
    // 1c. archiving is free too: notes of a kind the sessions never acted on, and notes nobody was
    // served in a month, leave serving and upkeep and stay for review (ops.js:archiveNotes)
    if (cfg.archive !== false) { try { r.archived = (fns.archive || archiveNotes)(store, { dry }).length; } catch { r.errors++; } }
    // 2. Re-hashing is free, even when the model budget is exhausted.
    const notes = (fns.refresh || refresh)(store, store.list(), { narrow: true, persist: !dry }); // --dry writes nothing, statuses included
    if (afford()) {
      const { stale, churning } = pickStale(notes, cfg, { counts: cfg.verifyChurn > 0 ? (fns.verifyCounts || verifyCounts)(store) : new Map() });
      r.churning = churning.map(n => n.id);
      for (const n of stale) {
        if (!afford()) { r.capped = true; break; }
        if (dry) { r.verified++; continue; }
        try {
          const v = await (fns.verify || verifyNote)(store, n, {});
          r.tokens += v.tokens || 0; r.verified++;
          if (v.verdict === 'update') r.updated++;
          if (v.verdict === 'invalid') r.retired++;
          if (v.verdict === 'broken') r.violated = (r.violated || 0) + 1; // the notice names it (ops.js:noteUnreported)
          if (v.verdict === 'revised') r.revised = (r.revised || 0) + 1; // a behavior followed the merged code
        } catch { r.errors++; }
      }
    } else r.capped = true;
    // 3. phrasings for notes that have none for their present text
    if (afford()) {
      const need = store.list().filter(n => n.status !== 'invalid' && !n.archived && (!n.says?.length || n.saysFor !== phraseKey(n))).slice(0, cfg.phrasePerRun);
      if (need.length) {
        if (dry) r.phrased = need.length;
        else { try { const p = await (fns.phrase || phraseNotes)(store, need, { phase: 'maintenance' }); r.phrased = p.done.length; r.tokens += p.tokens || 0; } catch { r.errors++; } }
      }
    } else r.capped = true;
    // 4. pull requests merged since maintenance first ran here; further back is `thinker mine-prs`
    if (cfg.prs && fns.minePrs) {
      if (!state.prsAfter) state.prsAfter = new Date().toISOString();
      else if (afford()) {
        if (!dry) { try { const m = await fns.minePrs({ after: state.prsAfter, limit: cfg.prsPerRun }); r.prs = m?.saved || 0; r.tokens += m?.tokens || 0; } catch { r.errors++; } }
      } else r.capped = true;
    }
    const u = state.unreported || {};
    // a behavior found broken during this run was written to the state file by the verification itself
    // (ops.js:noteUnreported), after the state was read: keep it
    const liveState = readState(store).unreported || {};
    if (liveState.violated?.length) u.violated = liveState.violated;
    if (liveState.revised?.length) u.revised = liveState.revised;
    if (r.revised && !dry) { try { writeSystemMarkdown(store); } catch {} }
    if (!dry) { const notice = readyToShareNotice(store); if (notice) u.share = notice; }
    for (const k of ['verified', 'updated', 'retired', 'archived', 'phrased', 'prs']) u[k] = (u[k] || 0) + r[k];
    if (r.sync && !r.sync.skipped) { u.pulled = (u.pulled || 0) + (r.sync.pulled || 0) + (r.sync.deleted || 0); u.pushed = (u.pushed || 0) + (r.sync.pushed || 0) + (r.sync.retired || 0); }
    // churning notes are named once; a note named before is not named again until it settles
    const named = new Set(state.churnNamed || []);
    const fresh = r.churning.filter(id => !named.has(id));
    if (fresh.length) u.churning = [...new Set([...(u.churning || []), ...fresh])];
    state.churnNamed = r.churning;
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

export function maintenanceNotice(store, { now = new Date() } = {}) {
  const state = readState(store);
  const u = state.unreported;
  if (!u) return '';
  const parts = [];
  if (u.verified) {
    const detail = [u.updated ? `${u.updated} updated` : '', u.retired ? `${u.retired} retired` : ''].filter(Boolean).join(', ');
    parts.push(`${u.verified} stale ${u.verified === 1 ? 'note' : 'notes'} re-verified${detail ? ` (${detail})` : ''}`);
  }
  if (u.phrased) parts.push(`${u.phrased} ${u.phrased === 1 ? 'note' : 'notes'} phrased`);
  if (u.archived) parts.push(`${u.archived} ${u.archived === 1 ? 'note' : 'notes'} archived: kept for review, no longer served or re-verified (thinker archive --list)`);
  if (u.prs) parts.push(`${u.prs} ${u.prs === 1 ? 'note' : 'notes'} from merged pull requests`);
  if (u.pulled || u.pushed) parts.push(`team cache: ${[u.pulled ? `${u.pulled} ${u.pulled === 1 ? 'note' : 'notes'} pulled` : '', u.pushed ? `${u.pushed} pushed` : ''].filter(Boolean).join(', ')}`);
  if (u.share) parts.push(u.share);
  if (u.pruned?.length) parts.push(...u.pruned);
  if (u.capped) {
    const day = capDay(now);
    if ((!u.capped.day || u.capped.day === day) && !capWasReported(store, day)) {
      parts.push(`learning paused for today: ${formatTokens(u.capped.spent)} of the ${formatTokens(u.capped.cap)} tokens it may use a day are used (maintain.dailyTokens in .thinker/config.json raises it)`);
      // Separate from maintain.json: a background run can rewrite that state after this notice.
      try { fs.writeFileSync(capNoticeFile(store), JSON.stringify({ day })); } catch {}
    }
    delete u.capped;
    try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  }
  if (u.revised?.length) parts.push(`✎ ${u.revised.length === 1 ? 'a desired behavior was' : `${u.revised.length} desired behaviors were`} revised to match the merged code: ${u.revised.slice(0, 3).map(v => `"${v.title}" (${v.id}${v.commit ? ` at ${String(v.commit).slice(0, 10)}` : ''}${v.reason ? `: ${v.reason.slice(0, 120)}` : ''})`).join('; ')}${u.revised.length > 3 ? ', …' : ''}; thinker system shows the new text`);
  if (u.violated?.length) parts.push(`⚠ ${u.violated.length === 1 ? 'a desired behavior is' : `${u.violated.length} desired behaviors are`} no longer upheld by the code: ${u.violated.slice(0, 3).map(v => `"${v.title}" (${v.id}${v.reason ? `: ${v.reason.slice(0, 120)}` : ''})`).join('; ')}${u.violated.length > 3 ? '; …' : ''}; restore the code or revise the behavior (thinker system)`);
  if (u.churning?.length) parts.push(`${u.churning.length} ${u.churning.length === 1 ? 'note' : 'notes'} left stale after being re-verified ${maintainConfig(store).verifyChurn}+ times this week (${u.churning.slice(0, 3).join(', ')}${u.churning.length > 3 ? ', …' : ''}): their code is changing; narrow their pointers or retire them`);
  if (!parts.length) return '';
  delete state.unreported;
  try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  return `🧠 thinker: in the background, ${parts.join('; ')}`;
}

// After a commit: re-hash in the background; with learning on, one maintenance run instead.
// Worktrees share the main repository's hooks, so the checkout is the one being committed
// in, not the one the hook was installed from.
export function postCommitHook(cli, repo, learn) {
  const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh\n# thinker: re-hash note dependencies${learn ? ' and maintain the cache' : ''} in the background\n` +
    `[ "$THINKER_TEST" = 1 ] && exit 0\n` +
    `case "$THINKER_NO_LEARN" in 1|true|yes) exit 0 ;; esac\n` +
    `repo="$(git rev-parse --show-toplevel 2>/dev/null)"\n` +
    `[ -n "$repo" ] || repo=${quote(repo)}\n` +
    `nohup node ${quote(cli)} ${learn ? 'maintain' : 'check'} --quiet --repo "$repo" >/dev/null 2>&1 &\n`;
}

export function renderMaintain(r) {
  if (r.skipped) return `maintenance skipped (${r.skipped})`;
  const bits = [`${r.verified} re-verified`];
  if (r.updated) bits.push(`${r.updated} updated`);
  if (r.retired) bits.push(`${r.retired} retired`);
  if (r.violated) bits.push(`${r.violated} desired ${r.violated === 1 ? 'behavior' : 'behaviors'} found broken`);
  if (r.revised) bits.push(`${r.revised} desired ${r.revised === 1 ? 'behavior' : 'behaviors'} revised to match the merged code`);
  if (r.churning?.length) bits.push(`${r.churning.length} churning left stale`);
  if (r.archived) bits.push(`${r.archived} archived`);
  bits.push(`${r.phrased} phrased`, `${r.prs} from pull requests`);
  if (r.sync && !r.sync.skipped) bits.push(`team cache ${r.sync.pulled + (r.sync.deleted || 0)}↓ ${r.sync.pushed + (r.sync.retired || 0)}↑`);
  return `maintained: ${bits.join(', ')}${r.tokens ? ` (~${formatTokens(r.tokens)} tokens)` : ''}${r.capped ? '; daily token cap reached' : ''}${r.errors ? `; ${r.errors} failed` : ''}`;
}
