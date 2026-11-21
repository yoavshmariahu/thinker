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
//   context   the context changes `thinker context` ranks highest (context-suggest.js:currentChanges): a section of an
//             instruction file nobody needs becomes a pull request, a tool nobody calls is switched off or made a
//             reference. One computation with the command: the decision is kept in the same history, by the door `thinker`.
//   rules     a section of the instruction file that sessions keep breaking, from the verdicts on real sessions
//             (instruction-value.js). Something worth knowing, which thinker says when it is asked: what to do about a
//             rule nobody follows is the person's.
//   waiting   a change of its own that failed, tried again
//
// How it behaves (BEHAVIOR; the owner's rule, 2026-11-21: "take actions on its own and put up PRs as needed, but
// only for important things and not too frequently"):
//   - It acts by itself (`level: 'auto'`). `ask` has it wait for the person's word in the chat; `off` stops the checks.
//   - Only on what is important: a part the Context report flags high waste (5% of its kind's cost or more spent
//     where it was not needed), a sweep of three things or 500 MB. What is not important stays in `thinker context`.
//   - Not often: one pull request a repository a week and never while one is open, one a day over the whole
//     machine; one tool a day over the machine; one sweep a repository a day. What has to wait its turn is done at
//     a later check.
//   - A pull request is the only way it changes a repository's files, and it is the team's to review: the line about
//     it carries its link while it is in review and after. A section is never rewritten in the working tree.
// The settings are `upkeep: { … }` in <THINKER_HOME>/config.json for the machine and in .thinker/config.json for
// one repository (which wins); `upkeep: false` is `level: off`. The chat writes them (setBehavior).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findMess, sweep, unsweep, SWEEP } from './upkeep-sweep.js';
import { currentChanges, decidedKeys, allChanges, pickChanges, approveChanges, dismissChanges, changeHistory, retryJob, revertDecision, VIA, SUGGEST } from './context-suggest.js';
import { lastSnapshot } from './context-snapshot.js';
import { rateOf } from './context-view.js';
import { prAvailable } from './instruction-pr.js';
import { instructionFiles, sections, sectionId, readValueState } from './instruction-value.js';
import { readMachineConfig, updateMachineConfig } from './repo-switch.js';
import { keptRows, inputRateHere } from './report-snapshot.js';
import { withEffects } from './report.js';
import { delegationBySession, delegationDetail } from './report-savings.js';
import { readProfile } from './profile.js';
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
};
const DAY = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = kb => !kb ? '' : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// --- how it behaves ------------------------------------------------------------------------------------------
// Each setting with what it may be, and the words the chat and the command say it in.
export const BEHAVIOR = {
  level: 'auto', sweep: true, prs: true, tools: true,
  important: 'high', prEveryDays: 7, prsPerDay: 1, toolEveryDays: 1, sweepEveryDays: 1, sweepMin: 3, sweepMinMb: 500,
};
const num = (min, max) => v => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined; };
const bool = v => v === true || /^(true|on|yes)$/i.test(String(v)) ? true : v === false || /^(false|off|no)$/i.test(String(v)) ? false : undefined;
const oneOf = (...xs) => v => xs.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : undefined;
export const SETTINGS = {
  level: { read: oneOf('auto', 'ask', 'off'), about: 'auto: do what is important by itself; ask: do nothing until told to in the chat; off: stop looking' },
  sweep: { read: bool, about: 'whether it may remove merged worktrees and branches by itself' },
  prs: { read: bool, about: 'whether it may put up a pull request by itself' },
  tools: { read: bool, about: 'whether it may switch off or reference an unused tool by itself' },
  important: { read: oneOf('high', 'medium'), about: 'how costly a thing must be to act on: high (5% of its kind\'s cost wasted) or medium (2%)' },
  prEveryDays: { read: num(1, 90), about: 'days between pull requests in one repository' },
  prsPerDay: { read: num(1, 20), about: 'pull requests a day over the whole machine' },
  toolEveryDays: { read: num(1, 90), about: 'days between tools switched, over the whole machine' },
  sweepEveryDays: { read: num(1, 90), about: 'days between sweeps in one repository' },
  sweepMin: { read: num(1, 100), about: 'how many merged worktrees and branches make a sweep worth doing by itself' },
  sweepMinMb: { read: num(1, 100_000), about: 'or how many megabytes they hold' },
};
const settingsOf = c => {
  if (c === false) return { level: 'off' };
  const out = {};
  if (c && typeof c === 'object') for (const [k, s] of Object.entries(SETTINGS)) { if (k in c) { const v = s.read(c[k]); if (v !== undefined) out[k] = v; } }
  return out;
};
// The behaviour in force in a repository: the defaults, the machine's settings over them, the repository's over those.
export function behaviorOf(store, { home = thinkerHome() } = {}) {
  const machine = settingsOf(readMachineConfig(home).upkeep), repo = settingsOf(store?.config().upkeep);
  return { ...BEHAVIOR, ...machine, ...repo, set: { machine, repo } };
}
// One setting changed, for the machine or for one repository. Returns what it is now, in words, or what was wrong.
export function setBehavior(store, key, value, { scope = 'machine', home = thinkerHome() } = {}) {
  const s = SETTINGS[key];
  if (!s) return { error: `there is no setting called ${key}` };
  const v = s.read(value);
  if (v === undefined) return { error: `${key} cannot be ${JSON.stringify(value)} (${s.about})` };
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
// that"): how readily thinker does one kind of thing, moved one step. A step halves or doubles how often -- the days
// between pull requests or tools, the size a sweep must be -- so two words from the person are a definite change they
// are told the size of, and never a number the model picked. `delegation` is the delegation trigger's own setting
// (delegate.js: the size a read must be to be handed to a cheaper agent), which is the machine's alone.
export const STEER = { kinds: ['prs', 'tools', 'sweep', 'delegation'], delegation: { min: 2000, max: 64_000 } };
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
  if (!b[kind]) { if (!more) return { error: `thinker already does none of that ${where}` }; const r = set(kind, true); return r.error ? r : { said: `thinker does that again ${where}` }; }
  if (kind === 'sweep') {
    const n = more ? half(b.sweepMin, 1) : twice(b.sweepMin, 100), mb = more ? half(b.sweepMinMb, 50) : twice(b.sweepMinMb, 100_000);
    if (n === b.sweepMin && mb === b.sweepMinMb) return { error: `a sweep is already ${more ? 'as ready' : 'as rare'} as thinker will go` };
    const r = [set('sweepMin', n), set('sweepMinMb', mb)].find(x => x.error);
    return r || { said: `merged worktrees and branches are now removed from ${plural(n, 'thing')} or ${mb} MB ${where} (it was ${b.sweepMin} or ${b.sweepMinMb} MB)` };
  }
  const key = kind === 'prs' ? 'prEveryDays' : 'toolEveryDays', what = kind === 'prs' ? 'a pull request' : 'a tool';
  const next = more ? half(b[key], 1) : twice(b[key], 90);
  if (next === b[key]) return { error: `${what} is already ${more ? 'as often' : 'as seldom'} as thinker will go (every ${plural(b[key], 'day')})` };
  const r = set(key, next);
  return r.error ? r : { said: `${what} at most every ${plural(next, 'day')} now ${where} (it was every ${b[key]})` };
}
// The behaviour in a sentence or two, for the page, the command and the chat.
export function behaviorSaid(b) {
  if (b.level === 'off') return 'Thinker is not looking after this repository (upkeep is off).';
  if (b.level === 'ask') return 'Thinker does nothing here until you tell it to.';
  const does = [b.sweep ? 'removes merged worktrees and branches' : '', b.prs ? `puts up a pull request for a costly section nobody needs, at most one every ${plural(b.prEveryDays, 'day')}` : '', b.tools ? 'switches off costly tools nobody calls' : ''].filter(Boolean);
  return does.length ? `Thinker acts on its own here, for important things only: it ${does.join(', ')}.` : 'Thinker may act on its own here, but every kind of action is switched off.';
}

// --- what it remembers ---------------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'upkeep.json');
export function readUpkeep(store) {
  try { const j = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); return { lastCheck: j.lastCheck || null, items: j.items || [], seen: j.seen || {}, dismissed: j.dismissed || {}, done: j.done || [], kept: j.kept || null }; }
  catch { return { lastCheck: null, items: [], seen: {}, dismissed: {}, done: [], kept: null }; }
}
function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(v) + '\n');
  fs.renameSync(tmp, f);
}
function writeUpkeep(store, st) { st.done = (st.done || []).slice(-UPKEEP.keepDone); writeJson(stateFile(store), st); }
// what thinker did by itself over every repository, by kind (`prs`, `tools`), for the machine's daily limits
const machineFile = home => path.join(home, 'state', 'upkeep.json');
const machineState = home => { try { return JSON.parse(fs.readFileSync(machineFile(home), 'utf8')) || {}; } catch { return {}; } };
const machineTimes = (home, kind) => (machineState(home)[kind] || []).filter(t => Number.isFinite(Date.parse(t)));
function noteMachine(home, kind, now) { try { writeJson(machineFile(home), { ...machineState(home), [kind]: [...machineTimes(home, kind).filter(t => now - Date.parse(t) < 7 * DAY), new Date(now).toISOString()] }); } catch {} }

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
const contextChore = {
  id: 'context',
  find(store, opts) {
    const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store);
    if (!view) return []; // no report kept yet: the next check has one (learn.js keeps it after maintenance)
    const rate = rateOf(view), canPr = (opts.fns?.prAvailable || prAvailable)(store.repo).ok, level = opts.behavior.important;
    // a section is changed only as a pull request, which the team reviews: where none can be opened from here it is
    // not thinker's to change at all, by itself or on anybody's word
    return currentChanges(store, view, { now: opts.now }).filter(c => c.default && (c.kind !== 'section' || canPr)).map(c => {
      const sec = c.kind === 'section';
      const worth = !c.total ? '' : rate == null ? ` About ${formatTokens(c.total)} tokens went on it unused over the last ${c.days} days.` : ` About ${formatDollars(c.total * rate)} went on it unused over the last ${c.days} days.`;
      const label = !sec ? c.default.text : `Put up a PR to ${c.default.act === 'remove' ? 'remove' : 'shorten'} it`;
      // `rank`: what it is worth, so the costliest comes first; `machine`: a tool is switched for every repository at once
      return { id: `change:${c.key}`, chore: 'context', kind: sec ? 'pr' : 'do', allow: sec ? 'prs' : 'tools', important: c.waste === 'high' || (level === 'medium' && c.waste === 'medium'), rank: c.total || 0, ...(c.kind === 'tool' ? { machine: true } : {}), title: c.title, detail: `${c.why.charAt(0).toUpperCase()}${c.why.slice(1)}.${worth}`, action: { label }, data: { key: c.key } };
    });
  },
  // a change decided through any door since the check (the page, the session's question, the command) is no longer open
  still(store, item, ctx) { return ctx.decided.has(item.data?.key) ? null : item; },
  pick(store, item, opts) { const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store); return view ? pickChanges(allChanges(view), [item.data.key]) : []; },
  async act(store, item, opts) {
    const picked = this.pick(store, item, opts);
    if (!picked.length) return { error: 'that part is no longer in the report; it is looked for again at the next check' };
    // A section is changed only as a pull request: asked again now, since the check that found it may be hours old,
    // and never left to fall back on writing the file in the working tree (which is the person's own Apply, on Find
    // Savings).
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
    const picked = this.pick(store, item, opts);
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
// Whether thinker may do an item now, and if not, why (`why`), and whether it is only waiting its turn (`later`):
// the level, the setting for its kind, then how lately it did the same. What the person tells it to do in the chat
// is held to none of this.
export function mayAct(store, item, b, { now = Date.now(), home = thinkerHome(), prOpen = false } = {}) {
  if (!item.important || !item.action || !item.allow) return { ok: false };
  if (b.level !== 'auto') return { ok: false, why: 'you asked to be asked first' };
  if (!b[item.allow]) return { ok: false, why: `you told it not to (${item.allow} is off)` };
  const mine = readUpkeep(store).done.filter(d => d.by === 'thinker' && !d.undoneAt);
  const last = (chore, kind) => Math.max(0, ...mine.filter(d => d.chore === chore && (!kind || d.kind === kind)).map(d => Date.parse(d.at)));
  const wait = why => ({ ok: false, later: true, why });
  if (item.chore === 'waiting') return item.data.tries >= UPKEEP.retries ? { ok: false, why: `it failed ${item.data.tries} times` } : now - Date.parse(item.data.failedAt) < DAY ? wait('it is tried again a day after it failed') : { ok: true };
  if (item.allow === 'prs') {
    if (prOpen) return wait('a pull request is still open here');
    if (now - last('context', 'pr') < b.prEveryDays * DAY) return wait(`one pull request every ${plural(b.prEveryDays, 'day')} here`);
    if (machineTimes(home, 'prs').filter(t => now - Date.parse(t) < DAY).length >= b.prsPerDay) return wait(`${plural(b.prsPerDay, 'pull request')} a day over the machine`);
  }
  if (item.allow === 'tools' && machineTimes(home, 'tools').some(t => now - Date.parse(t) < b.toolEveryDays * DAY)) return wait(`one tool every ${plural(b.toolEveryDays, 'day')} over the machine`);
  if (item.allow === 'sweep' && now - last('sweep') < b.sweepEveryDays * DAY) return wait(`one sweep every ${plural(b.sweepEveryDays, 'day')} here`);
  return { ok: true };
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
    // never a second pull request while one is open or being made: a team is handed one at a time
    let prOpen = changeHistory(store, { now }).some(e => !e.revertedAt && (e.attention === 'pr' || e.attention === 'running'));
    for (const it of openItems(store, { now })) {
      if (!mayAct(store, it, b, { now, home, prOpen }).ok) continue;
      const r = await upkeepDo(store, it.id, { now, by: 'thinker', fns });
      if (r.error) continue;
      did.push({ id: it.id, kind: it.kind, said: r.said });
      if (it.allow === 'prs') { prOpen = true; if (it.chore === 'context') noteMachine(home, 'prs', now); }
      if (it.allow === 'tools') noteMachine(home, 'tools', now);
    }
  }
  const { pending } = upkeepPending(store, { now, home });
  store.log({ op: 'upkeep', did: did.length, pending: pending.length || undefined, level: b.level, acted: Boolean(act), chores: Object.fromEntries(CHORES.map(c => [c.id, did.filter(d => choreOfItem(d.id) === c.id).length]).filter(([, n]) => n)), ...(errors.length ? { errors: errors.length } : {}) });
  return { did, pending: pending.length, errors };
}
const choreOfItem = id => id === 'sweep' ? 'sweep' : id.startsWith('change:') ? 'context' : id.startsWith('wait:') ? 'waiting' : id.startsWith('rule:') ? 'rules' : 'other';

// --- what is not done yet ------------------------------------------------------------------------------------
const ORDER = { pr: 1, do: 2, note: 3 };
// pull requests first, then the rest; within a kind the chores in their own order, then the costliest, then the newest
const choreAt = it => { const i = CHORES.findIndex(c => c.id === it.chore); return i < 0 ? CHORES.length : i; };
const byOrder = (a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || choreAt(a) - choreAt(b) || (b.rank || 0) - (a.rank || 0) || String(b.found || '').localeCompare(String(a.found || ''));
// Everything important the last check found that still holds and was not left alone, in the order it matters.
function openItems(store, { now = Date.now() } = {}) {
  const st = readUpkeep(store);
  let decided = new Set(); try { decided = decidedKeys(store, { now }); } catch {}
  const items = [];
  for (const c of CHORES) { if (c.live) { try { items.push(...c.live(store, { now })); } catch {} } }
  for (const it of st.items) {
    const c = choreOf(it.chore); if (!c) continue;
    let cur = it; try { if (c.still) cur = c.still(store, it, { decided, now }); } catch { cur = it; }
    if (cur) items.push(cur);
  }
  return items.filter(it => it.important && (!st.dismissed[it.id] || now - Date.parse(st.dismissed[it.id]) >= UPKEEP.dismissDays * DAY)).sort(byOrder);
}
// What thinker found and has not done, each with why (`pending`: it waits its turn, or the person's word, or a
// setting says no), and what is worth knowing (`notes`: a rule sessions keep breaking). Neither is a list for the
// person to work through: the page shows only how much is waiting, and the chat is shown both, so thinker can say
// what it is holding and be told to go ahead.
export function upkeepPending(store, { now = Date.now(), home = thinkerHome() } = {}) {
  const st = readUpkeep(store), b = behaviorOf(store, { home }), pending = [], notes = [];
  for (const it of openItems(store, { now })) {
    if (!it.action) { notes.push(it); continue; }
    const may = mayAct(store, it, b, { now, home });
    pending.push({ ...it, why: may.ok ? 'at its next check' : may.why || 'not now', ...(may.ok || may.later ? { later: true } : {}) });
  }
  return { lastCheck: st.lastCheck, pending, notes };
}
const itemOf = (store, ref, now) => openItems(store, { now }).find(it => it.id === ref) || null;
const forget = (st, id) => { st.items = st.items.filter(it => it.id !== id); };

// Do what an item offers, by its id. `by`: a check (`thinker`), or the person saying so in the chat (`you`), who is
// held to no limit. What was done is kept for the activity with its undo.
export async function upkeepDo(store, ref, { now = Date.now(), by = 'you', fns = {}, pr } = {}) {
  const it = itemOf(store, ref, now);
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
// context change is also left alone in its own history, as in `thinker context`).
export function upkeepDismiss(store, ref, { now = Date.now(), fns = {} } = {}) {
  const it = itemOf(store, ref, now);
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
// pull request closed).
export async function upkeepUndo(store, id, { now = Date.now(), fns = {} } = {}) {
  if (String(id).startsWith('h:')) {
    const hid = String(id).slice(2), e = changeHistory(store, { now }).find(h => h.id === hid);
    const r = await revertDecision(store, hid, { now, ...(fns.prs ? { prs: fns.prs } : {}) });
    if (r.error) return { error: r.error };
    // what the person took back is not done again: its change is left alone as if they had said so
    const st = readUpkeep(store);
    for (const k of e ? e.keys || [e.key] : []) st.dismissed[`change:${k}`] = new Date(now).toISOString();
    writeUpkeep(store, st);
    store.log({ op: 'upkeep-undo', chore: 'context' });
    // (the decision's own words end "suggested again": not by thinker, which now leaves it alone)
    return { said: String(r.said || 'Taken back').replace(/; suggested again.*$/, '') };
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
  return `${i.measured ? '' : 'about '}${saved ? '−' : '+'}${formatTokens(Math.abs(Math.round(i.perPrompt)))} tokens per prompt${day}${i.pending ? ' once merged' : ''}`;
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
    out.push(line({ id: `d:${d.id}`, at: d.at, kind: 'did', ...(d.chore === 'sweep' ? { steer: 'sweep' } : {}), text: d.said, by: d.by, ...(d.undo && !d.undoneAt ? { undo: d.id } : {}), ...(d.undoneAt ? { undone: true } : {}) }, d.undoneAt ? null : d.impact));
  }
  let history = []; try { history = changeHistory(store, { now }); } catch {}
  if (history.length) {
    // each decision with its measured effect, from the report kept here (a file read; nothing is measured now), and
    // this repository's pace: the prompts a day over the last week
    let rows = [], rate = null; try { ({ rows, rate } = report || { rows: keptRows(store, { now }).rows, rate: inputRateHere(store, { now }) }); history = withEffects(history, rows, now); } catch {}
    const perDay = rows.filter(r => r.t >= now - 7 * DAY).reduce((a, r) => a + Math.max(1, r.prompts || 0), 0) / 7;
    const groups = new Set();
    for (const e of history) {
      if (e.decision === 'dismissed') continue;
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
export function upkeepDetail(store, id, { now = Date.now(), log, report, compression, home = thinkerHome() } = {}) {
  const out = [];
  id = String(id || '');
  if (id.startsWith('h:')) {
    let history = []; try { history = changeHistory(store, { now }); } catch {}
    let rows = [], rate = null; try { ({ rows, rate } = report || { rows: keptRows(store, { now }).rows, rate: inputRateHere(store, { now }) }); history = withEffects(history, rows, now); } catch {}
    const e = history.find(h => h.id === id.slice(2));
    if (!e) return out;
    const done = readUpkeep(store).done.find(d => d.kept && d.item === `change:${e.key || (e.keys || [])[0]}`);
    for (const h of e.group && (e.job || e.pr) ? history.filter(x => x.group === e.group) : [e]) {
      out.push(`${h.title}${h.what ? ` (${String(h.what).toLowerCase()})` : ''}${h.about ? `. It begins: "${short(h.about, 240)}"` : ''}`);
      if (h.tokens?.before != null) out.push(`  Its size: ${formatTokens(h.tokens.before)} tokens before the change, ${formatTokens(h.tokens.after || 0)} after. It is read again by every model call of every session that loads the file.`);
      if (h.saving) out.push(`  Why it was picked: about ${formatTokens(h.saving)} of its tokens in an average prompt were going where they were not needed${h.total && h.days ? `, ${formatTokens(h.total)} tokens over the ${h.days} days before` : ''}.`);
      const fx = h.effect;
      if (fx) out.push(`  Measured: it cost ${formatTokens(fx.before.perPrompt)} tokens a prompt before (${plural(fx.before.sessions, 'session')}, ${fx.before.prompts} prompts) and ${formatTokens(fx.after.perPrompt)} since (${plural(fx.after.sessions, 'session')}, ${fx.after.prompts} prompts): ${formatTokens(Math.abs(fx.delta))} ${fx.delta >= 0 ? 'fewer' : 'more'} a prompt${fx.share != null ? `, ${Math.round(1000 * Math.abs(fx.share)) / 10}% of what a whole prompt cost before` : ''}${fx.since?.prompts ? `; ${formatTokens(Math.abs(fx.window))} tokens ${fx.window >= 0 ? 'saved' : 'more'} over the ${fx.since.prompts} prompts since` : ''}${fx.few ? '. Under five sessions on one side, so the figure is early' : ''}.`);
      else out.push(`  Not measured yet: ${h.pr?.state === 'open' || h.job?.state === 'running' ? 'it is not in effect until its pull request merges' : 'it needs sessions on both sides of the change'}. The figure given is what was expected when it was picked.`);
    }
    out.push(`How it was done: ${e.action ? `${e.action.toLowerCase()}, ` : ''}${e.decision}, on ${dateSaid(e.at)}, ${e.via === VIA.thinker ? (done?.by === 'thinker' ? 'by thinker itself at one of its checks' : 'by thinker, on the person\'s word in the chat') : DOORS[e.via] || 'by the person'}${e.result ? `. ${e.result}` : ''}.`);
    if (e.pr) out.push(`Its pull request: #${e.pr.number}, ${e.pr.state === 'open' ? 'in review' : e.pr.state}${e.pr.at ? ` since ${dateSaid(e.pr.at)}` : ''}${e.pr.url ? `, ${e.pr.url}` : ''}.${e.pr.state === 'open' ? ' It is the team\'s to review and merge; the change is not in effect until then.' : ''}`);
    const perDay = rows.filter(r => r.t >= now - 7 * DAY).reduce((a, r) => a + Math.max(1, r.prompts || 0), 0) / 7;
    if (rate != null && perDay) out.push(`How the dollars a day are reckoned: the tokens off a prompt, times the ${Math.round(perDay)} prompts a day this repository ran over the last week, at $${(rate * 1e6).toFixed(2)} a million input tokens (what input cost here, cache reads and writes as they were).`);
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
export function summary({ level, lastCheck, later, held }) {
  if (level === 'off') return 'Thinker is not looking after this repository.';
  if (!lastCheck) return 'Thinker has not looked here yet.';
  const said = [later ? `${plural(later, 'change')} waiting ${later === 1 ? 'its' : 'their'} turn` : '', held ? `${held} held back until you say` : ''].filter(Boolean);
  return said.length ? `${said.join(', ')}.` : 'Up to date.';
}
// `pending` and `notes` are for the chat (chat.js:chatContext); the page and the command show the feed and the count.
export function upkeepView(store, { now = Date.now(), log, report, compression, home = thinkerHome() } = {}) {
  const b = behaviorOf(store, { home }), on = b.level !== 'off';
  const p = on ? upkeepPending(store, { now, home }) : { lastCheck: readUpkeep(store).lastCheck, pending: [], notes: [] };
  const { set, ...behavior } = b;
  const v = { level: b.level, behavior, behaviorSaid: behaviorSaid(b), lastCheck: p.lastCheck, later: p.pending.filter(i => i.later).length, held: p.pending.filter(i => !i.later).length, pending: p.pending, notes: p.notes, feed: upkeepFeed(store, { now, log, report }), delegated: upkeepDelegated(store, { now, log, compression, home }) };
  return { ...v, summary: summary(v) };
}
// Every repository's view as one (the page's All repositories): each line says whose it is, and the last check is
// the oldest one, since that is how stale the list can be.
export function mergeUpkeepViews(pairs) {
  const pending = [], notes = [], feed = [], checks = [], profiles = [], sessions = [], totals = [], shared = new Map(), said = new Map();
  for (const { repo, name, view } of pairs) {
    if (!view) continue;
    if (view.delegated) { sessions.push(...view.delegated.sessions.map(d => ({ ...d, repo, repoName: name }))); totals.push(view.delegated.total); }
    for (const i of view.pending || []) {
      // a tool is switched for the whole machine, so the same tool found in three repositories is one thing: the
      // costliest of them, and doing it from any one of them does it for all (context-suggest.js)
      if (i.machine) { const g = shared.get(i.id) || { n: 0, top: null }; g.n++; if (!g.top || (i.rank || 0) > (g.top.rank || 0)) g.top = { ...i, repo, repoName: name }; shared.set(i.id, g); }
      else pending.push({ ...i, repo, repoName: name });
    }
    notes.push(...(view.notes || []).map(i => ({ ...i, repo, repoName: name })));
    for (const f of view.feed) {
      // the profiles of several repositories are one line, the newest update's time and their changes added
      if (f.kind === 'profile' && f.profile) { profiles.push({ ...f, repo, repoName: name }); continue; }
      if (!f.shared) { feed.push({ ...f, repo, repoName: name }); continue; }
      // a decision for the whole machine: one line, what it saves a day added over the repositories, and the tokens a
      // prompt the average over their prompts
      const had = said.get(f.shared);
      if (!had) { const x = { ...f, repo, repoName: 'All repositories' }; said.set(f.shared, x); feed.push(x); continue; }
      if (!f.impact || !had.impact) { if (f.impact && !had.impact) Object.assign(had, { impact: f.impact, impactSaid: f.impactSaid }); continue; }
      const a = had.impact, b = f.impact, n = (a.promptsPerDay || 0) + (b.promptsPerDay || 0);
      had.impact = { perPrompt: n ? (a.perPrompt * (a.promptsPerDay || 0) + b.perPrompt * (b.promptsPerDay || 0)) / n : a.perPrompt, perDay: a.perDay == null && b.perDay == null ? null : (a.perDay || 0) + (b.perDay || 0), promptsPerDay: n, measured: a.measured && b.measured, ...(a.pending || b.pending ? { pending: true } : {}) };
      had.impactSaid = impactSaid(had.impact);
    }
    if (view.level !== 'off') checks.push(view.lastCheck);
  }
  for (const g of shared.values()) pending.push(g.n > 1 ? { ...g.top, repoName: `${g.n} repositories` } : g.top);
  pending.sort(byOrder);
  if (profiles.length === 1) feed.push(profiles[0]);
  else if (profiles.length) { const sum = k => profiles.reduce((a, f) => a + f.profile[k], 0), p = { added: sum('added'), reworded: sum('reworded'), dropped: sum('dropped') }; feed.push({ at: profiles.map(f => f.at).sort().at(-1), kind: 'profile', by: 'thinker', profile: p, text: profileSaid(p, ` in ${profiles.length} repositories`), repoName: '' }); }
  feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const on = pairs.filter(p => p.view && p.view.level !== 'off'), levels = [...new Set(on.map(p => p.view.level))];
  const level = !on.length ? 'off' : levels.length === 1 ? levels[0] : 'mixed', lastCheck = checks.length && checks.every(Boolean) ? checks.sort()[0] : null;
  const first = on[0]?.view;
  const v = { level, behavior: first?.behavior || null, behaviorSaid: level === 'mixed' ? 'Thinker behaves differently from one repository to the next here.' : first?.behaviorSaid || behaviorSaid({ level: 'off' }), lastCheck, later: pending.filter(i => i.later).length, held: pending.filter(i => !i.later).length, pending, notes, feed: feed.slice(0, UPKEEP.feedMax),
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
