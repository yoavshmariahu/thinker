// Upkeep: what thinker does by itself between sessions, beside learning. It looks at what the coding agents left
// behind in a repository, does what is important enough to do without asking, and keeps the rest as a short list
// for the person. Recent activity shows both (the page and `thinker activity`, one view: upkeepView), and the
// person changes how it behaves by talking to it (chat.js).
//
// A check runs on maintenance's clock (maintain.js, every four hours on the next activity) and on `thinker
// activity run`. It spends no model tokens: everything it reads was measured already, by code or by the one pass
// each session gets when it ends (profile.js). Nothing is replayed and nothing is judged twice.
//
// What a check looks for (CHORES):
//   sweep     worktrees and branches whose work is merged (upkeep-sweep.js)
//   context   the context changes Find Savings ranks highest (context-suggest.js:currentChanges): a section of an
//             instruction file nobody needs becomes a pull request, a tool nobody calls is switched. One
//             computation with the page: the decision is kept in the same history, by the door `thinker`.
//   rules     a section of the instruction file that sessions keep breaking, from the verdicts on real sessions
//             (instruction-value.js). A heads-up: what to do about a rule nobody follows is the person's.
//   waiting   what an earlier action still needs: a pull request to merge, a failed change to try again
//
// How it behaves (BEHAVIOR; the owner's rule, 2026-11-21: "take actions on its own and put up PRs as needed, but
// only for important things and not too frequently"):
//   - It acts by itself (`level: 'auto'`). `ask` only lists what it found; `off` stops the checks.
//   - Only on what is important: a section flagged high waste by the Context report (5% of its file's cost or
//     more spent where it was not needed), a sweep of three things or 500 MB. What is not important is not
//     listed either: it stays on Find Savings, where the person goes when they want to look.
//   - Not often: one pull request a repository a week and never while one is open, one a day over the whole
//     machine, one sweep a repository a day. A find that has to wait its turn is done at a later check.
//   - A pull request is the only way it changes a repository's files. A section is never rewritten in the
//     working tree without the person.
//   - It does not switch tools by itself (`tools: false`): that changes what an agent can call. An important one
//     is listed for the person, who can also tell it to go ahead from then on.
// The settings are `upkeep: { … }` in <THINKER_HOME>/config.json for the machine and in .thinker/config.json for
// one repository (which wins); `upkeep: false` is `level: off`. The chat writes them (setBehavior).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findMess, sweep, unsweep, SWEEP } from './upkeep-sweep.js';
import { currentChanges, decidedKeys, allChanges, pickChanges, approveChanges, dismissChanges, changeHistory, retryJob, VIA, SUGGEST } from './context-suggest.js';
import { lastSnapshot } from './context-snapshot.js';
import { rateOf } from './context-view.js';
import { prAvailable } from './instruction-pr.js';
import { instructionFiles, sections, sectionId, readValueState } from './instruction-value.js';
import { readMachineConfig, updateMachineConfig } from './repo-switch.js';
import { thinkerHome } from './update.js';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { formatDollars } from './prices.js';

export const UPKEEP = {
  dismissDays: 7,   // "leave it" holds this long, then the item may come back
  keepDone: 200,    // actions remembered, newest kept
  feedDays: 14,     // how far back the activity reads
  feedMax: 60,
  ruleDays: 30,     // the window a broken rule is counted over
  ruleBroken: 3,    // sessions that broke a rule before it is worth a heads-up
  staleMs: 24 * 3600_000, // the page asks for a look when the last check is older than this
};
const DAY = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = kb => !kb ? '' : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// --- how it behaves ------------------------------------------------------------------------------------------
// Each setting with what it may be, and the words the chat and the command say it in.
export const BEHAVIOR = {
  level: 'auto', sweep: true, prs: true, tools: false,
  important: 'high', prEveryDays: 7, prsPerDay: 1, sweepEveryDays: 1, sweepMin: 3, sweepMinMb: 500,
};
const num = (min, max) => v => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined; };
const bool = v => v === true || /^(true|on|yes)$/i.test(String(v)) ? true : v === false || /^(false|off|no)$/i.test(String(v)) ? false : undefined;
const oneOf = (...xs) => v => xs.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : undefined;
export const SETTINGS = {
  level: { read: oneOf('auto', 'ask', 'off'), about: 'auto: do what is important by itself; ask: only list what it found; off: stop looking' },
  sweep: { read: bool, about: 'whether it may remove merged worktrees and branches by itself' },
  prs: { read: bool, about: 'whether it may put up a pull request by itself' },
  tools: { read: bool, about: 'whether it may switch off or reference an unused tool by itself' },
  important: { read: oneOf('high', 'medium'), about: 'how costly a thing must be to act on: high (5% of its kind\'s cost wasted) or medium (2%)' },
  prEveryDays: { read: num(1, 90), about: 'days between pull requests in one repository' },
  prsPerDay: { read: num(1, 20), about: 'pull requests a day over the whole machine' },
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
// The behaviour in a sentence or two, for the page, the command and the chat.
export function behaviorSaid(b) {
  if (b.level === 'off') return 'Thinker is not looking after this repository (upkeep is off).';
  if (b.level === 'ask') return 'Thinker only lists what it finds here; nothing is done until you say so.';
  const does = [b.sweep ? 'removes merged worktrees and branches' : '', b.prs ? `puts up a pull request for a costly section nobody needs, at most one every ${plural(b.prEveryDays, 'day')}` : '', b.tools ? 'switches off tools nobody calls' : ''].filter(Boolean);
  return does.length ? `Thinker acts on its own here, for important things only: it ${does.join(', ')}.` : 'Thinker may act on its own here, but every kind of action is switched off.';
}

// --- what it remembers ---------------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'upkeep.json');
export function readUpkeep(store) {
  try { const j = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); return { lastCheck: j.lastCheck || null, items: j.items || [], seen: j.seen || {}, dismissed: j.dismissed || {}, done: j.done || [] }; }
  catch { return { lastCheck: null, items: [], seen: {}, dismissed: {}, done: [] }; }
}
function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(v) + '\n');
  fs.renameSync(tmp, f);
}
function writeUpkeep(store, st) { st.done = (st.done || []).slice(-UPKEEP.keepDone); writeJson(stateFile(store), st); }
// the pull requests thinker put up by itself, over every repository, for the machine's daily limit
const machineFile = home => path.join(home, 'state', 'upkeep.json');
const machinePrs = home => { try { return (JSON.parse(fs.readFileSync(machineFile(home), 'utf8')).prs || []).filter(t => Number.isFinite(Date.parse(t))); } catch { return []; } };
function notePr(home, now) { try { writeJson(machineFile(home), { prs: [...machinePrs(home).filter(t => now - Date.parse(t) < 7 * DAY), new Date(now).toISOString()] }); } catch {} }

// --- the chores ----------------------------------------------------------------------------------------------
// Each: `find` (a check's look, kept), `live` (read fresh every time, cheap, never kept), `still` (whether a kept
// item is still true), `act`, and where it differs from forgetting for a week, `dismiss`. An item says whether it
// is `important` (worth doing without asking) and which setting lets thinker do it by itself (`allow`).
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
    const mess = (opts.fns?.findMess || findMess)(store, { now: opts.now });
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
    return { said: `Removed ${[w ? plural(w, 'merged worktree') : '', b ? plural(b, w ? 'branch' : 'merged branch', w ? 'branches' : 'merged branches') : ''].filter(Boolean).join(' and ')}${r.kb ? `, ${size(r.kb)} back` : ''}${left}`, undo: { kind: 'sweep', branches: r.branches, worktrees: r.worktrees } };
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
    return currentChanges(store, view, { now: opts.now }).filter(c => c.default).map(c => {
      const sec = c.kind === 'section';
      const worth = !c.total ? '' : rate == null ? ` About ${formatTokens(c.total)} tokens went on it unused over the last ${c.days} days.` : ` About ${formatDollars(c.total * rate)} went on it unused over the last ${c.days} days.`;
      const label = !sec ? c.default.text : `${canPr ? 'Put up a PR' : 'Change the file'} to ${c.default.act === 'remove' ? 'remove' : 'shorten'} it`;
      // A section is done by itself only as a pull request, which the team reviews: where none can be opened from
      // here it waits for the person (`allow: null`). `rank`: what it is worth, so the costliest comes first;
      // `machine`: a tool is switched for every repository at once.
      return { id: `change:${c.key}`, chore: 'context', kind: sec ? 'pr' : 'do', allow: sec ? (canPr ? 'prs' : null) : 'tools', important: c.waste === 'high' || (level === 'medium' && c.waste === 'medium'), rank: c.total || 0, ...(c.kind === 'tool' ? { machine: true } : {}), title: c.title, detail: `${c.why.charAt(0).toUpperCase()}${c.why.slice(1)}.${worth}`, action: { label }, data: { key: c.key } };
    });
  },
  // a change decided through any door since the check (the page, the session's question, the command) is no longer open
  still(store, item, ctx) { return ctx.decided.has(item.data?.key) ? null : item; },
  pick(store, item, opts) { const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store); return view ? pickChanges(allChanges(view), [item.data.key]) : []; },
  async act(store, item, opts) {
    const picked = this.pick(store, item, opts);
    if (!picked.length) return { error: 'that part is no longer in the report; it is looked for again at the next check' };
    // By itself thinker changes a section only as a pull request: asked again now, since the check that found it may be
    // hours old, and never left to fall back on writing the file in the working tree (which is the person's own Apply).
    let pr = opts.pr;
    if (opts.by === 'thinker' && item.kind === 'pr') {
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
      detail: `Broken in ${g.broken} of the ${plural(g.bore, 'session')} it came up in over the last ${UPKEEP.ruleDays} days. It is in the file and still missed, so more words there will not fix it: make it a check, or say it where the work happens.`,
      lines: g.evidence.sort((a, b) => b.at - a.at).slice(0, 3).map(e => short(e.text, 200)), action: null, data: { section: id, broken: g.broken, bore: g.bore },
    }));
  },
};

// What an earlier action still needs, read from the decisions' own history each time (never kept): one item a pull
// request, however many sections it carries.
const waitingChore = {
  id: 'waiting',
  live(store, { now }) {
    const out = [], prs = new Set();
    for (const e of changeHistory(store, { now })) {
      if (e.revertedAt || !e.attention) continue;
      if (e.attention === 'pr' && e.pr?.number && !prs.has(e.pr.number)) {
        prs.add(e.pr.number);
        out.push({ id: `wait:pr:${e.pr.number}`, chore: 'waiting', kind: 'wait', allow: null, important: true, title: `PR #${e.pr.number} is waiting for you to merge it`, detail: e.title, link: e.pr.url ? { url: e.pr.url, text: `Open #${e.pr.number}` } : null, action: null, found: e.pr.at || e.at, data: { history: e.id } });
      } else if (e.attention === 'failed') {
        out.push({ id: `wait:job:${e.group || e.id}`, chore: 'waiting', kind: 'do', allow: null, important: true, title: `A change did not go through: ${e.title}`, detail: short(e.job?.error || 'it failed', 200), action: { label: 'Try again' }, found: e.job?.finishedAt || e.at, data: { history: e.id } });
      }
    }
    return out.filter((x, i) => out.findIndex(y => y.id === x.id) === i);
  },
  act(store, item, opts) {
    const r = retryJob(store, item.data.history, { now: opts.now, ...(opts.fns?.spawn ? { spawnFn: opts.fns.spawn } : {}) });
    return r.error ? { error: r.error } : { said: r.said, kept: true };
  },
};
export const CHORES = [waitingChore, sweepChore, contextChore, rulesChore];
const choreOf = id => CHORES.find(c => c.id === id);

// --- acting by itself ----------------------------------------------------------------------------------------
// Whether thinker may do an item now without asking, and if not, whether it is only waiting its turn (`later`):
// the setting for its kind, then how lately it did the same. A person's own Do it is never held to any of this.
export function mayAct(store, item, b, { now = Date.now(), home = thinkerHome(), prOpen = false } = {}) {
  if (b.level !== 'auto' || !item.important || !item.action || !item.allow || !b[item.allow]) return { ok: false };
  const mine = readUpkeep(store).done.filter(d => d.by === 'thinker' && !d.undoneAt);
  const last = chore => Math.max(0, ...mine.filter(d => d.chore === chore && (chore !== 'context' || d.kind === item.kind)).map(d => Date.parse(d.at)));
  if (item.allow === 'prs') {
    if (prOpen) return { ok: false, later: 'a pull request is still open here' };
    if (now - last('context') < b.prEveryDays * DAY) return { ok: false, later: `one pull request every ${plural(b.prEveryDays, 'day')} here` };
    if (machinePrs(home).filter(t => now - Date.parse(t) < DAY).length >= b.prsPerDay) return { ok: false, later: `${plural(b.prsPerDay, 'pull request')} a day over the machine` };
  }
  if (item.allow === 'sweep' && now - last('sweep') < b.sweepEveryDays * DAY) return { ok: false, later: `one sweep every ${plural(b.sweepEveryDays, 'day')} here` };
  return { ok: true };
}

// --- a check -------------------------------------------------------------------------------------------------
// One look at everything, kept for the command and the page; then what thinker may do by itself (`act: false` only
// looks, which is all a visit to the page ever starts). Returns what it found and did.
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
    for (const it of openItems(store, { now, all: true })) {
      const may = mayAct(store, it, b, { now, home, prOpen });
      if (!may.ok) continue;
      const r = await upkeepDo(store, it.id, { now, by: 'thinker', fns, all: true, home });
      if (r.error) continue;
      did.push({ id: it.id, kind: it.kind, said: r.said });
      if (it.allow === 'prs') { prOpen = true; notePr(home, now); }
    }
  }
  const { items: open, later } = upkeepInbox(store, { now, home });
  store.log({ op: 'upkeep', found: open.length, did: did.length, later: later || undefined, level: b.level, acted: Boolean(act), chores: Object.fromEntries(CHORES.map(c => [c.id, open.filter(i => i.chore === c.id).length]).filter(([, n]) => n)), ...(errors.length ? { errors: errors.length } : {}) });
  return { found: open.length, did, later, errors };
}

// --- what needs the person -----------------------------------------------------------------------------------
const ORDER = { wait: 0, pr: 1, do: 2, note: 3 };
// what waits on the person first, then proposals, cleanups and heads-ups; within a kind the chores in their own order
// (a sweep before a switch), then the costliest, then the newest
const choreAt = it => { const i = CHORES.findIndex(c => c.id === it.chore); return i < 0 ? CHORES.length : i; };
const byOrder = (a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || choreAt(a) - choreAt(b) || (b.rank || 0) - (a.rank || 0) || String(b.found || '').localeCompare(String(a.found || ''));
// Everything the last check found that still holds and was not left alone (`all`), in the order it matters.
function openItems(store, { now = Date.now(), all = false } = {}) {
  const st = readUpkeep(store);
  let decided = new Set(); try { decided = decidedKeys(store, { now }); } catch {}
  const items = [];
  for (const c of CHORES) { if (c.live) { try { items.push(...c.live(store, { now })); } catch {} } }
  for (const it of st.items) {
    const c = choreOf(it.chore); if (!c) continue;
    let cur = it; try { if (c.still) cur = c.still(store, it, { decided, now }); } catch { cur = it; }
    if (cur) items.push(cur);
  }
  const open = items.filter(it => !st.dismissed[it.id] || now - Date.parse(st.dismissed[it.id]) >= UPKEEP.dismissDays * DAY);
  return (all ? open : open.filter(it => it.important)).sort(byOrder);
}
// What needs the person: the important finds thinker will not do by itself -- it is not allowed to, or it only asks
// here. What it will do at a later check is not listed, and neither is what is not important. Numbered, as the
// command names them.
export function upkeepInbox(store, { now = Date.now(), home = thinkerHome() } = {}) {
  const st = readUpkeep(store), b = behaviorOf(store, { home }), mine = [];
  let later = 0;
  // `later`: what thinker will do by itself at a coming check, counted and not listed
  for (const it of openItems(store, { now })) { const may = mayAct(store, it, b, { now, home }); if (may.ok || may.later) later++; else mine.push(it); }
  return { lastCheck: st.lastCheck, later, items: mine.map((it, i) => ({ ...it, n: i + 1 })) };
}
// an item by its number among what needs the person, or by its id (`all`: among everything found)
function itemOf(store, ref, now, all = false, home = thinkerHome()) {
  const items = all ? openItems(store, { now, all: true }) : upkeepInbox(store, { now, home }).items;
  return items.find(it => it.id === ref || String(it.n) === String(ref)) || (all ? null : openItems(store, { now, all: true }).find(it => it.id === ref)) || null;
}
const forget = (st, id) => { st.items = st.items.filter(it => it.id !== id); };

// Do what an item offers. `by`: the person (`you`) or a check acting by itself (`thinker`). What was done is kept
// for the activity with its undo, except where the chore keeps the decision itself (a context change: its history).
export async function upkeepDo(store, ref, { now = Date.now(), by = 'you', fns = {}, pr, all = false, home = thinkerHome() } = {}) {
  const it = itemOf(store, ref, now, all, home);
  if (!it) return { error: `nothing that needs you is ${ref}; \`thinker activity\` lists it` };
  const c = choreOf(it.chore);
  if (!it.action || !c?.act) return { error: `${it.title}: there is nothing to do about it from here${it.link ? ` (${it.link.url})` : ''}` };
  let r; try { r = await c.act(store, it, { now, fns, pr, by }); } catch (e) { r = { error: short(e.message || e, 200) }; }
  if (r.error) return { error: r.error, item: it.id };
  const st = readUpkeep(store);
  forget(st, it.id);
  const entry = { id: randomBytes(5).toString('hex'), at: new Date(now).toISOString(), item: it.id, chore: it.chore, kind: it.kind, title: it.title, said: r.said, by, ...(r.undo ? { undo: r.undo } : {}), ...(r.kept ? { kept: true } : {}) };
  st.done.push(entry);
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-do', chore: it.chore, kind: it.kind, by });
  return { said: r.said, done: entry.id, title: it.title };
}
// Leave an item alone: it stays away a week (a context change is left alone in its own history, as on Find Savings).
export function upkeepDismiss(store, ref, { now = Date.now(), fns = {}, home = thinkerHome() } = {}) {
  const it = itemOf(store, ref, now, false, home);
  if (!it) return { error: `nothing that needs you is ${ref}; \`thinker activity\` lists it` };
  const c = choreOf(it.chore), st = readUpkeep(store);
  let kept = false; try { kept = Boolean(c?.dismiss?.(store, it, { now, fns })?.kept); } catch {}
  st.dismissed[it.id] = new Date(now).toISOString();
  if (kept) forget(st, it.id);
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-dismiss', chore: it.chore, kind: it.kind });
  return { said: `${it.title}: left alone${it.kind === 'wait' ? '' : `; it may come back in ${plural(UPKEEP.dismissDays, 'day')}`}` };
}
// Take back something that was done, by the id the activity carries.
export function upkeepUndo(store, id, { now = Date.now() } = {}) {
  const st = readUpkeep(store), e = st.done.find(d => d.id === id);
  if (!e) return { error: 'no such action' };
  if (e.undoneAt) return { error: 'already taken back' };
  const c = choreOf(e.chore);
  if (!e.undo || !c?.undo) return { error: e.kept ? 'this one is taken back from its row under Action savings (`thinker context --revert`)' : 'this one cannot be taken back' };
  let r; try { r = c.undo(store, e.undo); } catch (err) { r = { error: short(err.message || err, 200) }; }
  if (r.error) return { error: r.error };
  e.undoneAt = new Date(now).toISOString();
  writeUpkeep(store, st);
  store.log({ op: 'upkeep-undo', chore: e.chore });
  return { said: r.said };
}

// --- what was done -------------------------------------------------------------------------------------------
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Newest first, in plain words: what thinker did here and what the person did through it, the pull requests that
// followed, and the offline work of each day (the sessions read, the profile updated, the state cleared).
export function upkeepFeed(store, { now = Date.now(), days = UPKEEP.feedDays, log } = {}) {
  const since = now - days * DAY, out = [];
  for (const d of readUpkeep(store).done) {
    if (Date.parse(d.at) < since || d.kept) continue;
    out.push({ at: d.at, kind: 'did', text: d.said, by: d.by, ...(d.undo && !d.undoneAt ? { undo: d.id } : {}), ...(d.undoneAt ? { undone: true } : {}) });
  }
  let history = []; try { history = changeHistory(store, { now }); } catch {}
  const groups = new Set();
  for (const e of history) {
    if (e.decision === 'dismissed') continue;
    // several sections changed together are one job and one pull request: one line
    const g = e.group && (e.job || e.pr) ? e.group : null;
    if (g) { if (groups.has(g)) continue; groups.add(g); }
    const n = g ? history.filter(h => h.group === g).length : 1, what = n > 1 ? `${e.title} and ${plural(n - 1, 'more section')}` : e.title;
    const at = e.pr?.at || e.job?.finishedAt || e.at;
    if (Date.parse(at) < since) continue;
    const mine = readUpkeep(store).done.find(d => d.kept && d.by === 'thinker' && d.item === `change:${e.key || (e.keys || [])[0]}`);
    const line = e.running ? `Working on it now: ${what}` : e.failed ? `Could not change ${what}: ${short(e.job?.error, 100)}`
      : e.pr ? `${e.pr.state === 'merged' ? `PR #${e.pr.number} merged` : e.pr.state === 'closed' ? `PR #${e.pr.number} was closed without merging` : `Put up PR #${e.pr.number}`}: ${what}`
      : `${what}: ${e.result || e.decision}`;
    // `shared`: a decision for the whole machine is in every repository's history, and is one line when they are read together
    out.push({ at, kind: e.pr ? 'pr' : 'change', text: line, by: mine ? 'thinker' : 'you', ...(e.pr?.url ? { url: e.pr.url } : {}), ...(e.revertedAt ? { undone: true } : {}), ...(e.scope === 'machine' ? { shared: e.id } : {}) });
  }
  // the offline work, a line a day of each kind: nobody wants a row per session
  const daily = new Map();
  const add = (t, kind, fn) => { const k = `${dayKey(t)} ${kind}`; if (!daily.has(k)) daily.set(k, { at: t, kind, n: 0, a: 0, b: 0, c: 0 }); const g = daily.get(k); if (t > g.at) g.at = t; fn(g); };
  for (const e of log || readLog(store)) {
    if (!e.t || Date.parse(e.t) < since) continue;
    if (e.op === 'profile') add(e.t, 'read', g => { g.n++; g.a += e.observations || 0; });
    else if (e.op === 'profile-compile' && e.changes) add(e.t, 'profile', g => { g.n++; g.a += e.changes.added || 0; g.b += e.changes.updated || 0; g.c += e.changes.dropped || 0; });
    else if (e.op === 'maintain' && e.pruned) add(e.t, 'pruned', g => { g.n += e.pruned; });
  }
  for (const g of daily.values()) {
    if (g.kind === 'read') out.push({ at: g.at, kind: 'read', text: `Read ${plural(g.n, 'session')}${g.a ? ` and noted ${plural(g.a, 'thing')} about how you work` : '; nothing new to note'}`, by: 'thinker' });
    else if (g.kind === 'profile' && g.a + g.b + g.c) out.push({ at: g.at, kind: 'profile', text: `Updated your profile: ${[g.a ? `${plural(g.a, 'line')} added` : '', g.b ? `${g.b} reworded` : '', g.c ? `${g.c} dropped` : ''].filter(Boolean).join(', ')}`, by: 'thinker' });
    else if (g.kind === 'pruned') out.push({ at: g.at, kind: 'pruned', text: `Cleared ${plural(g.n, 'stale state file')}`, by: 'thinker' });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, UPKEEP.feedMax);
}

// --- what both doors read ------------------------------------------------------------------------------------
// One line on how things stand.
export function summary({ level, lastCheck, items, later }) {
  if (level === 'off') return 'Thinker is not looking after this repository.';
  const mine = items.filter(i => i.kind !== 'note').length, notes = items.length - mine;
  const wait = later ? `${plural(later, 'more change')} waiting ${later === 1 ? 'its' : 'their'} turn` : '';
  if (!lastCheck && !items.length) return 'Thinker has not looked here yet.';
  if (!items.length) return ['Nothing needs you', wait].filter(Boolean).join('; ') + '.';
  return [mine ? `${plural(mine, 'thing')} need${mine === 1 ? 's' : ''} you` : '', notes ? plural(notes, 'heads-up') : '', wait].filter(Boolean).join(', ') + '.';
}
export function upkeepView(store, { now = Date.now(), log, home = thinkerHome() } = {}) {
  const b = behaviorOf(store, { home }), on = b.level !== 'off';
  const inbox = on ? upkeepInbox(store, { now, home }) : { lastCheck: readUpkeep(store).lastCheck, later: 0, items: [] };
  const { set, ...behavior } = b;
  const v = { level: b.level, behavior, behaviorSaid: behaviorSaid(b), lastCheck: inbox.lastCheck, later: inbox.later, items: inbox.items, feed: upkeepFeed(store, { now, log }), attention: inbox.items.filter(i => i.kind !== 'note' && i.chore !== 'waiting').length };
  return { ...v, summary: summary(v) };
}
// Every repository's view as one (the page's All repositories): each item and line says whose it is, what needs the
// person is numbered again, and the last check is the oldest one, since that is how stale the list can be.
export function mergeUpkeepViews(pairs) {
  const items = [], feed = [], checks = [], shared = new Map(), said = new Set();
  let later = 0;
  for (const { repo, name, view } of pairs) {
    if (!view) continue;
    later += view.later || 0;
    for (const i of view.items) {
      // a tool is switched for the whole machine, so the same tool found in three repositories is one item: the
      // costliest of them, said once, and doing it from any one of them does it for all (context-suggest.js)
      if (i.machine) { const g = shared.get(i.id) || { n: 0, top: null }; g.n++; if (!g.top || (i.rank || 0) > (g.top.rank || 0)) g.top = { ...i, repo, repoName: name }; shared.set(i.id, g); }
      else items.push({ ...i, repo, repoName: name });
    }
    for (const f of view.feed) { if (f.shared) { if (said.has(f.shared)) continue; said.add(f.shared); feed.push({ ...f, repo, repoName: 'All repositories' }); } else feed.push({ ...f, repo, repoName: name }); }
    if (view.level !== 'off') checks.push(view.lastCheck);
  }
  for (const g of shared.values()) items.push(g.n > 1 ? { ...g.top, repoName: `${g.n} repositories`, detail: `${g.top.detail} The figure is the costliest of the ${g.n} repositories it is loaded in.` } : g.top);
  items.sort(byOrder);
  feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const on = pairs.filter(p => p.view && p.view.level !== 'off'), levels = [...new Set(on.map(p => p.view.level))];
  const level = !on.length ? 'off' : levels.length === 1 ? levels[0] : 'mixed', lastCheck = checks.length && checks.every(Boolean) ? checks.sort()[0] : null;
  const first = on[0]?.view;
  const v = { level, behavior: first?.behavior || null, behaviorSaid: level === 'mixed' ? 'Thinker behaves differently from one repository to the next here; pick one to see how.' : first?.behaviorSaid || behaviorSaid({ level: 'off' }), lastCheck, later, items: items.map((i, n) => ({ ...i, n: n + 1 })), feed: feed.slice(0, UPKEEP.feedMax), attention: items.filter(i => i.kind !== 'note' && i.chore !== 'waiting').length };
  return { ...v, summary: summary(v) };
}

// --- the command's page --------------------------------------------------------------------------------------
export const ago = (t, now = Date.now()) => { if (!t) return 'never'; const m = Math.max(0, Math.round((now - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const when = (t, now) => { const d = new Date(t), today = dayKey(now) === dayKey(t), time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return today ? `today ${time}` : dayKey(now - DAY) === dayKey(t) ? `yesterday ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`; };
export function renderUpkeep(v, { now = Date.now(), feed = 12 } = {}) {
  const out = [`Recent activity · thinker last looked ${ago(v.lastCheck, now)}`, `  ${v.summary}`, `  ${v.behaviorSaid}`, ''];
  if (v.items.length) {
    out.push(`Needs you (${v.items.length})`);
    for (const it of v.items) {
      out.push(`  ${String(it.n).padStart(2)}  ${it.title}${it.repoName ? ` · ${it.repoName}` : ''}`);
      if (it.detail) out.push(`      ${it.detail}`);
      for (const l of it.lines || []) out.push(`        - ${l}`);
      out.push(`      ${it.action ? `thinker activity do ${it.n}   (${it.action.label})` : it.link ? it.link.url : 'a heads-up: nothing to run'}   ·   thinker activity leave ${it.n}`);
    }
    out.push('');
  }
  if (v.feed.length) {
    out.push('What thinker did');
    for (const f of v.feed.slice(0, feed)) out.push(`  ${when(f.at, now).padEnd(15)}  ${f.text}${f.by === 'thinker' && (f.kind === 'did' || f.kind === 'pr' || f.kind === 'change') ? ' (on its own)' : ''}${f.undone ? ' (taken back)' : ''}${f.undo ? `   · thinker activity undo ${f.undo}` : ''}${f.repoName ? ` · ${f.repoName}` : ''}`);
    if (v.feed.length > feed) out.push(`  and ${v.feed.length - feed} more (--all)`);
  }
  return out;
}
