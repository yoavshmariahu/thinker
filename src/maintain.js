// Background maintenance of the cache: what a user would otherwise have to remember to
// run. It re-verifies a few stale notes and writes phrasings for notes that lack them.
// Since 2026-10-21 that is all it does by default (the owner's decision: the cache was not
// paying for its background spend, and few people were running it): the notes come from the
// sessions alone (mining merged pull requests and commits was removed the same day), and the
// steps that read documents (design documents, skill files, the duplicate pass) are off until a
// repository's config turns them on. It starts from the catch-up learning run (at most every ten minutes, from the
// prompt hooks) and from the git post-commit hook. Batches run at most once every four hours,
// on the next activity after they are due, and are bounded by daily caps on the
// tokens learning and maintenance may use, so it can run unattended. A cap counts the
// tokens the model calls of learning and maintenance reported in the machine's log; a call
// that reported none counts as zero. Tokens, not dollars: the agents run on subscriptions as
// often as on metered keys, and a dollar figure from list prices misled more than it warned.
import fs from 'node:fs';
import path from 'node:path';
import { refresh, verifyNote, phraseNotes, phraseKey, archiveNotes } from './ops.js';
import { dedupeOn, dedupeNotes, DEDUPE_DEFAULTS } from './dedupe.js';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { writeSystemMarkdown } from './behavior.js';
import { isTestMode } from './test-mode.js';
import { takeContradictions } from './learning-pending.js';
import { pruneState } from './state-prune.js';

export const DEFAULTS = {
  enabled: true,    // `maintain: { enabled: false }` in .thinker/config.json switches it off
  // tokens of reported generative model usage per day, learning and maintenance together; 0: no cap.
  // 10M is about $1 a day at Haiku 5.5 or GPT-6 Luna list prices (50M until 2026-10-21); a costlier
  // distillModel, Sonnet (the default since 2026-10-15) among them, gets DAILY_TOKENS_COSTLY unless the
  // config says otherwise
  dailyTokens: 10_000_000,
  // Verification is one batch every `verifyEveryDays` (2026-10-21; a few notes every four hours until then), of the
  // stale notes served in the last `verifyServedDays` (0: all), most served first, at most `verifyPerRun`. A stale note
  // waits for the batch: the prompt hooks hold it back meanwhile (ops.js:orient freshOnly).
  verifyEveryDays: 3,
  verifyPerRun: 50,
  verifyServedDays: 3,
  // a note nobody has been served in this many days (and older than that) is deleted, archived ones too; a desired
  // behavior, a skill card and a note a person wrote are kept (0: never delete)
  deleteUnusedDays: 30,
  verifyChurn: 3,   // a note re-verified this many times in a week is left stale and reported (0: never)
  phrasePerRun: 8,  // notes given phrasings per run (one model call)
  docs: false,      // read design documents that are new or changed into behaviors (behavior-docs.js); off since 2026-10-21
  docsPerRun: 3,
  skills: false,    // card the skill files (SKILL.md) that are new or changed, and settle duplicates (skills.js); off since 2026-10-21
  skillsPerRun: 3,
  // the weekly suggestion of directories to cover (coverage.js): a new cache-building strategy, off until an experiment
  // shows it helps (AGENTS.md), and held there on 2026-10-25 (the owner's call: it was not effective enough to put to
  // people); `maintain: { coverage: true }` in .thinker/config.json turns it on for a repository
  coverage: false,
  // the week's five highest-leverage context changes (context-suggest.js), passed on at the next prompt with a link to
  // the local page; no model call, nothing changed but by the person on the page. `maintain: { contextSuggest: false }`
  contextSuggest: true,
  // merge notes that say the same thing in different words (dedupe.js): one model call a pair. On by default
  // from 2026-10-19 to 2026-10-21, off since with the other background spend; `maintain: { dedupe: true }` or
  // THINKER_DEDUPE=on turns it on
  dedupe: false,
  dedupePerRun: DEDUPE_DEFAULTS.perRun,       // candidate pairs judged per run (one model call each)
  dedupeThreshold: DEDUPE_DEFAULTS.threshold, // cosine of the local embeddings, for notes resting on a file in common
  archive: true,    // take notes the sessions showed are not worth serving out of serving and upkeep (ops.js:archiveNotes; `archive` in the config sets the rules)
};
export const MAINTENANCE_INTERVAL_MS = 4 * 60 * 60_000;
const LOCK_MS = 15 * 60_000;

// The daily default for a distillation model that is not in the cheap class (Haiku, Luna, Flash):
// about forty session distillations (2M until 2026-10-21).
export const DAILY_TOKENS_COSTLY = 1_000_000;
const CHEAP_MODEL = /haiku|luna|flash/i;
export function maintainConfig(store) {
  const cfg = store.config();
  const c = cfg.maintain;
  const dailyTokens = CHEAP_MODEL.test(cfg.distillModel || 'sonnet') ? DEFAULTS.dailyTokens : DAILY_TOKENS_COSTLY;
  return { ...DEFAULTS, dailyTokens, ...(c && typeof c === 'object' ? c : {}) };
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

// Verify calls per note in the last seven days, from the machine's log.
export function verifyCounts(store, now = Date.now()) {
  const since = new Date(now - 7 * 86400_000).toISOString();
  const counts = new Map();
  for (const e of readLog(store)) if (e.op === 'verify' && e.t >= since && e.id) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  return counts;
}

// Which changed notes the four-hour batch re-verifies: notes served lately, in
// the order of how much they are served. Retrieval never starts verification.
// A note that has had to be re-verified `verifyChurn`
// times this week rests on code under active change; rewriting it again each day costs a call
// per day and settles nothing, so it is left stale, with the ⚠ banner, and named once to the
// user, who can narrow its pointers or retire it.
export function pickStale(notes, cfg, { counts = new Map(), now = Date.now() } = {}) {
  const recent = cfg.verifyServedDays > 0 ? now - cfg.verifyServedDays * 86400_000 : -Infinity;
  const churning = [];
  const stale = notes
    .filter(n => n.status === 'stale' && !n.archived && !(n.verifying && now - Date.parse(n.verifying) < 10 * 60_000))
    // served recently, or held back from a request recently (ops.js:orient `heldAt`): a stale note the
    // freshness rule withholds can never be served, so `lastUsed` alone deadlocked it out of ever
    // being verified and it stayed stale for good
    .filter(n => n.contradicted || recent === -Infinity || (n.lastUsed && Date.parse(n.lastUsed) >= recent) || (n.heldAt && Date.parse(n.heldAt) >= recent))
    // a skill card whose own file changed is rewritten by the skills step of this run (skills.js:scanSkills), not audited
    .filter(n => !(n.kind === 'skill' && n.skill?.file && (n.stale?.changed || []).some(c => c.path === n.skill.file)))
    .filter(n => { if (cfg.verifyChurn > 0 && (counts.get(n.id) || 0) >= cfg.verifyChurn) { churning.push(n); return false; } return true; })
    // a note a session contradicted first: it is held back from serving until verified
    .sort((a, b) => (b.contradicted ? 1 : 0) - (a.contradicted ? 1 : 0) || (b.uses || 0) - (a.uses || 0))
    .slice(0, cfg.verifyPerRun);
  return { stale, churning };
}

// Notes nobody has been served in `days`, made longer ago than that, deleted. A desired behavior (a person's), a skill
// card (rewritten from its file) and a note a person added are kept; a note committed to the repository is archived
// instead (its file is the team's). Logged as op "delete-unused" with the ids.
export function deleteUnused(store, { days = DEFAULTS.deleteUnusedDays, dry = false, now = Date.now() } = {}) {
  const cutoff = now - days * 86400_000;
  const out = [];
  for (const n of store.list()) {
    if (['behavior', 'skill'].includes(n.kind) || n.source?.type === 'human') continue;
    const made = Date.parse(n.created || ''), used = Date.parse(n.lastUsed || '');
    if (!Number.isFinite(made) || made > cutoff) continue;
    if (Number.isFinite(used) && used > cutoff) continue;
    // a note a request wanted, which the freshness rule held back (ops.js:orient `heldAt`), is not a
    // note nobody reads: deleting it would be deleting it for not being served when thinker itself is
    // what refused to serve it
    const held = Date.parse(n.heldAt || '');
    if (Number.isFinite(held) && held > cutoff) continue;
    out.push(n.id);
    if (dry) continue;
    // a note committed to the repository is the team's file: archived here (this checkout's state), never deleted
    if (store.isShared(n.id)) { if (!n.archived) archiveNotes(store, { ids: [n.id] }); }
    else store.remove(n.id);
  }
  if (out.length && !dry) store.log({ op: 'delete-unused', days, ids: out });
  return out;
}

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
    return { skipped: 'not-due', ...(state.last?.errors ? { errors: state.last.errors } : {}) };
  }
  // Persist before any model calls: failed/interrupted batches must not retry every prompt.
  if (!dry) {
    state.startedAt = new Date(now).toISOString();
    fs.writeFileSync(stateFile(store), JSON.stringify(state));
  }
  const r = { verified: 0, updated: 0, retired: 0, churning: [], archived: 0, merged: 0, phrased: 0, docs: 0, unstated: 0, skills: 0, skillsBroken: 0, tokens: 0, capped: false, errors: 0 };
  const spent = (fns.spentToday || spentToday)(store);
  const cap = withinDailyCap(store, { spentFn: () => spent }).cap;
  const afford = () => !cap || cap - spent - r.tokens > 0;
  try {
    // 1b. state files no session will read again (state-prune.js)
    if (!dry) { try { r.pruned = pruneState(store.dir, { now }).length; } catch { r.errors++; } }
    // 1c. archiving is free too: notes of a kind the sessions never acted on, and notes nobody was
    // served in a month, leave serving and upkeep and stay for lookup by id (ops.js:archiveNotes)
    if (cfg.archive !== false) { try { r.archived = (fns.archive || archiveNotes)(store, { dry }).length; } catch { r.errors++; } }
    // 1d. contradictions sessions reported (learning-pending.js): the notes are marked for verification
    if (!dry) { try { takeContradictions(store); } catch { r.errors++; } }
    // 2. Re-hashing is free, even when the model budget is exhausted.
    const notes = (fns.refresh || refresh)(store, store.list(), { narrow: true, persist: !dry }); // --dry writes nothing, statuses included
    // 1e. notes nobody was served in two weeks are deleted (deleteUnused): free, and they cost upkeep for nothing
    if (cfg.deleteUnusedDays > 0) { try { r.deleted = deleteUnused(store, { days: cfg.deleteUnusedDays, dry, now }).length; } catch { r.errors++; } }
    // the verification batch is due every `verifyEveryDays`, or at once for a note a session contradicted
    const lastBatch = Date.parse(state.verifiedAt || '');
    // (a dry run previews the next batch, due or not)
    const batchDue = dry || !(cfg.verifyEveryDays > 0) || !Number.isFinite(lastBatch) || now - lastBatch >= cfg.verifyEveryDays * 86400_000;
    if (!batchDue) r.verifyNext = new Date(lastBatch + cfg.verifyEveryDays * 86400_000).toISOString();
    if (afford() && (batchDue || notes.some(n => n.contradicted && n.status === 'stale'))) {
      const picked = pickStale(notes, cfg, { counts: cfg.verifyChurn > 0 ? (fns.verifyCounts || verifyCounts)(store, now) : new Map(), now });
      const stale = batchDue ? picked.stale : picked.stale.filter(n => n.contradicted), churning = picked.churning;
      if (batchDue && !dry) state.verifiedAt = new Date(now).toISOString();
      r.churning = churning.map(n => n.id);
      for (const n of stale) {
        if (!afford()) { r.capped = true; break; }
        if (dry) { r.verified++; continue; }
        try {
          const v = await (fns.verify || verifyNote)(store, n, {});
          r.tokens += v.tokens || 0; r.verified++;
          if (v.verdict === 'update') r.updated++;
          if (v.verdict === 'invalid') r.retired++;
          if (v.verdict === 'broken' && n.kind === 'skill') r.skillsBroken++; // a skill out of date (skills.js:auditSkill); the notice names it
          else if (v.verdict === 'broken') r.violated = (r.violated || 0) + 1; // the notice names it (ops.js:noteUnreported)
          if (v.verdict === 'revised') r.revised = (r.revised || 0) + 1; // a behavior followed the merged code
        } catch { r.errors++; }
      }
    } else r.capped = true;
    // 2b. notes that say the same thing in different words, merged (dedupe.js; off unless maintain.dedupe); before the
    // phrasings, so a merged note is phrased for its new text in this run
    if (dedupeOn(cfg) && afford()) {
      try {
        const d = await (fns.dedupe || dedupeNotes)(store, { perRun: cfg.dedupePerRun, threshold: cfg.dedupeThreshold, dry, afford });
        r.merged = d.merged.length; r.tokens += d.tokens || 0; r.errors += d.errors || 0;
        if (d.capped) r.capped = true;
      } catch { r.errors++; }
    }
    // 3. phrasings for notes that have none for their present text
    if (afford()) {
      const need = store.list().filter(n => n.status !== 'invalid' && !n.archived
        && (!n.says?.length || !n.search || n.saysFor !== phraseKey(n))).slice(0, cfg.phrasePerRun);
      if (need.length) {
        if (dry) r.phrased = need.length;
        else { try { const p = await (fns.phrase || phraseNotes)(store, need, { phase: 'maintenance' }); r.phrased = p.done.length; r.tokens += p.tokens || 0; } catch { r.errors++; } }
      }
    } else r.capped = true;
    // 5. design documents that are new or changed since they were read: their behaviors follow them
    if (cfg.docs !== false && fns.docs) {
      if (afford()) {
        if (!dry) { try { const d = await fns.docs({ limit: cfg.docsPerRun }); r.docs = d?.saved?.length || 0; r.unstated = d?.unstated?.length || 0; r.tokens += d?.tokens || 0; if (r.docs || r.unstated || d?.reworded?.length) { try { writeSystemMarkdown(store); } catch {} } } catch { r.errors++; } }
      } else r.capped = true;
    }
    // 6. skill files that are new or changed since they were carded; their duplicates settled (skills.js)
    if (cfg.skills !== false && fns.skills) {
      if (afford()) {
        if (!dry) { try { const k = await fns.skills({ limit: cfg.skillsPerRun }); r.skills = (k?.saved?.length || 0) + (k?.updated?.length || 0); r.tokens += k?.tokens || 0; } catch { r.errors++; } }
      } else r.capped = true;
    }
    // 7. at most weekly, a question for the person: the directories their sessions work in that the cache covers
    // little (coverage.js). No model call; the prompt hook asks it, and a build starts only on their answer.
    if (cfg.coverage === true && !dry) {
      try { const { scheduleSuggestion } = await (fns.coverage ? { scheduleSuggestion: fns.coverage } : import('./coverage.js')); const picks = scheduleSuggestion(store, { now }); if (picks) r.coverageSuggested = picks.length; } catch { r.errors++; }
    }
    // 8. at most weekly, the five highest-leverage changes the Context view finds (context-suggest.js), for the next prompt
    if (cfg.contextSuggest !== false && !dry) {
      try { const { scheduleContextSuggestion } = await (fns.contextSuggest ? { scheduleContextSuggestion: fns.contextSuggest } : import('./context-suggest.js')); const c = await scheduleContextSuggestion(store, { now }); if (c) r.contextSuggested = c.length; } catch { r.errors++; }
    }
    const u = state.unreported || {};
    // a behavior found broken during this run was written to the state file by the verification itself
    // (ops.js:noteUnreported), after the state was read: keep it
    const liveState = readState(store).unreported || {};
    if (liveState.violated?.length) u.violated = liveState.violated;
    if (liveState.revised?.length) u.revised = liveState.revised;
    if (liveState.brokenSkills?.length) u.brokenSkills = liveState.brokenSkills;
    if (r.revised && !dry) { try { writeSystemMarkdown(store); } catch {} }
    for (const k of ['verified', 'updated', 'retired', 'archived', 'merged', 'phrased', 'docs', 'unstated', 'skills']) u[k] = (u[k] || 0) + r[k];
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
  const updated = u.updated || 0;
  const retired = u.retired || 0;
  if (u.verified) parts.push(`${u.verified} checked${updated ? `, ${updated} updated` : ''}${retired ? `, ${retired} retired` : ''}`);
  if (u.phrased) parts.push(`${u.phrased} phrased`);
  if (u.archived) parts.push(`${u.archived} archived`);
  if (u.merged) parts.push(`${u.merged} duplicate ${u.merged === 1 ? 'note' : 'notes'} merged`);
  if (u.docs) parts.push(`${u.docs} ${u.docs === 1 ? 'behavior' : 'behaviors'} from design documents; see thinker system`);
  if (u.unstated) parts.push(`${u.unstated} ${u.unstated === 1 ? 'behavior' : 'behaviors'} no longer stated by a design document; keep or discard in thinker ui`);
  if (u.skills) parts.push(`${u.skills} skill ${u.skills === 1 ? 'card' : 'cards'}`);
  if (u.brokenSkills?.length) parts.push(`${u.brokenSkills.length} ${u.brokenSkills.length === 1 ? 'skill is' : 'skills are'} out of date (${u.brokenSkills.map(b => b.name || b.id).join(', ')}); not served until fixed or reviewed; see thinker skills`);
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
  if (u.revised?.length) parts.push(`${u.revised.length} desired ${u.revised.length === 1 ? 'behavior revised' : 'behaviors revised'}; see thinker system`);
  if (u.violated?.length) parts.push(`${u.violated.length} desired ${u.violated.length === 1 ? 'behavior is violated' : 'behaviors are violated'}; see thinker system`);
  if (u.churning?.length) parts.push(`${u.churning.length} ${u.churning.length === 1 ? 'note' : 'notes'} repeatedly stale; narrow pointers or retire them`);
  if (!parts.length) return '';
  delete state.unreported;
  try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  return `🧠 thinker: ${parts.join('; ')}`;
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
  if (r.merged) bits.push(`${r.merged} duplicates merged`);
  bits.push(`${r.phrased} phrased`);
  if (r.docs) bits.push(`${r.docs} from design documents`);
  if (r.unstated) bits.push(`${r.unstated} no longer stated by a design document`);
  if (r.skills) bits.push(`${r.skills} skill ${r.skills === 1 ? 'card' : 'cards'}`);
  if (r.skillsBroken) bits.push(`${r.skillsBroken} ${r.skillsBroken === 1 ? 'skill' : 'skills'} found out of date`);
  return `maintained: ${bits.join(', ')}${r.tokens ? ` (~${formatTokens(r.tokens)} tokens)` : ''}${r.capped ? '; daily token cap reached' : ''}${r.errors ? `; ${r.errors} failed` : ''}`;
}
