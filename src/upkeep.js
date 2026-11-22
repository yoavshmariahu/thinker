// Upkeep: what thinker does by itself between sessions, beside learning. It looks at what the coding agents left
// behind in a repository and does what is important, without asking and without anybody pressing anything. Recent
// activity says what it did, a line an action with what it came to, beside the chat on the page and as `thinker
// activity` (one view: upkeepView). The person changes how it behaves, and takes a thing back, by talking to it
// (chat.js). There is no list of things for the person to do and no button to do them with (the owner, 2026-11-21:
// "no more manual action please. thinker does its work for you. its opinionated").
//
// A check runs on maintenance's clock (maintain.js, every four hours on the next activity). It spends no model
// tokens: everything it reads was measured already, by code or by the one pass each session gets when it ends
// (profile.js). Nothing is replayed and nothing is judged twice.
//
// What a check looks for (CHORES):
//   sweep     worktrees and branches whose work is merged (upkeep-sweep.js)
//   context   the context changes `thinker context` lists (context-suggest.js:currentChanges): a section of an
//             instruction file nobody needs is shortened or removed in a pull request, a tool or an MCP server nobody
//             calls is switched off or made a reference. One computation with the command: every decision is kept in
//             the same history, by the door `thinker`. These go in batches (below), never one at a time.
//   rules     a section of the instruction file that sessions keep breaking, from the verdicts on real sessions
//             (instruction-value.js). Something worth knowing, which thinker says when it is asked: what to do about a
//             rule nobody follows is the person's.
//   waiting   a change of its own that failed, tried again
//
// How it behaves (BEHAVIOR). The owner's rule, 2026-11-21: thinker is "responsible to finding and making those
// decisions... This should happen in batches and only on actions that have clear value", and then their answers, one
// by one, to how that should work:
//   - It acts by itself (`level: 'auto'`). `ask` has it wait for the person's word in the chat; `off` stops the checks.
//   - Clear value is dollars: a change is worth making when what it wastes comes to `minPerDay` ($1) a day or more
//     here -- the tokens that went on it unused over the report's window, at what an input token costs here, a day.
//     A change nothing can price is not made. What is under the bar stays in `thinker context`.
//   - Batches: the changes worth making go together, once they come to `batchPerDay` ($5) a day between them and
//     `batchEveryDays` (7) have passed since the last batch here. A batch is one line of the activity.
//   - What it may do: shorten a section (`prs`), remove one (`remove`), switch off or reference a tool or an MCP
//     server (`tools`). Not a skill (`skills`, off) unless the person says so.
//   - A pull request is the only way it changes a repository's files: one for a batch, whatever it shortens and
//     removes, left for a person to merge (thinker never merges its own), and opened even while an earlier one is
//     still in review. The line about it carries its link. A section is never rewritten in the working tree.
//   - A week into its effect (`followUpDays`) each change of a batch is checked, and what backfired is taken back
//     and not tried again (`followUp`): a tool switched back on, a section put back by a pull request of its own.
//   - A sweep of three things or 500 MB, at most one a repository a day, as before.
// The settings are `upkeep: { … }` in <THINKER_HOME>/config.json for the machine and in .thinker/config.json for
// one repository (which wins); `upkeep: false` is `level: off`. The chat writes them (setBehavior).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findMess, sweep, unsweep, SWEEP } from './upkeep-sweep.js';
import { currentChanges, decidedKeys, allChanges, pickChanges, approveChanges, dismissChanges, changeHistory, retryJob, revertDecision, restoreSection, VIA, SUGGEST } from './context-suggest.js';
import { lastSnapshot } from './context-snapshot.js';
import { rateOf } from './context-view.js';
import { prAvailable } from './instruction-pr.js';
import { instructionFiles, sections, sectionId, readValueState } from './instruction-value.js';
import { readMachineConfig, updateMachineConfig } from './repo-switch.js';
import { keptRows, inputRateHere } from './report-snapshot.js';
import { withEffects } from './report.js';
import { delegationBySession, delegationDetail } from './report-savings.js';
import { readProfile, answerStyle, ANSWER_WORDS } from './profile.js';
import { clearingRows, compressionDir } from './compression.js';
import { proxyLogFile } from './proxy-service.js';
import { sessionKey } from './usage.js';
import { delegateConfig } from './delegate.js';
import { thinkerHome } from './update.js';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { formatDollars } from './prices.js';

export const UPKEEP = {
  dismissDays: 90,  // a thing the person told it to leave alone stays left this long
  retries: 3,       // times a change of its own that failed is tried before it is given up on
  keepDone: 200,    // actions remembered, newest kept
  feedDays: 14,     // how far back the activity reads
  feedMax: 60,
  sessionsMax: 30,  // sessions with delegated work the view carries, newest first
  ruleDays: 30,     // the window a broken rule is counted over
  ruleBroken: 3,    // sessions that broke a rule before it is worth knowing
  staleMs: 24 * 3600_000, // the page asks for a look when the last check is older than this
  batchMax: 20,     // changes one batch may hold (what the report lists)
  removeSessions: 10, // sessions a section must have gone unneeded through before thinker removes it, not shortens it
  needShare: 0.1,   // a tool made a reference and still called in this share of prompts was needed after all
  followGiveUpDays: 28, // a change nothing could measure in this long is left as it is
  followedDays: 180, // how long a change's check is remembered
};
const DAY = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = kb => !kb ? '' : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// --- how it behaves ------------------------------------------------------------------------------------------
// Each setting with what it may be, and the words the chat and the command say it in.
export const BEHAVIOR = {
  level: 'auto', sweep: true, prs: true, remove: true, tools: true, skills: false,
  minPerDay: 1, batchPerDay: 5, batchEveryDays: 7, followUp: true, followUpDays: 7, sweepEveryDays: 1, sweepMin: 3, sweepMinMb: 500,
  // the two that are read from where their own part of thinker keeps them (`SETTINGS` below, `get`), never from the
  // upkeep block: on until that part says otherwise, and `null` for one the person has not set at all
  delegation: true, answerWords: null,
};
const num = (min, max) => v => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined; };
// dollars, to the cent ("$2", "0.50")
const money = (min, max) => v => { const n = Number(String(v).trim().replace(/^\$/, '')); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : undefined; };
const bool = v => v === true || /^(true|on|yes)$/i.test(String(v)) ? true : v === false || /^(false|off|no)$/i.test(String(v)) ? false : undefined;
const oneOf = (...xs) => v => xs.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : undefined;
export const SETTINGS = {
  level: { read: oneOf('auto', 'ask', 'off'), about: 'auto: make the changes worth making by itself; ask: do nothing until told to in the chat; off: stop looking' },
  sweep: { read: bool, about: 'whether it may remove merged worktrees and branches by itself' },
  prs: { read: bool, about: 'whether it may put up a pull request that shortens or removes a section of an instruction file' },
  remove: { read: bool, about: 'whether such a pull request may remove a section outright; off, it only shortens' },
  tools: { read: bool, about: 'whether it may switch off, or make a reference of, a tool or an MCP server nobody calls' },
  skills: { read: bool, about: 'whether it may switch off a skill nobody calls (off unless they say so)' },
  minPerDay: { read: money(0.05, 1000), about: 'dollars a day a change must save here to be worth making' },
  batchPerDay: { read: money(0.05, 10_000), about: 'dollars a day the changes worth making must come to together before a batch of them goes' },
  batchEveryDays: { read: num(1, 90), about: 'least days between batches in one repository' },
  followUp: { read: bool, about: 'whether it checks each change once it has been in effect a while, and takes back by itself what did not pay' },
  followUpDays: { read: num(1, 90), about: 'days a change is in effect before that check' },
  sweepEveryDays: { read: num(1, 90), about: 'days between sweeps in one repository' },
  sweepMin: { read: num(1, 100), about: 'how many merged worktrees and branches make a sweep worth doing by itself' },
  sweepMinMb: { read: num(1, 100_000), about: 'or how many megabytes they hold' },
  // Two switches on the other work thinker does for them, which do not live under `upkeep` and are the machine's
  // alone: each says where it is read and written (`get`, `write`), so the chat is one place for everything a person
  // tells thinker to stop or change ("read the files yourself", "keep answers under 60 words") and nobody has to find
  // a config key. The upkeep block never holds them, whatever a config file says (`settingsOf` skips them).
  delegation: {
    read: bool, about: 'whether a big read or a whole-suite test run may be handed to a cheaper agent (the machine\'s; how big is steered, not set)',
    get: ({ home }) => delegateConfig({ home }).enabled,
    write: (v, { home }) => updateMachineConfig(home, cfg => ({ ...cfg, delegate: { ...(cfg.delegate && typeof cfg.delegate === 'object' ? cfg.delegate : {}), enabled: v } })),
  },
  answerWords: {
    read: num(ANSWER_WORDS.min, ANSWER_WORDS.max), about: `how long an answer their coding agents should give, in words (${ANSWER_WORDS.min}-${ANSWER_WORDS.max}); the rule is served to every session and expect about a tenth more than the number`,
    get: ({ store, home }) => answerStyle(store, { home }).words,
    write: (v, { home }) => updateMachineConfig(home, cfg => ({ ...cfg, style: { ...(cfg.style && typeof cfg.style === 'object' ? cfg.style : {}), answerWords: v } })),
  },
};
const settingsOf = c => {
  if (c === false) return { level: 'off' };
  const out = {};
  if (c && typeof c === 'object') for (const [k, s] of Object.entries(SETTINGS)) { if (s.get || !(k in c)) continue; else { const v = s.read(c[k]); if (v !== undefined) out[k] = v; } }
  return out;
};
// The behaviour in force in a repository: the defaults, the machine's settings over them, the repository's over those,
// and the two settings read from where their own part of thinker keeps them (null when that part has none set).
export function behaviorOf(store, { home = thinkerHome() } = {}) {
  const machine = settingsOf(readMachineConfig(home).upkeep), repo = settingsOf(store?.config().upkeep);
  const b = { ...BEHAVIOR, ...machine, ...repo, set: { machine, repo } };
  for (const [k, s] of Object.entries(SETTINGS)) if (s.get) { try { b[k] = s.get({ store, home }) ?? null; } catch { b[k] = null; } }
  return b;
}
// One setting changed, for the machine or for one repository. Returns what it is now, in words, or what was wrong.
export function setBehavior(store, key, value, { scope = 'machine', home = thinkerHome() } = {}) {
  const s = SETTINGS[key];
  if (!s) return { error: `there is no setting called ${key}` };
  const v = s.read(value);
  if (v === undefined) return { error: `${key} cannot be ${JSON.stringify(value)} (${s.about})` };
  // a switch on another part of thinker: written where that part reads it, and never for one repository
  if (s.write) {
    s.write(v, { home });
    try { store?.log({ op: 'upkeep-set', key, scope: 'machine' }); } catch {}
    return { key, value: v, scope: 'machine', said: `${key} is now ${v} on this machine` };
  }
  const merge = cur => ({ ...(cur && typeof cur === 'object' ? cur : {}), [key]: v });
  if (scope === 'repo') {
    if (!store) return { error: 'no repository to set it for' };
    const file = path.join(store.dir, 'config.json');
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    cfg.upkeep = merge(cfg.upkeep);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  } else updateMachineConfig(home, cfg => ({ ...cfg, upkeep: merge(cfg.upkeep) }));
  try { store?.log({ op: 'upkeep-set', key, scope }); } catch {}
  return { key, value: v, scope, said: `${key} is now ${v} ${scope === 'repo' ? 'in this repository' : 'on this machine'}` };
}
// "More like this" and "less like this" (the owner, 2026-11-21: a person "can steer future decisions about things like
// that"): how readily thinker does one kind of thing, moved one step. A step halves or doubles the bar -- the dollars
// a day a change must save, the size a sweep must be -- so two words from the person are a definite change they are
// told the size of, and never a number the model picked. `changes` is every change to what loads into a prompt (a
// batch, a pull request, a tool: `prs` and `tools` are the same bar by the names single lines carry). `delegation` is
// the delegation trigger's own setting (delegate.js: the size a read must be to be handed to a cheaper agent), which
// is the machine's alone.
export const STEER = { kinds: ['changes', 'prs', 'tools', 'sweep', 'delegation'], delegation: { min: 2000, max: 64_000 }, minPerDay: { min: 0.25, max: 64 } };
const half = (n, min) => Math.max(min, Math.round(n / 2)), twice = (n, max) => Math.min(max, n * 2);
export function steerBehavior(store, kind, direction, { scope = 'machine', home = thinkerHome() } = {}) {
  const more = direction === 'more';
  if (!STEER.kinds.includes(kind)) return { error: `there is no kind of thing called ${kind}` };
  if (!more && direction !== 'less') return { error: 'more or less' };
  const where = scope === 'repo' ? 'in this repository' : 'on this machine';
  if (kind === 'delegation') {
    const cur = delegateConfig({ home }).threshold, next = more ? half(cur, STEER.delegation.min) : twice(cur, STEER.delegation.max);
    if (next === cur) return { error: `reads are already handed over ${more ? 'as readily' : 'as rarely'} as thinker will go (from ${formatTokens(cur)} tokens)` };
    updateMachineConfig(home, cfg => ({ ...cfg, delegate: { ...(cfg.delegate && typeof cfg.delegate === 'object' ? cfg.delegate : {}), threshold: next } }));
    try { store?.log({ op: 'upkeep-set', key: 'delegate.threshold', scope: 'machine' }); } catch {}
    return { said: `a read is now handed to a cheaper agent from ${formatTokens(next)} tokens on this machine (it was ${formatTokens(cur)})` };
  }
  const b = behaviorOf(scope === 'repo' ? store : null, { home });
  const set = (key, value) => setBehavior(store, key, value, { scope, home });
  if (kind === 'sweep') {
    if (!b.sweep) { if (!more) return { error: `thinker already does none of that ${where}` }; const r = set('sweep', true); return r.error ? r : { said: `thinker does that again ${where}` }; }
    const n = more ? half(b.sweepMin, 1) : twice(b.sweepMin, 100), mb = more ? half(b.sweepMinMb, 50) : twice(b.sweepMinMb, 100_000);
    if (n === b.sweepMin && mb === b.sweepMinMb) return { error: `a sweep is already ${more ? 'as ready' : 'as rare'} as thinker will go` };
    const r = [set('sweepMin', n), set('sweepMinMb', mb)].find(x => x.error);
    return r || { said: `merged worktrees and branches are now removed from ${plural(n, 'thing')} or ${mb} MB ${where} (it was ${b.sweepMin} or ${b.sweepMinMb} MB)` };
  }
  if ((kind === 'prs' || kind === 'tools') && !b[kind]) { if (!more) return { error: `thinker already does none of that ${where}` }; const r = set(kind, true); return r.error ? r : { said: `thinker does that again ${where}` }; }
  // changes, prs, tools: the dollars a day a change must save, halved for more of them and doubled for fewer
  const next = more ? Math.max(STEER.minPerDay.min, Math.round(b.minPerDay * 50) / 100) : Math.min(STEER.minPerDay.max, b.minPerDay * 2);
  if (next === b.minPerDay) return { error: `the bar is already ${more ? 'as low' : 'as high'} as thinker will go (${formatDollars(b.minPerDay)} a day)` };
  const r = set('minPerDay', next);
  return r.error ? r : { said: `a change must now save ${formatDollars(next)} a day before thinker makes it ${where} (it was ${formatDollars(b.minPerDay)})` };
}
// The behaviour in a sentence or two, for the page, the command and the chat.
export function behaviorSaid(b) {
  if (b.level === 'off') return 'Thinker is not looking after this repository (upkeep is off).';
  if (b.level === 'ask') return 'Thinker does nothing here until you tell it to.';
  const cuts = [b.prs ? (b.remove ? 'shortens or removes instruction sections nobody needs in a pull request' : 'shortens instruction sections nobody needs in a pull request') : '', b.tools ? 'switches off tools nobody calls' : '', b.skills ? 'switches off skills nobody calls' : ''].filter(Boolean);
  const does = [b.sweep ? 'removes merged worktrees and branches' : '', cuts.length ? `${cuts.join(' and ')}, but only what saves ${formatDollars(b.minPerDay)} a day or more, together in one batch once that comes to ${formatDollars(b.batchPerDay)} a day, at most every ${plural(b.batchEveryDays, 'day')}` : ''].filter(Boolean);
  return does.length ? `Thinker acts on its own here: it ${does.join('; ')}.${cuts.length && b.followUp ? ` ${plural(b.followUpDays, 'day')} after a change takes effect it checks it, and takes back what did not pay.` : ''}` : 'Thinker may act on its own here, but every kind of action is switched off.';
}

// --- what it remembers ---------------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'upkeep.json');
export function readUpkeep(store) {
  try { const j = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); return { lastCheck: j.lastCheck || null, items: j.items || [], seen: j.seen || {}, dismissed: j.dismissed || {}, done: j.done || [], kept: j.kept || null, followed: j.followed || {} }; }
  catch { return { lastCheck: null, items: [], seen: {}, dismissed: {}, done: [], kept: null, followed: {} }; }
}
function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(v) + '\n');
  fs.renameSync(tmp, f);
}
function writeUpkeep(store, st) {
  st.done = (st.done || []).slice(-UPKEEP.keepDone);
  // a change's check is forgotten long after it could matter
  const old = Date.now() - UPKEEP.followedDays * 86_400_000;
  for (const [id, f] of Object.entries(st.followed || {})) if (Date.parse(f.at) < old) delete st.followed[id];
  writeJson(stateFile(store), st);
}
// --- the chores ----------------------------------------------------------------------------------------------
// Each: `find` (a check's look, kept), `live` (read fresh every time, cheap, never kept), `still` (whether a kept
// item is still true), `act`, and where leaving a thing alone is more than forgetting it, `dismiss`. An item says
// whether it is `important` (worth doing) and which setting lets thinker do it (`allow`).
const messLines = mess => {
  const rows = [...mess.worktrees.map(w => `${path.basename(w.path)} · worktree on ${w.branch} · ${w.why}${w.kb ? ` · ${size(w.kb)}` : ''}`), ...mess.branches.map(b => `${b.name} · branch · ${b.why}`)];
  return rows.length > SWEEP.listed ? [...rows.slice(0, SWEEP.listed), `and ${rows.length - SWEEP.listed} more`] : rows;
};
const messKb = mess => mess.worktrees.reduce((a, x) => a + (x.kb || 0), 0);
const messTitle = mess => {
  const w = mess.worktrees.length, b = mess.branches.length, kb = messKb(mess);
  const what = [w ? plural(w, 'merged worktree') : '', b ? plural(b, w ? 'branch' : 'merged branch', w ? 'branches' : 'merged branches') : ''].filter(Boolean).join(' and ');
  return `${what} can go${kb ? ` · ${size(kb)}` : ''}`;
};
const sweepChore = {
  id: 'sweep',
  find(store, opts) {
    const found = (opts.fns?.findMess || findMess)(store, { now: opts.now }), kept = readUpkeep(store).kept;
    // what the person had put back after a sweep is theirs to keep
    const mess = { worktrees: found.worktrees.filter(w => !kept?.worktrees?.includes(w.path) && !kept?.branches?.includes(w.branch)), branches: found.branches.filter(b => !kept?.branches?.includes(b.name)) };
    const n = mess.worktrees.length + mess.branches.length;
    if (!n) return [];
    const b = opts.behavior;
    return [{ id: 'sweep', chore: 'sweep', kind: 'do', allow: 'sweep', important: n >= b.sweepMin || messKb(mess) >= b.sweepMinMb * 1024, title: messTitle(mess), detail: 'Their work is on the default branch already, so nothing is lost by removing them, and each can be put back.', lines: messLines(mess), action: { label: 'Remove them' }, data: { worktrees: mess.worktrees, branches: mess.branches } }];
  },
  // a worktree or a branch somebody removed by hand since the check leaves the list; an empty list leaves it altogether
  still(store, item) {
    const repo = store.home || store.repo;
    const worktrees = (item.data?.worktrees || []).filter(w => fs.existsSync(w.path));
    const branches = (item.data?.branches || []).filter(b => fs.existsSync(path.join(repo, '.git', 'refs', 'heads', ...b.name.split('/'))) || packed(repo, b.name));
    if (!worktrees.length && !branches.length) return null;
    const mess = { worktrees, branches };
    return worktrees.length === item.data.worktrees.length && branches.length === item.data.branches.length ? item : { ...item, title: messTitle(mess), lines: messLines(mess), data: mess };
  },
  act(store, item, opts) {
    const r = (opts.fns?.sweep || sweep)(store, item.data, { now: opts.now });
    const w = r.worktrees.length, b = r.branches.length;
    if (!w && !b) return { error: `nothing could be removed: ${r.skipped[0]?.why || 'everything changed since the last check'}` };
    const left = r.skipped.length ? `; ${plural(r.skipped.length, 'thing')} left where ${r.skipped.length === 1 ? 'it was' : 'they were'} (${short(r.skipped[0].why, 60)})` : '';
    return { said: `Removed ${[w ? plural(w, 'merged worktree') : '', b ? plural(b, w ? 'branch' : 'merged branch', w ? 'branches' : 'merged branches') : ''].filter(Boolean).join(' and ')}${left}`, ...(r.kb ? { impact: { kb: r.kb } } : {}), undo: { kind: 'sweep', branches: r.branches, worktrees: r.worktrees } };
  },
  undo(store, undo) {
    const r = unsweep(store, undo);
    const n = r.branches.length + r.worktrees.length;
    if (!n) return { error: `nothing could be put back: ${r.failed[0]?.why || 'nothing was taken'}` };
    return { said: `Put back ${[r.branches.length ? plural(r.branches.length, 'branch', 'branches') : '', r.worktrees.length ? plural(r.worktrees.length, 'worktree') : ''].filter(Boolean).join(' and ')}${r.failed.length ? `; ${r.failed.length} could not be (${short(r.failed[0].why, 60)})` : ''}` };
  },
};
function packed(repo, name) { try { return fs.readFileSync(path.join(repo, '.git', 'packed-refs'), 'utf8').includes(` refs/heads/${name}\n`); } catch { return false; } }

const viewOf = store => lastSnapshot(store, SUGGEST.days)?.view || null;
// What a change wastes a day here, in dollars: the tokens that went on it unused over the report's window, at what an
// input token cost here (context-view.js:rateOf, the Report's rule), a day of that window. null where nothing is priced.
const perDayOf = (c, rate) => (rate == null || !c.total || !c.days ? null : (c.total * rate) / c.days);
// What thinker does to a section by itself: removes it where no prompt of the window needed it at all, over enough
// sessions to say so, and it may; shortens it otherwise (the report's own suggestion is always to shorten).
const sectionAct = (c, b) => (b.remove && c.usedShare === 0 && (c.sessions || 0) >= UPKEEP.removeSessions && c.options?.some(o => o.act === 'remove') ? 'remove' : c.default.act);
const contextChore = {
  id: 'context',
  find(store, opts) {
    const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store);
    if (!view) return []; // no report kept yet: the next check has one (learn.js keeps it after maintenance)
    const rate = rateOf(view), canPr = (opts.fns?.prAvailable || prAvailable)(store.repo).ok;
    // a section is changed only as a pull request, which the team reviews: where none can be opened from here it is
    // not thinker's to change at all, by itself or on anybody's word
    return currentChanges(store, view, { now: opts.now, max: UPKEEP.batchMax }).filter(c => c.default && (c.kind !== 'section' || canPr)).map(c => {
      const sec = c.kind === 'section', perDay = perDayOf(c, rate), act = sec ? sectionAct(c, opts.behavior) : c.default.act;
      const worth = !c.total ? '' : perDay == null ? ` About ${formatTokens(c.total)} tokens went on it unused over the last ${c.days} days.` : ` About ${formatDollars(c.total * rate)} went on it unused over the last ${c.days} days, ${formatDollars(perDay)} a day.`;
      const label = !sec ? c.default.text : `Put up a PR to ${act === 'remove' ? 'remove' : 'shorten'} it`;
      // `perDay`: what it is worth, which is what makes it `important` (openItems reads it against the bar in force);
      // `rank`: the costliest first; `machine`: a tool is switched for every repository at once
      // `allow`: the setting that lets thinker make it by itself -- a section shortened, one removed, a tool, a skill
      return { id: `change:${c.key}`, chore: 'context', kind: sec ? 'pr' : 'do', allow: sec ? (act === 'remove' ? 'remove' : 'prs') : c.kind === 'skill' ? 'skills' : 'tools', important: perDay != null && perDay >= opts.behavior.minPerDay, perDay, rank: c.total || 0, ...(c.kind === 'tool' ? { machine: true } : {}), title: c.title, detail: `${c.why.charAt(0).toUpperCase()}${c.why.slice(1)}.${worth}`, action: { label }, data: { key: c.key, act } };
    });
  },
  // a change decided through any door since the check (the command, a batch) is no longer open; nor is one whose
  // pull request of thinker's own somebody closed without merging, which is a no (`refused`, below)
  still(store, item, ctx) { return ctx.decided.has(item.data?.key) || ctx.refused?.has(item.data?.key) ? null : item; },
  // each change with the action thinker settled on for it (`chosen`, where that is not the report's suggestion)
  pick(store, items, opts) { const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store); return view ? pickChanges(allChanges(view), items.map(it => it.data.key), Object.fromEntries(items.filter(it => it.data.act).map(it => [it.data.key, it.data.act]))) : []; },
  // one change, on the person's word in the chat: made by itself, outside any batch
  async act(store, item, opts) {
    const picked = this.pick(store, [item], opts);
    if (!picked.length) return { error: 'that part is no longer in the report; it is looked for again at the next check' };
    // A section is changed only as a pull request: asked again now, since the check that found it may be hours old,
    // and never left to fall back on writing the file in the working tree.
    let pr = opts.pr;
    if (item.kind === 'pr') {
      if (!(opts.fns?.prAvailable || prAvailable)(store.repo).ok) return { error: 'no pull request can be opened from here now' };
      pr = true;
    }
    // the decision, its pull request and its undo are kept by context-suggest.js, where Recent activity reads them
    const said = await approveChanges(store, picked, { via: VIA.thinker, now: opts.now, ...(opts.fns?.spawn ? { spawnFn: opts.fns.spawn } : {}), ...(pr === undefined ? {} : { pr }) });
    return { said: said.join(' '), kept: true };
  },
  dismiss(store, item, opts) {
    const picked = this.pick(store, [item], opts);
    if (picked.length) dismissChanges(store, picked, { via: VIA.thinker, now: opts.now });
    return { kept: true };
  },
};

// The sections of the instruction files by the id their verdicts are kept under.
function sectionTitles(repo) {
  const out = new Map();
  for (const f of instructionFiles(repo)) {
    const ss = sections(f.text);
    for (const s of ss.length ? ss : [{ title: f.file, parent: null }]) out.set(sectionId(f, s), `${f.file} · ${s.parent ? `${s.parent}: ` : ''}${s.title}`);
  }
  return out;
}
const rulesChore = {
  id: 'rules',
  find(store, { now }) {
    const since = now - UPKEEP.ruleDays * DAY, by = new Map();
    for (const [session, rec] of Object.entries(readValueState(store).sessions)) {
      const at = Date.parse(rec.judged?.at || '');
      if (!Number.isFinite(at) || at < since) continue;
      for (const [id, v] of Object.entries(rec.judged.verdicts || {})) {
        if (!by.has(id)) by.set(id, { bore: 0, broken: 0, evidence: [] });
        const g = by.get(id); g.bore++;
        if (v.verdict === 'violated') { g.broken++; if (v.evidence) g.evidence.push({ at, session, text: v.evidence }); }
      }
    }
    const broken = [...by].filter(([, g]) => g.broken >= UPKEEP.ruleBroken);
    if (!broken.length) return [];
    const titles = sectionTitles(store.repo);
    // a section that has left the file is nobody's rule any more
    return broken.filter(([id]) => titles.has(id)).sort((a, b) => b[1].broken - a[1].broken).map(([id, g]) => ({
      id: `rule:${id}`, chore: 'rules', kind: 'note', allow: null, important: true, title: `Agents keep breaking a rule: ${titles.get(id)}`,
      detail: `Broken in ${g.broken} of the ${plural(g.bore, 'session')} it came up in over the last ${UPKEEP.ruleDays} days. It is in the file and still missed, so more words there will not fix it.`,
      lines: g.evidence.sort((a, b) => b.at - a.at).slice(0, 3).map(e => short(e.text, 200)), action: null, data: { section: id, broken: g.broken, bore: g.bore },
    }));
  },
};

// A change of thinker's own that did not go through, read from the decisions' history each time (never kept): tried
// again a day later, UPKEEP.retries times in all. A pull request waiting on its review is not here: that is the
// team's, and the line about it in the activity carries its link.
const waitingChore = {
  id: 'waiting',
  live(store, { now }) {
    const out = [];
    for (const e of changeHistory(store, { now })) {
      if (e.revertedAt || e.attention !== 'failed' || e.via !== VIA.thinker) continue;
      const id = `wait:job:${e.group || e.id}`;
      if (out.some(x => x.id === id)) continue;
      out.push({ id, chore: 'waiting', kind: 'do', allow: 'prs', important: true, title: `Trying again: ${e.title}`, detail: short(e.job?.error || 'it failed', 200), action: { label: 'Try again' }, found: e.job?.finishedAt || e.at, data: { history: e.id, tries: e.job?.tries || 1, failedAt: e.job?.finishedAt || e.at } });
    }
    return out;
  },
  act(store, item, opts) {
    const r = retryJob(store, item.data.history, { now: opts.now, ...(opts.fns?.spawn ? { spawnFn: opts.fns.spawn } : {}) });
    return r.error ? { error: r.error } : { said: r.said, kept: true };
  },
};
export const CHORES = [waitingChore, sweepChore, contextChore, rulesChore];
const choreOf = id => CHORES.find(c => c.id === id);

// --- acting by itself ----------------------------------------------------------------------------------------
const OFF_WHY = { sweep: 'sweeps are switched off here', prs: 'pull requests are switched off here', remove: 'it may shorten a section here but not remove one', tools: 'switching tools is switched off here', skills: 'skills are left alone unless you say otherwise' };
// whether the settings let thinker do an item by itself at all (a removal is a pull request too)
const allowed = (b, it) => Boolean(b[it.allow]) && (it.allow !== 'remove' || Boolean(b.prs));
const lastBatch = store => Math.max(0, ...readUpkeep(store).done.filter(d => d.kind === 'batch').map(d => Date.parse(d.at)));

// The batch: every change worth making that thinker may make here, what they waste a day between them, and whether
// it goes now (`ok`); else why not (`why`) and whether it is only waiting (`later`). The owner's answers, 2026-11-21:
// a batch goes "when enough has piled up" and never more than one a week; one still being made is not doubled; a
// pull request of an earlier batch still in review holds nothing up ("open another").
export function batchOf(store, b, { now = Date.now(), items } = {}) {
  const may = (items || openItems(store, { now, b })).filter(it => it.chore === 'context' && it.action && allowed(b, it));
  const perDay = may.reduce((a, it) => a + (it.perDay || 0), 0), r = { items: may, perDay };
  if (!may.length) return { ...r, ok: false };
  if (b.level !== 'auto') return { ...r, ok: false, why: 'you asked to be asked first' };
  const wait = why => ({ ...r, ok: false, later: true, why });
  let making = false; try { making = changeHistory(store, { now }).some(e => !e.revertedAt && e.attention === 'running'); } catch {}
  if (making) return wait('a change is still being made here');
  const last = lastBatch(store);
  if (last && now - last < b.batchEveryDays * DAY) return wait(`one batch every ${plural(b.batchEveryDays, 'day')} here, and the last went ${ago(new Date(last).toISOString(), now)}`);
  if (perDay < b.batchPerDay) return wait(`the changes worth making come to ${formatDollars(perDay)} a day together so far, and a batch goes at ${formatDollars(b.batchPerDay)}`);
  return { ...r, ok: true };
}

// Whether thinker may do an item now, and if not, why (`why`), and whether it is only waiting its turn (`later`):
// the level, the setting for its kind, then its turn -- a context change goes with the batch (`batch`: the batch as
// already worked out, by a caller asking about several), a sweep at most so often. What the person tells it to do in
// the chat is held to none of this.
export function mayAct(store, item, b, { now = Date.now(), batch } = {}) {
  if (!item.important || !item.action || !item.allow) return { ok: false };
  if (b.level !== 'auto') return { ok: false, why: 'you asked to be asked first' };
  if (!allowed(b, item)) return { ok: false, why: OFF_WHY[b[item.allow] ? 'prs' : item.allow] || `${item.allow} is off` };
  const wait = why => ({ ok: false, later: true, why });
  if (item.chore === 'waiting') return item.data.tries >= UPKEEP.retries ? { ok: false, why: `it failed ${item.data.tries} times` } : now - Date.parse(item.data.failedAt) < DAY ? wait('it is tried again a day after it failed') : { ok: true };
  if (item.chore === 'context') { const bt = batch || batchOf(store, b, { now }); return bt.ok ? { ok: true } : { ok: false, ...(bt.later ? { later: true } : {}), why: bt.why || 'not now' }; }
  const mine = readUpkeep(store).done.filter(d => d.by === 'thinker' && !d.undoneAt);
  const last = chore => Math.max(0, ...mine.filter(d => d.chore === chore).map(d => Date.parse(d.at)));
  if (item.allow === 'sweep' && now - last('sweep') < b.sweepEveryDays * DAY) return wait(`one sweep every ${plural(b.sweepEveryDays, 'day')} here`);
  return { ok: true };
}

// A batch made: every change in it through the one door (context-suggest.js:approveChanges, which keeps each decision
// under the batch's id), its sections as one job and one pull request whatever they shorten and remove. One thing
// done, and one line of the activity.
async function doBatch(store, items, { now, by, fns = {} }) {
  const canPr = (fns.prAvailable || prAvailable)(store.repo).ok;
  const picked = contextChore.pick(store, items, { fns }).filter(c => c.default && (c.kind !== 'section' || canPr));
  if (!picked.length) return { error: 'nothing of the batch can be made now; it is looked for again at the next check' };
  const id = randomBytes(5).toString('hex'), made = [];
  try { await approveChanges(store, picked, { via: VIA.thinker, now, pr: true, batch: id, made, ...(fns.spawn ? { spawnFn: fns.spawn } : {}) }); }
  catch (e) { if (!made.some(m => !m.error)) return { error: short(e.message || e, 200) }; }
  const keys = new Set(made.filter(m => !m.error).map(m => m.key));
  if (!keys.size) return { error: short(made[0]?.error || 'nothing could be changed', 200) };
  const went = items.filter(it => keys.has(it.data.key)), of = k => picked.filter(c => keys.has(c.key) && k(c));
  const secs = of(c => c.kind === 'section'), gone = secs.filter(c => (c.chosen || c.default.act) === 'remove').length, kept = secs.length - gone, tools = of(c => c.kind === 'tool').length, skills = of(c => c.kind === 'skill').length;
  const perDay = went.reduce((a, it) => a + (it.perDay || 0), 0);
  const parts = [secs.length ? `a pull request that ${[kept ? `shortens ${plural(kept, 'section')}` : '', gone ? `removes ${kept ? gone : plural(gone, 'section')}` : ''].filter(Boolean).join(' and ')}` : '', tools ? `${plural(tools, 'tool')} switched off or made a reference` : '', skills ? `${plural(skills, 'skill')} switched off` : ''].filter(Boolean);
  const said = `Sent a batch of ${plural(keys.size, 'change')}${perDay ? ` worth about ${formatDollars(perDay)} a day` : ''}: ${parts.join(', ')}`;
  const st = readUpkeep(store);
  for (const it of went) forget(st, it.id);
  const entry = { id, at: new Date(now).toISOString(), item: 'batch', chore: 'context', kind: 'batch', title: `A batch of ${plural(keys.size, 'change')}`, said, by, kept: true, batch: { keys: [...keys], perDay, sections: secs.length, removed: gone, tools, skills } };
  st.done.push(entry);
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-do', chore: 'context', kind: 'batch', by, changes: keys.size });
  return { said, done: id, title: entry.title, changes: keys.size };
}

// --- a week on: did it pay? ----------------------------------------------------------------------------------
// The owner's answer, 2026-11-21: "Check, and undo what backfired" -- a week after a change takes effect thinker
// measures it; where the saving did not show up, or the thing turned out to be needed, it takes it back, does not try
// that one again, and says so in Recent activity. No model call: everything read here was measured already.
// When a change took effect: a tool when it was switched, a section when its pull request merged.
const sinceOf = e => Date.parse(e.kind === 'section' ? (e.pr?.state === 'merged' ? e.pr.at || '' : '') : e.at || '');
// How often sessions broke a section's rule between two times, from the one read each session gets when it ends
// (instruction-value.js: the verdicts kept on its record).
function ruleTally(store, section, from, to) {
  let bore = 0, broken = 0;
  const id = String(section || '').toLowerCase();
  for (const rec of Object.values(readValueState(store).sessions || {})) {
    const at = Date.parse(rec.judged?.at || '');
    if (!(at >= from && at < to)) continue;
    const v = Object.entries(rec.judged.verdicts || {}).find(([k]) => k.toLowerCase() === id)?.[1];
    if (!v) continue;
    bore++; if (v.verdict === 'violated') broken++;
  }
  return { bore, broken };
}
// One change judged: { verdict: 'undo', why } where it backfired, { verdict: 'kept', why } where it paid or nothing
// says it did not, null while it is too early to say. Three things say a change backfired:
//   - its measured effect (report.js:actionEffect, the thing's cost a prompt before against since) is no saving at all;
//   - a shortened section's rule was broken in UPKEEP.ruleBroken sessions since, and more often than before;
//   - a tool made a reference was still called in UPKEEP.needShare of prompts (the kept report's window, all of it
//     after the switch).
function judge(store, e, { now, b, view }) {
  const since = sinceOf(e);
  if (!Number.isFinite(since) || now - since < b.followUpDays * DAY) return null;
  // an effect speaks only where the thing had a cost to lose: nothing on both sides is no measurement
  const fx = e.effect?.before?.perPrompt > 0 ? e.effect : null, late = now - since >= UPKEEP.followGiveUpDays * DAY;
  if (fx && !fx.few && fx.delta <= 0) return { verdict: 'undo', why: `it saved nothing: it cost ${formatTokens(Math.round(fx.before.perPrompt))} tokens a prompt before and ${formatTokens(Math.round(fx.after.perPrompt))} since` };
  if (e.kind === 'section' && e.act === 'compress') {
    const after = ruleTally(store, e.section, since, now), before = ruleTally(store, e.section, since - (now - since), since);
    if (after.broken >= UPKEEP.ruleBroken && after.broken / after.bore > (before.bore ? before.broken / before.bore : 0)) return { verdict: 'undo', why: `agents broke it in ${after.broken} of the ${plural(after.bore, 'session')} it came up in since it was shortened (${before.broken} of ${before.bore} over as long before)` };
  }
  if (e.kind === 'tool' && /reference/i.test(e.action || '') && view?.days && view.days * DAY <= now - since) {
    const row = (view.tools || []).find(t => `${t.client}:${t.key}` === e.key);
    if (row?.usedShare != null && row.usedShare >= UPKEEP.needShare) return { verdict: 'undo', why: `it was still called in ${Math.round(100 * row.usedShare)}% of prompts after it was made a reference` };
  }
  // under five sessions on a side is early: looked at again, until it has been long enough to stop waiting
  if (fx && (!fx.few || late)) return { verdict: 'kept', why: `it saves ${formatTokens(Math.round(fx.delta))} tokens a prompt, over ${plural(fx.after.sessions, 'session')} since${fx.few ? ' (few, so the figure is early)' : ''}` };
  return late ? { verdict: 'kept', why: 'no session since could measure it' } : null;
}
// Every change of thinker's own batches that has been in effect long enough and was not checked yet: checked, and
// taken back where it backfired. Returns what was taken back, as things done. A change the person asked for by name is
// not thinker's to take back; one whose undo fails is tried again at the next checks, UPKEEP.retries times in all.
async function followUp(store, b, { now, fns = {} }) {
  const mine = new Set(readUpkeep(store).done.filter(d => d.kind === 'batch' && d.by === 'thinker').map(d => d.id));
  if (!mine.size) return [];
  let history = []; try { history = changeHistory(store, { now }); } catch { return []; }
  try { history = withEffects(history, (fns.report ? fns.report(store) : keptRows(store, { now })).rows || [], now); } catch {}
  const view = fns.view ? fns.view(store) : viewOf(store), did = [];
  for (const e of history) {
    if (!e.batch || !mine.has(e.batch) || e.decision === 'dismissed' || e.revertedAt || e.running || e.failed) continue;
    const had = readUpkeep(store).followed[e.id];
    if (had && had.verdict !== 'retry') continue;
    const j = judge(store, e, { now, b, view });
    if (!j) continue;
    const at = new Date(now).toISOString(), keep = f => { const st = readUpkeep(store); f(st); writeUpkeep(store, st); };
    if (j.verdict === 'kept') { keep(st => { st.followed[e.id] = { at, verdict: 'kept', why: j.why }; }); store.log({ op: 'upkeep-follow', kind: e.kind, verdict: 'kept' }); continue; }
    let r;
    try {
      r = e.kind === 'section'
        ? await (fns.restore || restoreSection)(store, e.id, { now, why: j.why, ...(fns.prs ? { prs: fns.prs } : {}), ...(fns.edit ? { edit: fns.edit } : {}) })
        : await (fns.revert || revertDecision)(store, e.id, { now, ...(fns.prs ? { prs: fns.prs } : {}) });
    } catch (err) { r = { error: short(err.message || err, 200) }; }
    if (r.error) {
      const tries = (had?.tries || 0) + 1;
      keep(st => { st.followed[e.id] = { at, verdict: tries >= UPKEEP.retries ? 'held' : 'retry', tries, why: j.why, error: short(r.error, 200) }; });
      continue;
    }
    const said = r.pr ? `Opened PR #${r.pr.number} to put ${e.title} back as it was: ${j.why}` : `Turned ${e.title} back on: ${j.why}`;
    keep(st => {
      st.followed[e.id] = { at, verdict: 'undone', why: j.why };
      for (const k of e.keys || [e.key]) st.dismissed[`change:${k}`] = at;
      st.done.push({ id: randomBytes(5).toString('hex'), at, item: `follow:${e.id}`, chore: 'follow', kind: 'did', title: e.title, said, by: 'thinker', ...(r.pr?.url ? { url: r.pr.url } : {}) });
    });
    store.log({ op: 'upkeep-follow', kind: e.kind, verdict: 'undone' });
    did.push({ id: `follow:${e.id}`, kind: 'did', said });
  }
  return did;
}

// --- a check -------------------------------------------------------------------------------------------------
// One look at everything, kept; then what thinker may do, done (`act: false` only looks, which is all a visit to
// the page ever starts). Returns what it did and how much is waiting.
export async function upkeepCheck(store, { now = Date.now(), fns = {}, act = true, home = thinkerHome() } = {}) {
  const b = behaviorOf(store, { home });
  if (b.level === 'off') return { skipped: 'off' };
  const st = readUpkeep(store), at = new Date(now).toISOString(), items = [], errors = [];
  for (const c of CHORES) {
    if (!c.find) continue;
    try { items.push(...await c.find(store, { now, fns, behavior: b })); } catch (e) { errors.push({ chore: c.id, message: short(e.message || e, 200) }); }
  }
  // when each thing was first found: an item that leaves and comes back is found again
  st.seen = Object.fromEntries(items.map(it => [it.id, st.seen[it.id] || at]));
  st.items = items.map(it => ({ ...it, found: st.seen[it.id] }));
  for (const [id, t] of Object.entries(st.dismissed)) if (now - Date.parse(t) >= UPKEEP.dismissDays * DAY) delete st.dismissed[id];
  st.lastCheck = at;
  writeUpkeep(store, st);
  const did = [];
  if (act && b.level === 'auto') {
    // a failed change of its own tried again, a sweep: each on its own turn
    for (const it of openItems(store, { now, b })) {
      if (it.chore === 'context' || !mayAct(store, it, b, { now }).ok) continue;
      const r = await upkeepDo(store, it.id, { now, by: 'thinker', fns, home });
      if (!r.error) did.push({ id: it.id, kind: it.kind, said: r.said });
    }
    // the context changes worth making, together or not at all
    const batch = batchOf(store, b, { now });
    if (batch.ok) {
      const r = await doBatch(store, batch.items, { now, by: 'thinker', fns });
      if (!r.error) did.push({ id: 'batch', kind: 'batch', said: r.said, changes: r.changes });
    }
    // and the changes of earlier batches, once each, a week into their effect
    if (b.followUp) { try { did.push(...await followUp(store, b, { now, fns })); } catch (e) { errors.push({ chore: 'follow', message: short(e.message || e, 200) }); } }
  }
  const { pending } = upkeepPending(store, { now, home });
  store.log({ op: 'upkeep', did: did.length, pending: pending.length || undefined, level: b.level, acted: Boolean(act), chores: Object.fromEntries(CHORES.map(c => [c.id, did.filter(d => choreOfItem(d.id) === c.id).length]).filter(([, n]) => n)), ...(errors.length ? { errors: errors.length } : {}) });
  return { did, pending: pending.length, errors };
}
const choreOfItem = id => id === 'sweep' ? 'sweep' : id === 'batch' || id.startsWith('change:') ? 'context' : id.startsWith('wait:') ? 'waiting' : id.startsWith('rule:') ? 'rules' : 'other';

// --- what is not done yet ------------------------------------------------------------------------------------
const ORDER = { pr: 1, do: 2, note: 3 };
// pull requests first, then the rest; within a kind the chores in their own order, then the costliest, then the newest
const choreAt = it => { const i = CHORES.findIndex(c => c.id === it.chore); return i < 0 ? CHORES.length : i; };
const byOrder = (a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || choreAt(a) - choreAt(b) || (b.rank || 0) - (a.rank || 0) || String(b.found || '').localeCompare(String(a.found || ''));
// Everything worth doing the last check found that still holds and was not left alone, in the order it matters. A
// context change is worth making at the bar in force now (`b.minPerDay`), not the one its check ran under, so a word
// in the chat moves what is held at once.
function openItems(store, { now = Date.now(), b = behaviorOf(store) } = {}) {
  const st = readUpkeep(store);
  let decided = new Set(); try { decided = decidedKeys(store, { now }); } catch {}
  // A pull request of thinker's own that was closed without merging means "not this" (the owner's answer, 2026-11-21):
  // its sections are left alone for UPKEEP.dismissDays, though `thinker context` lists them again at once.
  let refused = new Set(); try { refused = new Set(changeHistory(store, { now }).filter(h => h.via === VIA.thinker && h.rejected && now - Date.parse(h.pr?.at || h.at) < UPKEEP.dismissDays * DAY).flatMap(h => h.keys || [h.key])); } catch {}
  const items = [];
  for (const c of CHORES) { if (c.live) { try { items.push(...c.live(store, { now })); } catch {} } }
  for (const it of st.items) {
    const c = choreOf(it.chore); if (!c) continue;
    let cur = it; try { if (c.still) cur = c.still(store, it, { decided, refused, now }); } catch { cur = it; }
    if (cur) items.push(cur);
  }
  // (one kept by a check from before the bar was dollars carries no figure, and waits for the next check to price it)
  const worth = it => (it.chore === 'context' ? it.perDay != null && it.perDay >= b.minPerDay : Boolean(it.important));
  return items.filter(it => worth(it) && (!st.dismissed[it.id] || now - Date.parse(st.dismissed[it.id]) >= UPKEEP.dismissDays * DAY)).map(it => (it.important ? it : { ...it, important: true })).sort(byOrder);
}
// What thinker found and has not done, each with why (`pending`: it waits its turn or its batch, or the person's
// word, or a setting says no), what is worth knowing (`notes`: a rule sessions keep breaking), and the batch those
// changes make (`batch`: how many, what they waste a day together, why it has not gone). None of it is a list for the
// person to work through: the page shows only how much is waiting, and the chat is shown all of it, so thinker can
// say what it is holding and be told to go ahead.
export function upkeepPending(store, { now = Date.now(), home = thinkerHome() } = {}) {
  const st = readUpkeep(store), b = behaviorOf(store, { home }), pending = [], notes = [], open = openItems(store, { now, b });
  const batch = batchOf(store, b, { now, items: open });
  for (const it of open) {
    if (!it.action) { notes.push(it); continue; }
    const may = mayAct(store, it, b, { now, batch });
    pending.push({ ...it, why: may.ok ? (it.chore === 'context' ? 'it goes with the batch at the next check' : 'at its next check') : may.why || 'not now', ...(may.ok || may.later ? { later: true } : {}) });
  }
  return { lastCheck: st.lastCheck, pending, notes, batch: { changes: batch.items.length, perDay: batch.perDay, ok: batch.ok, ...(batch.later ? { later: true } : {}), ...(batch.why ? { why: batch.why } : {}) } };
}
const itemOf = (store, ref, now, b) => openItems(store, { now, b }).find(it => it.id === ref) || null;
const forget = (st, id) => { st.items = st.items.filter(it => it.id !== id); };

// Do what an item offers, by its id. `by`: a check (`thinker`), or the person saying so in the chat (`you`), who is
// held to no limit. `batch` is the batch itself: everything thinker may change here, now, whatever it comes to and
// however lately the last one went. What was done is kept for the activity with its undo.
export async function upkeepDo(store, ref, { now = Date.now(), by = 'you', fns = {}, pr, home = thinkerHome() } = {}) {
  const b = behaviorOf(store, { home });
  if (ref === 'batch') {
    const batch = batchOf(store, b, { now });
    if (!batch.items.length) return { error: 'nothing is waiting for a batch here' };
    return doBatch(store, batch.items, { now, by, fns });
  }
  const it = itemOf(store, ref, now, b);
  if (!it) return { error: `nothing is waiting under ${ref}` };
  const c = choreOf(it.chore);
  if (!it.action || !c?.act) return { error: `${it.title}: there is nothing thinker can do about it` };
  let r; try { r = await c.act(store, it, { now, fns, pr, by }); } catch (e) { r = { error: short(e.message || e, 200) }; }
  if (r.error) return { error: r.error, item: it.id };
  const st = readUpkeep(store);
  forget(st, it.id);
  const entry = { id: randomBytes(5).toString('hex'), at: new Date(now).toISOString(), item: it.id, chore: it.chore, kind: it.kind, title: it.title, said: r.said, by, ...(r.impact ? { impact: r.impact } : {}), ...(r.undo ? { undo: r.undo } : {}), ...(r.kept ? { kept: true } : {}) };
  st.done.push(entry);
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-do', chore: it.chore, kind: it.kind, by });
  return { said: [r.said, impactSaid(r.impact)].filter(Boolean).join(' · '), done: entry.id, title: it.title };
}
// Leave a thing alone, as the person said in the chat: thinker does not come back to it for UPKEEP.dismissDays (a
// context change is also left alone in its own history, as `thinker context --dismiss` leaves it).
export function upkeepDismiss(store, ref, { now = Date.now(), fns = {}, home = thinkerHome() } = {}) {
  const it = itemOf(store, ref, now, behaviorOf(store, { home }));
  if (!it) return { error: `nothing is waiting under ${ref}` };
  const c = choreOf(it.chore), st = readUpkeep(store);
  let kept = false; try { kept = Boolean(c?.dismiss?.(store, it, { now, fns })?.kept); } catch {}
  st.dismissed[it.id] = new Date(now).toISOString();
  if (kept) forget(st, it.id);
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-dismiss', chore: it.chore, kind: it.kind });
  return { said: `${it.title}: left alone for the next ${plural(UPKEEP.dismissDays, 'day')}` };
}
// Take back something that was done, by the id the activity carries: a sweep is put back (`<id>`), a decision is
// reverted where its history is kept (`h:<id>`, context-suggest.js:revertDecision -- a tool turned back on, an open
// pull request closed, a merged one reverted by another), a whole batch each of its changes in turn (`b:<id>`).
// What the person took back is not done again: its change is left alone as if they had said so.
const leaveAlone = (store, keys, now) => { const st = readUpkeep(store); for (const k of keys) st.dismissed[`change:${k}`] = new Date(now).toISOString(); writeUpkeep(store, st); };
// (the decision's own words end "suggested again": not by thinker, which now leaves it alone)
const tookBack = r => String(r.said || 'Taken back').replace(/; suggested again.*$/, '');
export async function upkeepUndo(store, id, { now = Date.now(), fns = {} } = {}) {
  if (String(id).startsWith('b:')) {
    const bid = String(id).slice(2), all = changeHistory(store, { now }).filter(h => h.batch === bid), left = all.filter(h => !h.revertedAt && h.revertible);
    if (!all.length) return { error: 'no such batch' };
    if (!left.length) return { error: all.every(h => h.revertedAt) ? 'already taken back' : 'nothing of that batch can be taken back from here' };
    const said = [], failed = [], done = new Set();
    for (const h of left) {
      // the sections of one pull request go together: the first takes the others with it
      const g = h.group || h.id; if (done.has(g)) continue; done.add(g);
      const r = await revertDecision(store, h.id, { now, ...(fns.prs ? { prs: fns.prs } : {}) });
      if (r.error) failed.push(`${h.title}: ${r.error}`); else said.push(tookBack(r));
    }
    if (!said.length) return { error: failed[0] };
    leaveAlone(store, left.flatMap(h => h.keys || [h.key]), now);
    store.log({ op: 'upkeep-undo', chore: 'context', kind: 'batch' });
    return { said: [...said, ...(failed.length ? [`could not take back: ${failed.join('; ')}`] : [])].join('. ') };
  }
  if (String(id).startsWith('h:')) {
    const hid = String(id).slice(2), e = changeHistory(store, { now }).find(h => h.id === hid);
    const r = await revertDecision(store, hid, { now, ...(fns.prs ? { prs: fns.prs } : {}) });
    if (r.error) return { error: r.error };
    leaveAlone(store, e ? e.keys || [e.key] : [], now);
    store.log({ op: 'upkeep-undo', chore: 'context' });
    return { said: tookBack(r) };
  }
  const st = readUpkeep(store), e = st.done.find(d => d.id === id);
  if (!e) return { error: 'no such action' };
  if (e.undoneAt) return { error: 'already taken back' };
  const c = choreOf(e.chore);
  if (!e.undo || !c?.undo) return { error: 'this one cannot be taken back' };
  let r; try { r = c.undo(store, e.undo); } catch (err) { r = { error: short(err.message || err, 200) }; }
  if (r.error) return { error: r.error };
  e.undoneAt = new Date(now).toISOString();
  // ... and what was put back stays: those branches and worktrees are never swept again
  if (e.undo.kind === 'sweep') st.kept = { branches: [...new Set([...(st.kept?.branches || []), ...(e.undo.branches || []).map(b => b.name)])], worktrees: [...new Set([...(st.kept?.worktrees || []), ...(e.undo.worktrees || []).map(w => w.path)])] };
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-undo', chore: e.chore });
  return { said: r.said };
}

// --- what was done -------------------------------------------------------------------------------------------
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// What a line came to, in a few words (the owner's ask, 2026-11-21: "one line summary of the action and its impact,
// e.g. -10k tokens per prompt, $45/day"). Tokens off every prompt are the decision's own measured effect once the
// sessions since can say (report.js:actionEffect: the thing's cost a prompt before against after), and until then what
// the Context report expected of it, said as "about". A day's dollars are those tokens over the prompts a day here at what an
// input token costs here (report-snapshot.js:inputRateHere, the Report's rate), and are left out where nothing is priced.
export function impactSaid(i) {
  if (!i) return '';
  if (i.kb) return `${size(i.kb)} freed`;
  if (!i.perPrompt) return '';
  const saved = i.perPrompt > 0, day = i.perDay != null && Math.abs(i.perDay) >= 0.005 ? ` · ${formatDollars(Math.abs(i.perDay))}/day${saved ? '' : ' more'}` : '';
  // `wait`: the part of it that is not in effect until a pull request merges (a batch: its tools are, its sections are not)
  const w = i.wait, waits = !w || !w.perPrompt ? '' : ` (${w.perDay != null && Math.abs(w.perDay) >= 0.005 ? `${formatDollars(Math.abs(w.perDay))}/day` : `${formatTokens(Math.abs(Math.round(w.perPrompt)))} tokens`} of it once ${w.pr ? `PR #${w.pr}` : 'its pull request'} merges)`;
  return `${i.measured ? '' : 'about '}${saved ? '−' : '+'}${formatTokens(Math.abs(Math.round(i.perPrompt)))} tokens per prompt${day}${waits || (i.pending ? ' once merged' : '')}`;
}
const profileSaid = (p, where = '') => `Updated your profile${where}: ${[p.added ? `${plural(p.added, 'line')} added` : '', p.reworded ? `${p.reworded} reworded` : '', p.dropped ? `${p.dropped} dropped` : ''].filter(Boolean).join(', ')}`;
// a decision as the thing that was done, in one line
function didSaid(e, what) {
  if (e.kind === 'section') {
    const gone = e.act === 'remove';
    if (e.running) return `${gone ? 'Removing' : 'Shortening'} ${what}`;
    if (e.failed) return `Could not ${gone ? 'remove' : 'shorten'} ${what}`;
    if (e.pr) return e.pr.state === 'merged' ? `PR #${e.pr.number} merged: ${gone ? 'removed' : 'shortened'} ${what}` : e.pr.state === 'closed' ? `PR #${e.pr.number} closed without merging: ${what}` : `PR #${e.pr.number} in review: ${gone ? 'removes' : 'shortens'} ${what}`;
    return `${gone ? 'Removed' : 'Shortened'} ${what} in the working tree`;
  }
  if (e.kind === 'tool' || e.kind === 'skill') return e.act === 'on' ? `Turned ${what} back on` : /reference/i.test(e.action || '') ? `Made ${what} a tool reference` : `Switched off ${what}`;
  return `${what}: ${e.result || e.decision}`;
}
// A batch as one line: what its pull request does and where it stands, the tools it switched, and what all of it came
// to -- measured for the changes the sessions since can speak for, expected for the rest, and how much of it waits on
// the pull request. `of`: the batch's decisions with their effects; `perDay`: the prompts a day here.
const count = (n, one) => plural(n, one);
function batchLine(of, { rate, perDay, by }) {
  const secs = of.filter(h => h.kind === 'section'), rest = of.filter(h => h.kind !== 'section'), first = of[0];
  const stay = secs.filter(h => !h.revertedAt), put = secs.length - stay.length;
  const pr = secs.find(h => h.pr)?.pr || null, gone = stay.filter(h => h.act === 'remove').length, kept = stay.length - gone;
  const waiting = h => Boolean(h.running || h.pr?.state === 'open'), nothing = h => Boolean(h.failed || h.revertedAt || h.pr?.state === 'closed');
  const does = (a, b) => [kept ? `${a} ${count(kept, 'section')}` : '', gone ? `${b} ${kept ? gone : count(gone, 'section')}` : ''].filter(Boolean).join(' and ');
  const parts = [];
  if (secs.length) {
    parts.push(secs.every(h => h.revertedAt) ? `its pull request${pr ? ` #${pr.number}` : ''} was taken back`
      : secs.some(h => h.running) ? `${does('shortening', 'removing')}`
      : secs.some(h => h.failed) ? `could not change ${count(secs.length, 'section')}`
      : !pr ? `${does('shortened', 'removed')} in the working tree`
      : pr.state === 'merged' ? `PR #${pr.number} merged, which ${does('shortened', 'removed')}${put ? `; ${put} put back since` : ''}`
      : pr.state === 'closed' ? `PR #${pr.number} closed without merging (${count(secs.length, 'section')})`
      : `PR #${pr.number} in review ${does('shortens', 'removes')}`);
  }
  const live = rest.filter(h => !h.revertedAt), refs = live.filter(h => /reference/i.test(h.action || '')).length, off = live.length - refs, back = rest.length - live.length;
  if (rest.length) parts.push([refs ? `${count(refs, 'tool')} made ${refs === 1 ? 'a reference' : 'references'}` : '', off ? `${off} switched off` : '', back ? `${back} taken back` : ''].filter(Boolean).join(', '));
  // the newest thing that happened to it: made, its pull request opened, merged or closed
  const at = of.map(h => h.pr?.at || h.job?.finishedAt || h.at).sort().at(-1);
  const counted = of.filter(h => !nothing(h)), fig = h => (!waiting(h) && h.effect ? h.effect.delta : h.saving || 0);
  const perPrompt = counted.reduce((a, h) => a + fig(h), 0), held = counted.filter(waiting).reduce((a, h) => a + fig(h), 0);
  const dollars = n => (rate != null && perDay ? n * perDay * rate : null);
  const impact = perPrompt ? { perPrompt, perDay: dollars(perPrompt), promptsPerDay: perDay, measured: counted.every(h => !waiting(h) && h.effect), ...(held && held < perPrompt ? { wait: { perPrompt: held, perDay: dollars(held), ...(pr ? { pr: pr.number } : {}) } } : held ? { pending: true } : {}) } : null;
  const undoable = of.some(h => h.revertible && !h.revertedAt), shared = rest.filter(h => h.scope === 'machine').map(h => h.id);
  return { at, impact, x: { id: `b:${first.batch}`, at, kind: pr ? 'pr' : 'change', steer: 'changes', batch: { changes: of.length, sections: secs.length, tools: rest.length }, text: `Batch of ${of.length}: ${parts.join('; ')}`, by, ...(pr?.url ? { url: pr.url } : {}), ...(pr ? { pr: { number: pr.number, state: pr.state } } : {}), ...(of.every(h => h.revertedAt) ? { undone: true } : undoable ? { undo: `b:${first.batch}` } : {}), ...(shared.length ? { sharedIn: shared } : {}) } };
}
// Newest first, a line an action with what it came to: what thinker did here and what the person did through it, the
// pull requests that followed, and the profile as it was updated. Not its own housekeeping: the sessions it read and
// the state files it cleared are how it works, not something done for the person (the owner, 2026-11-21).
// `report`: the kept report's session rows and input rate, given by tests ({ rows, rate }); read from the file otherwise.
export function upkeepFeed(store, { now = Date.now(), days = UPKEEP.feedDays, log, report } = {}) {
  const since = now - days * DAY, out = [];
  const line = (x, impact) => ({ ...x, ...(impact ? { impact, impactSaid: impactSaid(impact) } : {}) });
  const done = readUpkeep(store).done;
  for (const d of done) {
    if (Date.parse(d.at) < since || d.kept) continue;
    out.push(line({ id: `d:${d.id}`, at: d.at, kind: 'did', ...(d.chore === 'sweep' ? { steer: 'sweep' } : d.chore === 'follow' ? { steer: 'changes' } : {}), text: d.said, by: d.by, ...(d.url ? { url: d.url } : {}), ...(d.undo && !d.undoneAt ? { undo: d.id } : {}), ...(d.undoneAt ? { undone: true } : {}) }, d.undoneAt ? null : d.impact));
  }
  let history = []; try { history = changeHistory(store, { now }); } catch {}
  if (history.length) {
    // each decision with its measured effect, from the report kept here (a file read; nothing is measured now), and
    // this repository's pace: the prompts a day over the last week
    let rows = [], rate = null; try { ({ rows, rate } = report || { rows: keptRows(store, { now }).rows, rate: inputRateHere(store, { now }) }); history = withEffects(history, rows, now); } catch {}
    const perDay = rows.filter(r => r.t >= now - 7 * DAY).reduce((a, r) => a + Math.max(1, r.prompts || 0), 0) / 7;
    const groups = new Set(), batches = new Set();
    for (const e of history) {
      if (e.decision === 'dismissed') continue;
      // a batch of thinker's own is one line, whatever it holds (the owner's answer, 2026-11-21)
      if (e.batch) {
        if (batches.has(e.batch)) continue; batches.add(e.batch);
        const l = batchLine(history.filter(h => h.batch === e.batch && h.decision !== 'dismissed'), { rate, perDay, by: done.find(d => d.id === e.batch)?.by || 'thinker' });
        if (Date.parse(l.at) >= since) out.push(line(l.x, l.impact));
        continue;
      }
      // several sections changed together are one job and one pull request: one line, their savings added
      const g = e.group && (e.job || e.pr) ? e.group : null;
      if (g) { if (groups.has(g)) continue; groups.add(g); }
      // one line: a long section title is cut, the rest of it is under Recent activity's Action savings
      const of = g ? history.filter(h => h.group === g) : [e], what = of.length > 1 ? `${short(e.title, 60)} and ${plural(of.length - 1, 'more section')}` : short(e.title, 80);
      const at = e.pr?.at || e.job?.finishedAt || e.at;
      if (Date.parse(at) < since) continue;
      const waiting = e.running || e.pr?.state === 'open', nothing = e.failed || e.revertedAt || e.pr?.state === 'closed';
      const measured = !waiting && of.every(h => h.effect), perPrompt = nothing ? 0 : of.reduce((a, h) => a + (measured ? h.effect.delta : h.saving || 0), 0);
      const impact = perPrompt ? { perPrompt, perDay: rate != null && perDay ? perPrompt * perDay * rate : null, promptsPerDay: perDay, measured, ...(waiting ? { pending: true } : {}) } : null;
      const mine = done.find(d => d.kept && d.by === 'thinker' && d.item === `change:${e.key || (e.keys || [])[0]}`);
      // `shared`: a decision for the whole machine is in every repository's history, and is one line when they are read together
      // a pull request's line always carries its link (`url`): it may be in review for days, and the line is how the
      // person gets to it. `undo`: what the chat names to take the decision back (upkeepUndo).
      out.push(line({ id: `h:${e.id}`, at, kind: e.pr ? 'pr' : 'change', ...(e.kind === 'section' ? { steer: 'prs' } : e.kind === 'tool' || e.kind === 'skill' ? { steer: 'tools' } : {}), text: didSaid(e, what), by: mine ? 'thinker' : 'you', ...(e.pr?.url ? { url: e.pr.url } : {}), ...(e.pr ? { pr: { number: e.pr.number, state: e.pr.state } } : {}), ...(e.revertedAt ? { undone: true } : e.revertible ? { undo: `h:${e.id}` } : {}), ...(e.scope === 'machine' ? { shared: e.id } : {}) }, impact));
    }
  }
  // the profile as it was last updated: one line, the newest, since a line a day would crowd out what was done
  let last = null;
  for (const e of log || readLog(store)) {
    if (e.op !== 'profile-compile' || !e.changes || !e.t || Date.parse(e.t) < since) continue;
    const c = e.changes, n = (c.added || 0) + (c.updated || 0) + (c.dropped || 0);
    if (n && (!last || e.t > last.at)) last = { id: 'profile', at: e.t, kind: 'profile', by: 'thinker', profile: { added: c.added || 0, reworded: c.updated || 0, dropped: c.dropped || 0 } };
  }
  if (last) out.push({ ...last, text: profileSaid(last.profile) });
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, UPKEEP.feedMax);
}

// --- what was handed to cheaper agents -----------------------------------------------------------------------
// Per session: how much of its reading and test running went to a cheaper agent, and what that saved (the owner's
// ask, 2026-11-21). The figures are the Report's own (report-savings.js:delegationBySession over the "Reads
// delegated" series), read from the log and the proxy's records as the savings ledger reads them: nothing is
// measured here. Kept a minute a repository in this process, since the page asks every half minute.
const handedCache = new Map();
const cutTitle = t => short(String(t || '').replace(/<[^>]{1,40}>[\s\S]*?<\/[^>]{1,40}>/g, ' '), 70);
export function delegatedSaid(d) {
  const what = [d.reads ? plural(d.reads, 'read') : '', d.runs ? plural(d.runs, 'test run') : ''].filter(Boolean).join(' and ');
  const worth = [d.handed ? `${formatTokens(d.handed)} tokens handed over` : '', d.saved == null || Math.abs(d.saved) < 0.005 ? '' : d.saved > 0 ? `${formatDollars(d.saved)} saved` : `cost ${formatDollars(-d.saved)} more`].filter(Boolean).join(' · ');
  return { text: `Handed ${what} to ${d.models?.length === 1 ? d.models[0] : 'cheaper agents'}`, impactSaid: worth };
}
// the dollars are over the sessions that can be priced; one whose lead model is not known to the log, or has no list
// price, is counted (`unpriced`) and left out of them, never added at zero
const handedTotal = sessions => ({ sessions: sessions.length, reads: sessions.reduce((a, d) => a + d.reads, 0), runs: sessions.reduce((a, d) => a + d.runs, 0), handed: sessions.reduce((a, d) => a + d.handed, 0), saved: sessions.reduce((a, d) => a + (d.saved || 0), 0), unpriced: sessions.filter(d => d.saved == null).length });
export function upkeepDelegated(store, { now = Date.now(), days = UPKEEP.feedDays, log, compression, home = thinkerHome() } = {}) {
  const key = `${store.repo}\t${home}`, had = handedCache.get(key);
  if (!log && !compression && had && now - had.at >= 0 && now - had.at < 60_000) return had.value;
  let sessions = [];
  try {
    const events = log || readLog(store);
    // the proxy's rows and the recorded clears, as the ledger reads them (savings-ledger.js:computeSavings); a test
    // with no home and no log of its own has none
    const rows = compression || (process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME && !process.env.THINKER_PROXY_LOG ? [] : clearingRows(proxyLogFile(home), compressionDir(home), { events, key: sessionKey }));
    let config = {}; try { config = store.config(); } catch {}
    sessions = delegationBySession({ events, compression: rows, config, since: now - days * DAY }).map(d => ({ id: `s:${d.session}`, at: new Date(d.at).toISOString(), title: cutTitle(d.title), reads: d.reads, runs: d.runs, handed: d.handed, models: d.models, saved: d.saved, steer: 'delegation', ...delegatedSaid(d) }));
  } catch {}
  const value = { days, total: handedTotal(sessions), sessions: sessions.slice(0, UPKEEP.sessionsMax) };
  if (!log && !compression) handedCache.set(key, { at: now, value });
  return value;
}

// --- what is known about one line ----------------------------------------------------------------------------
// Everything thinker can say about one line of the activity, as plain facts, for somebody asking about it in the chat
// (the owner, 2026-11-21, of an answer that had only the line to go on: "the answers should be more meaningful").
// `id` is the line's own (`h:` a decision, `d:` something done here, `s:` a session's delegated work, `profile`).
// What the thing was, why it was picked, how it was done and by whom, what it measured as and over how many sessions,
// how the dollars are reckoned, where its pull request is, and whether it can be taken back. Read from what is kept;
// nothing is measured here.
const dateSaid = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const DOORS = { page: 'by the person, on the page', session: 'by the person, answering the weekly question in a session', command: 'by the person, from the command line', setup: 'by the person, while installing' };
// one decision as facts: what it was, its size, why it was picked, what it measured as
function decisionFacts(h) {
  const out = [`${h.title}${h.what ? ` (${String(h.what).toLowerCase()})` : ''}${h.about ? `. It begins: "${short(h.about, 240)}"` : ''}`];
  if (h.tokens?.before != null) out.push(`  Its size: ${formatTokens(h.tokens.before)} tokens before the change, ${formatTokens(h.tokens.after || 0)} after. It is read again by every model call of every session that loads the file.`);
  if (h.saving) out.push(`  Why it was picked: about ${formatTokens(h.saving)} of its tokens in an average prompt were going where they were not needed${h.total && h.days ? `, ${formatTokens(h.total)} tokens over the ${h.days} days before` : ''}.`);
  const fx = h.effect;
  if (fx) out.push(`  Measured: it cost ${formatTokens(fx.before.perPrompt)} tokens a prompt before (${plural(fx.before.sessions, 'session')}, ${fx.before.prompts} prompts) and ${formatTokens(fx.after.perPrompt)} since (${plural(fx.after.sessions, 'session')}, ${fx.after.prompts} prompts): ${formatTokens(Math.abs(fx.delta))} ${fx.delta >= 0 ? 'fewer' : 'more'} a prompt${fx.share != null ? `, ${Math.round(1000 * Math.abs(fx.share)) / 10}% of what a whole prompt cost before` : ''}${fx.since?.prompts ? `; ${formatTokens(Math.abs(fx.window))} tokens ${fx.window >= 0 ? 'saved' : 'more'} over the ${fx.since.prompts} prompts since` : ''}${fx.few ? '. Under five sessions on one side, so the figure is early' : ''}.`);
  else out.push(`  Not measured yet: ${h.pr?.state === 'open' || h.job?.state === 'running' ? 'it is not in effect until its pull request merges' : 'it needs sessions on both sides of the change'}. The figure given is what was expected when it was picked.`);
  return out;
}
const prFact = pr => `Its pull request: #${pr.number}, ${pr.state === 'open' ? 'in review' : pr.state}${pr.at ? ` since ${dateSaid(pr.at)}` : ''}${pr.url ? `, ${pr.url}` : ''}.${pr.state === 'open' ? ' It is the team\'s to review and merge; the change is not in effect until then.' : ''}`;
export function upkeepDetail(store, id, { now = Date.now(), log, report, compression, home = thinkerHome() } = {}) {
  const out = [];
  id = String(id || '');
  if (id.startsWith('h:') || id.startsWith('b:')) {
    let history = []; try { history = changeHistory(store, { now }); } catch {}
    let rows = [], rate = null; try { ({ rows, rate } = report || { rows: keptRows(store, { now }).rows, rate: inputRateHere(store, { now }) }); history = withEffects(history, rows, now); } catch {}
    const perDay = rows.filter(r => r.t >= now - 7 * DAY).reduce((a, r) => a + Math.max(1, r.prompts || 0), 0) / 7;
    const dollars = rate != null && perDay ? `How the dollars a day are reckoned: the tokens off a prompt, times the ${Math.round(perDay)} prompts a day this repository ran over the last week, at $${(rate * 1e6).toFixed(2)} a million input tokens (what input cost here, cache reads and writes as they were).` : '';
    if (id.startsWith('b:')) {
      // a batch: why these went together, then each change in it with its own undo
      const of = history.filter(h => h.batch === id.slice(2) && h.decision !== 'dismissed');
      if (!of.length) return out;
      const kept = readUpkeep(store), rec = kept.done.find(d => d.id === id.slice(2)), followed = kept.followed, b = behaviorOf(store, { home }), secs = of.filter(h => h.kind === 'section');
      out.push(`A batch of ${plural(of.length, 'change')} made together on ${dateSaid(of.at(-1).at)}, ${rec?.by === 'you' ? 'on the person\'s word in the chat' : 'by thinker itself at one of its checks'}.${rec?.batch?.perDay ? ` Together they were wasting about ${formatDollars(rec.batch.perDay)} a day.` : ''}`);
      out.push(`Why a batch: thinker makes a change only when it saves ${formatDollars(b.minPerDay)} a day or more by itself, and sends the ones that do together once they come to ${formatDollars(b.batchPerDay)} a day between them, at most every ${plural(b.batchEveryDays, 'day')}. Each of those is a setting the person can change by saying so.`);
      for (const h of of) {
        out.push(...decisionFacts(h));
        const f = followed[h.id];
        if (f && f.verdict !== 'retry') out.push(`  Checked on ${dateSaid(f.at)}: ${f.verdict === 'undone' ? 'taken back, because ' : f.verdict === 'held' ? 'it should be taken back, and thinker could not do it, because ' : 'kept: '}${f.why}.`);
        out.push(`  ${h.revertedAt ? 'It was taken back.' : h.revertible ? `It can be taken back by itself (undo id h:${h.id})${h.kind === 'section' && secs.length > 1 ? ', which takes the rest of the pull request back with it' : ''}.` : 'It cannot be taken back from here.'}`);
      }
      const pr = secs.find(h => h.pr)?.pr;
      if (pr) out.push(prFact(pr));
      if (dollars) out.push(dollars);
      if (b.followUp && of.some(h => !followed[h.id] && !h.revertedAt)) out.push(`Each change is checked ${plural(b.followUpDays, 'day')} after it takes effect (a section when its pull request merges), and taken back if it did not pay.`);
      out.push(of.every(h => h.revertedAt) ? 'The whole batch was taken back.' : of.some(h => h.revertible) ? `The whole batch can be taken back at once (undo id ${id}).` : 'It cannot be taken back from here.');
      return out;
    }
    const e = history.find(h => h.id === id.slice(2));
    if (!e) return out;
    const done = readUpkeep(store).done.find(d => d.kept && d.item === `change:${e.key || (e.keys || [])[0]}`);
    for (const h of e.group && (e.job || e.pr) ? history.filter(x => x.group === e.group) : [e]) out.push(...decisionFacts(h));
    out.push(`How it was done: ${e.action ? `${e.action.toLowerCase()}, ` : ''}${e.decision}, on ${dateSaid(e.at)}, ${e.via === VIA.thinker ? (done?.by === 'thinker' || e.batch ? 'by thinker itself at one of its checks' : 'by thinker, on the person\'s word in the chat') : DOORS[e.via] || 'by the person'}${e.result ? `. ${e.result}` : ''}.`);
    if (e.pr) out.push(prFact(e.pr));
    if (dollars) out.push(dollars);
    out.push(e.revertedAt ? 'It was taken back.' : e.revertible ? `It can be taken back (undo id h:${e.id}).` : 'It cannot be taken back from here.');
  } else if (id.startsWith('d:')) {
    const d = readUpkeep(store).done.find(x => x.id === id.slice(2));
    if (!d) return out;
    out.push(`${d.said}, on ${dateSaid(d.at)}, ${d.by === 'thinker' ? 'by thinker itself at one of its checks' : 'on the person\'s word in the chat'}.`);
    for (const w of d.undo?.worktrees || []) out.push(`  A worktree: ${path.basename(w.path)}, on the branch ${w.branch}.`);
    const bare = (d.undo?.branches || []).filter(b => !(d.undo.worktrees || []).some(w => w.branch === b.name));
    if (bare.length) out.push(`  Branches with no worktree: ${bare.map(b => b.name).slice(0, 20).join(', ')}.`);
    if (d.chore === 'sweep') out.push('Why: each one\'s work was already on the default branch, by its history or by a merged pull request with that exact commit, it had no uncommitted or untracked files, nobody was working in it, and it had not changed in a day.');
    if (d.impact?.kb) out.push(`What it freed: ${size(d.impact.kb)} of disk.`);
    out.push(d.undoneAt ? 'It was put back, and those are never removed again.' : d.undo ? `It can be put back: each branch at its commit, and the worktrees on them (undo id ${d.id}).` : 'It cannot be taken back from here.');
  } else if (id.startsWith('s:')) {
    let d = null;
    try {
      const events = log || readLog(store);
      const rows = compression || (process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME && !process.env.THINKER_PROXY_LOG ? [] : clearingRows(proxyLogFile(home), compressionDir(home), { events, key: sessionKey }));
      let config = {}; try { config = store.config(); } catch {}
      d = delegationDetail({ events, compression: rows, config, session: id.slice(2) });
    } catch {}
    if (!d?.handoffs.length) return out;
    if (d.title) out.push(`The session began: "${cutTitle(d.title)}"${d.lead ? `. Its own model was ${d.lead}` : ''}.`);
    for (const h of d.handoffs.slice(0, 12)) out.push(`  A ${h.kind} handed over on ${dateSaid(h.at)}: ${h.files.map(f => String(f).split('/').slice(-2).join('/')).join(', ') || 'unnamed'}${h.tokens ? `, ${formatTokens(h.tokens)} tokens` : ''}${h.to ? `, to ${h.to}` : ''}.`);
    if (d.handoffs.length > 12) out.push(`  And ${d.handoffs.length - 12} more.`);
    if (d.ignored) out.push(`${plural(d.ignored, 'more handoff')} the lead went on to read itself anyway: nothing was kept out by ${d.ignored === 1 ? 'that one' : 'those'}, so ${d.ignored === 1 ? 'it is' : 'they are'} counted nowhere.`);
    out.push('Why it is handed over: a large read is only needed for what it says, so a cheaper agent reads the file and reports back, and the lead works from the report. The file never enters the lead\'s context.');
    out.push(d.saved == null ? 'The saving in dollars is not known: no price is known for the session\'s own model.' : Math.abs(d.saved) < 0.005 ? 'No saving is counted: a test run handed over carries none, only reads do.' : `The saving, ${formatDollars(d.saved)}: the lead did not write those tokens into its cache at its own rate, less what the cheaper agent paid for the same reading, and did not read them back on its later calls (${formatTokens(d.tokens)} tokens not paid for in all). It is an estimate, the same one the Report's "Reads delegated" shows.`);
  } else if (id === 'profile') {
    let prof = null; try { prof = readProfile(store); } catch {}
    const lines = sec => (prof?.sections?.[sec] || []).filter(e => !e.retired).map(e => e.text).filter(Boolean);
    const how = lines('howWeWork'), work = lines('workingOn');
    if (!how.length && !work.length) return out;
    out.push('The profile is what thinker has learned from the person\'s own prompts and reactions in this repository; every new session is shown it at its start.');
    if (how.length) out.push(`How this person works, as it stands now (${how.length}): ${how.slice(0, 10).map(t => `"${short(t, 140)}"`).join('; ')}${how.length > 10 ? '; and more' : ''}.`);
    if (work.length) out.push(`What they are working on: ${work.slice(0, 4).map(t => `"${short(t, 140)}"`).join('; ')}.`);
  }
  return out;
}

// --- what both doors read ------------------------------------------------------------------------------------
// One line on how things stand.
export function summary({ level, lastCheck, later, held, batch }) {
  if (level === 'off') return 'Thinker is not looking after this repository.';
  if (!lastCheck) return 'Thinker has not looked here yet.';
  // the changes of the next batch are said as the batch they will be; anything else waiting, by its count
  const inBatch = batch?.changes && (batch.ok || batch.later) ? batch.changes : 0, other = Math.max(0, (later || 0) - inBatch);
  const said = [inBatch ? `${plural(inBatch, 'change')} worth ${formatDollars(batch.perDay)} a day ${batch.ok ? 'going out in the next batch' : 'waiting for the next batch'}` : '', other ? `${inBatch ? `${other} more` : plural(other, 'change')} waiting ${other === 1 ? 'its' : 'their'} turn` : '', held ? `${held} held back until you say` : ''].filter(Boolean);
  return said.length ? `${said.join(', ')}.` : 'Up to date.';
}
// `pending` and `notes` are for the chat (chat.js:chatContext); the page and the command show the feed and the count.
export function upkeepView(store, { now = Date.now(), log, report, compression, home = thinkerHome() } = {}) {
  const b = behaviorOf(store, { home }), on = b.level !== 'off';
  const p = on ? upkeepPending(store, { now, home }) : { lastCheck: readUpkeep(store).lastCheck, pending: [], notes: [] };
  const { set, ...behavior } = b;
  const v = { level: b.level, behavior, behaviorSaid: behaviorSaid(b), lastCheck: p.lastCheck, later: p.pending.filter(i => i.later).length, held: p.pending.filter(i => !i.later).length, pending: p.pending, notes: p.notes, ...(p.batch ? { batch: p.batch } : {}), feed: upkeepFeed(store, { now, log, report }), delegated: upkeepDelegated(store, { now, log, compression, home }) };
  return { ...v, summary: summary(v) };
}
// Every repository's view as one (the page's All repositories): each line says whose it is, and the last check is
// the oldest one, since that is how stale the list can be.
// What one thing came to in two repositories, as one figure: the dollars a day added, the tokens a prompt the average
// over their prompts. What still waits on a pull request (`wait`, `pending`) is the first one's.
const bothImpacts = (a, b) => {
  const n = (a.promptsPerDay || 0) + (b.promptsPerDay || 0);
  return { ...a, perPrompt: n ? (a.perPrompt * (a.promptsPerDay || 0) + b.perPrompt * (b.promptsPerDay || 0)) / n : a.perPrompt, perDay: a.perDay == null && b.perDay == null ? null : (a.perDay || 0) + (b.perDay || 0), promptsPerDay: n, measured: Boolean(a.measured && b.measured) };
};
export function mergeUpkeepViews(pairs) {
  const pending = [], notes = [], feed = [], checks = [], profiles = [], sessions = [], totals = [], shared = new Map(), said = new Map(), batches = new Map(), waiting = [];
  for (const { repo, name, view } of pairs) {
    if (!view) continue;
    if (view.delegated) { sessions.push(...view.delegated.sessions.map(d => ({ ...d, repo, repoName: name }))); totals.push(view.delegated.total); }
    for (const i of view.pending || []) {
      // a tool is switched for the whole machine, so the same tool found in three repositories is one thing: the
      // costliest of them, and doing it from any one of them does it for all (context-suggest.js)
      if (i.machine) { const g = shared.get(i.id) || { n: 0, top: null, perDay: 0 }; g.n++; g.perDay += i.perDay || 0; if (!g.top || (i.rank || 0) > (g.top.rank || 0)) g.top = { ...i, repo, repoName: name }; shared.set(i.id, g); }
      else pending.push({ ...i, repo, repoName: name });
    }
    notes.push(...(view.notes || []).map(i => ({ ...i, repo, repoName: name })));
    for (const f of view.feed) {
      // the profiles of several repositories are one line, the newest update's time and their changes added
      if (f.kind === 'profile' && f.profile) { profiles.push({ ...f, repo, repoName: name }); continue; }
      // a batch whose tools were switched for the whole machine is in every repository's history: one line, the one
      // of the repository it was made in (it has the pull request), with what the tools save in the others added
      if (f.batch && String(f.id).startsWith('b:')) { const g = batches.get(f.id) || []; g.push({ ...f, repo, repoName: name }); batches.set(f.id, g); continue; }
      if (!f.shared) { feed.push({ ...f, repo, repoName: name }); continue; }
      // a decision for the whole machine: one line, what it saves a day added over the repositories, and the tokens a
      // prompt the average over their prompts
      const had = said.get(f.shared);
      if (!had) { const x = { ...f, repo, repoName: 'All repositories' }; said.set(f.shared, x); feed.push(x); continue; }
      if (!f.impact || !had.impact) { if (f.impact && !had.impact) Object.assign(had, { impact: f.impact, impactSaid: f.impactSaid }); continue; }
      had.impact = bothImpacts(had.impact, f.impact);
      had.impactSaid = impactSaid(had.impact);
    }
    if (view.batch?.changes) waiting.push(view.batch);
    if (view.level !== 'off') checks.push(view.lastCheck);
  }
  for (const g of batches.values()) {
    const [base, ...rest] = g.sort((a, b) => (b.batch.changes || 0) - (a.batch.changes || 0));
    for (const o of rest) { if (o.impact) base.impact = base.impact ? bothImpacts(base.impact, o.impact) : o.impact; }
    if (base.impact) base.impactSaid = impactSaid(base.impact);
    feed.push(base);
  }
  for (const g of shared.values()) pending.push(g.n > 1 ? { ...g.top, repoName: `${g.n} repositories`, ...(g.top.perDay != null ? { perDay: g.perDay } : {}) } : g.top);
  pending.sort(byOrder);
  if (profiles.length === 1) feed.push(profiles[0]);
  else if (profiles.length) { const sum = k => profiles.reduce((a, f) => a + f.profile[k], 0), p = { added: sum('added'), reworded: sum('reworded'), dropped: sum('dropped') }; feed.push({ at: profiles.map(f => f.at).sort().at(-1), kind: 'profile', by: 'thinker', profile: p, text: profileSaid(p, ` in ${profiles.length} repositories`), repoName: '' }); }
  feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const on = pairs.filter(p => p.view && p.view.level !== 'off'), levels = [...new Set(on.map(p => p.view.level))];
  const level = !on.length ? 'off' : levels.length === 1 ? levels[0] : 'mixed', lastCheck = checks.length && checks.every(Boolean) ? checks.sort()[0] : null;
  const first = on[0]?.view;
  // what waits for a batch over every repository: each change once (a tool is the machine's), and what they waste a day
  const going = pending.filter(i => i.chore === 'context' && i.action && i.later);
  const batch = going.length ? { changes: going.length, perDay: going.reduce((a, i) => a + (i.perDay || 0), 0), ok: waiting.some(w => w.ok), later: true } : null;
  const v = { level, ...(batch ? { batch } : {}), behavior: first?.behavior || null, behaviorSaid: level === 'mixed' ? 'Thinker behaves differently from one repository to the next here.' : first?.behaviorSaid || behaviorSaid({ level: 'off' }), lastCheck, later: pending.filter(i => i.later).length, held: pending.filter(i => !i.later).length, pending, notes, feed: feed.slice(0, UPKEEP.feedMax),
    // the sessions of every repository newest first, and their totals added
    delegated: { days: UPKEEP.feedDays, total: Object.fromEntries(['sessions', 'reads', 'runs', 'handed', 'saved', 'unpriced'].map(k => [k, totals.reduce((a, t) => a + (t[k] || 0), 0)])), sessions: sessions.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, UPKEEP.sessionsMax) } };
  return { ...v, summary: summary(v) };
}
// The window's delegated work in one line, for both doors.
export function delegatedTotalSaid(d) {
  const t = d?.total;
  if (!t?.sessions) return '';
  return `${plural(t.sessions, 'session')} over ${plural(d.days, 'day')}: ${[t.reads ? plural(t.reads, 'read') : '', t.runs ? plural(t.runs, 'test run') : ''].filter(Boolean).join(' and ')} handed to cheaper agents${t.handed ? `, ${formatTokens(t.handed)} tokens` : ''}${Math.abs(t.saved || 0) < 0.005 ? '' : t.saved > 0 ? ` · ${formatDollars(t.saved)} saved` : ` · cost ${formatDollars(-t.saved)} more`}${t.unpriced ? ` (${plural(t.unpriced, 'session')} left out: no price known for ${t.unpriced === 1 ? 'its' : 'their'} model)` : ''}`;
}

// --- the command's page --------------------------------------------------------------------------------------
export const ago = (t, now = Date.now()) => { if (!t) return 'never'; const m = Math.max(0, Math.round((now - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const when = (t, now) => { const d = new Date(t), today = dayKey(now) === dayKey(t), time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return today ? `today ${time}` : dayKey(now - DAY) === dayKey(t) ? `yesterday ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`; };
export function renderUpkeep(v, { now = Date.now(), feed = 12 } = {}) {
  const out = [`Recent activity · thinker last looked ${ago(v.lastCheck, now)}`, `  ${v.summary} ${v.behaviorSaid}`, ''];
  if (!v.feed.length) out.push('  Nothing yet. What thinker does for you is listed here with what it saved.');
  // a line an action: what was done, what it came to, and for a pull request where to read it
  for (const f of v.feed.slice(0, feed)) out.push(`  ${when(f.at, now).padEnd(15)}  ${f.text}${f.impactSaid ? `  ${f.impactSaid}` : ''}${f.by === 'thinker' && (f.kind === 'did' || f.kind === 'pr' || f.kind === 'change') ? ' (on its own)' : ''}${f.undone ? ' (taken back)' : ''}${f.url ? `  ${f.url}` : ''}${f.repoName ? ` · ${f.repoName}` : ''}`);
  if (v.feed.length > feed) out.push(`  and ${v.feed.length - feed} more (--all)`);
  // a line a session: what it handed to cheaper agents and what that saved
  if (v.delegated?.total.sessions) {
    out.push('', `Delegated to cheaper agents · ${delegatedTotalSaid(v.delegated)}`);
    const shown = v.delegated.sessions.slice(0, feed);
    for (const d of shown) out.push(`  ${when(d.at, now).padEnd(15)}  ${d.text}${d.impactSaid ? `  ${d.impactSaid}` : ''}${d.title ? `  “${d.title}”` : ''}${d.repoName ? ` · ${d.repoName}` : ''}`);
    if (v.delegated.total.sessions > shown.length) out.push(`  and ${v.delegated.total.sessions - shown.length} more sessions`);
  }
  return out;
}
