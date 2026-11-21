// The janitor: thinker as the one who cleans up after the coding agents (the owner's framing, 2026-11-21: "your
// coding agent janitor which cleans up the mess made by other agents"). It goes round on maintenance's clock
// (maintain.js, every four hours on the next activity; `thinker janitor run` by hand), looks at what the agents left
// behind, and keeps two lists that the command and the page both read (janitorView, one computation):
//
//   the inbox   what it found that needs the person: each item says what it is, what it would do about it, and
//               carries one action (Do it) and a way to say no (Leave it, held a week)
//   the feed    what it has done, and what the offline work did while nobody watched: sessions read into the
//               profile, the profile tidied, pull requests put up and merged, things swept
//
// A round spends no model tokens. Everything it reads was measured already, by code or by the one pass each session
// gets when it ends (profile.js: the outcome of every exchange, and what the session did with each rule it was
// shown). Nothing is replayed and nothing is judged twice.
//
// The chores:
//   sweep     worktrees and branches whose work is merged (janitor-sweep.js)
//   context   the context changes Find Savings ranks highest (context-suggest.js:currentChanges): a section of
//             an instruction file nobody needs becomes a pull request, a tool nobody calls is switched off. One
//             computation with the page: the decision is kept in the same history, by the door `janitor`.
//   rules     a rule of the instruction file that sessions keep breaking, from the verdicts on real sessions
//             (instruction-value.js). A note for the person: what to do about a rule nobody follows is theirs.
//   waiting   what an earlier action still needs: a pull request to merge, a failed change to try again
//
// Two tiers of acting, by what can be lost. What is on this machine and can be put back (a sweep) and what is
// only ever a proposal (a pull request) may be done by the janitor itself where `janitor: { auto: true }` is set
// in .thinker/config.json; off by default, since nobody should find their branches gone or a pull request on their
// team's repository from a tool they just installed. A switch that changes what an agent can call is always the
// person's. `janitor: false` (or `{ enabled: false }`) stops the rounds.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findMess, sweep, unsweep, SWEEP } from './janitor-sweep.js';
import { currentChanges, decidedKeys, allChanges, pickChanges, approveChanges, dismissChanges, changeHistory, retryJob, VIA, SUGGEST } from './context-suggest.js';
import { lastSnapshot } from './context-snapshot.js';
import { rateOf } from './context-view.js';
import { prAvailable } from './instruction-pr.js';
import { instructionFiles, sections, sectionId, readValueState } from './instruction-value.js';
import { readLog } from './usage.js';
import { formatTokens } from './model-usage.js';
import { formatDollars } from './prices.js';

export const JANITOR = {
  dismissDays: 7,   // "leave it" holds this long, then the item may come back
  keepDone: 200,    // actions remembered, newest kept
  feedDays: 14,     // how far back the feed reads
  feedMax: 60,
  ruleDays: 30,     // the window a broken rule is counted over
  ruleBroken: 3,    // sessions that broke a rule before it is worth a note
  staleMs: 24 * 3600_000, // the page sends the janitor round when its last one is older than this
};
const DAY = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = kb => !kb ? '' : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function janitorConfig(store) {
  const c = store.config().janitor, o = c && typeof c === 'object' ? c : {};
  return { enabled: c !== false && o.enabled !== false, auto: o.auto === true };
}

// --- what it remembers ---------------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'janitor.json');
export function readJanitor(store) {
  try { const j = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); return { lastRound: j.lastRound || null, items: j.items || [], seen: j.seen || {}, dismissed: j.dismissed || {}, done: j.done || [] }; }
  catch { return { lastRound: null, items: [], seen: {}, dismissed: {}, done: [] }; }
}
function writeJanitor(store, st) {
  const f = stateFile(store), tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}`;
  st.done = (st.done || []).slice(-JANITOR.keepDone);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(st) + '\n');
  fs.renameSync(tmp, f);
}

// --- the chores ----------------------------------------------------------------------------------------------
// Each: `find` (a round's look, kept), `live` (read fresh every time, cheap, never kept), `still` (whether a kept
// item is still true), `act`, and where it differs from forgetting for a week, `dismiss`.
const messLines = mess => {
  const rows = [...mess.worktrees.map(w => `${path.basename(w.path)} · worktree on ${w.branch} · ${w.why}${w.kb ? ` · ${size(w.kb)}` : ''}`), ...mess.branches.map(b => `${b.name} · branch · ${b.why}`)];
  return rows.length > SWEEP.listed ? [...rows.slice(0, SWEEP.listed), `and ${rows.length - SWEEP.listed} more`] : rows;
};
const messTitle = mess => {
  const w = mess.worktrees.length, b = mess.branches.length, kb = mess.worktrees.reduce((a, x) => a + (x.kb || 0), 0);
  const what = [w ? plural(w, 'merged worktree') : '', b ? plural(b, w ? 'branch' : 'merged branch', w ? 'branches' : 'merged branches') : ''].filter(Boolean).join(' and ');
  return `${what} left behind${kb ? ` · ${size(kb)}` : ''}`;
};
const sweepChore = {
  id: 'sweep',
  find(store, opts) {
    const mess = (opts.fns?.findMess || findMess)(store, { now: opts.now });
    if (!mess.worktrees.length && !mess.branches.length) return [];
    return [{ id: 'sweep', chore: 'sweep', kind: 'do', auto: true, title: messTitle(mess), detail: 'Their work is on the default branch already, so nothing is lost by removing them, and each can be put back.', lines: messLines(mess), action: { label: 'Sweep them' }, data: { worktrees: mess.worktrees, branches: mess.branches } }];
  },
  // a worktree or a branch somebody removed by hand since the round leaves the list; an empty list leaves the inbox
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
    if (!w && !b) return { error: `nothing could be swept: ${r.skipped[0]?.why || 'everything changed since the last round'}` };
    const left = r.skipped.length ? `; ${plural(r.skipped.length, 'thing')} left where ${r.skipped.length === 1 ? 'it was' : 'they were'} (${short(r.skipped[0].why, 60)})` : '';
    return { said: `Swept ${[w ? plural(w, 'worktree') : '', b ? plural(b, 'branch', 'branches') : ''].filter(Boolean).join(' and ')}${r.kb ? `, ${size(r.kb)} back` : ''}${left}`, undo: { kind: 'sweep', branches: r.branches, worktrees: r.worktrees } };
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
    if (!view) return []; // no report kept yet: the next round has one (learn.js keeps it after maintenance)
    const rate = rateOf(view), canPr = (opts.fns?.prAvailable || prAvailable)(store.repo).ok;
    return currentChanges(store, view, { now: opts.now }).filter(c => c.default).map(c => {
      const sec = c.kind === 'section';
      const worth = !c.total ? '' : rate == null ? ` About ${formatTokens(c.total)} tokens went on it unused over the last ${c.days} days.` : ` About ${formatDollars(c.total * rate)} went on it unused over the last ${c.days} days.`;
      const label = !sec ? c.default.text : `${canPr ? 'Put up a PR' : 'Change the file'} to ${c.default.act === 'remove' ? 'remove' : 'shorten'} it`;
      // a pull request is a proposal the team reviews, so the janitor may open one itself where it is let (`auto`);
      // a switch changes what an agent can call from its next session, which is the person's to decide
      // `rank`: what it is worth, so the costliest comes first; `machine`: a tool is switched for every repository at once
      return { id: `change:${c.key}`, chore: 'context', kind: sec ? 'pr' : 'do', auto: sec && canPr, rank: c.total || 0, ...(c.kind === 'tool' ? { machine: true } : {}), title: c.title, detail: `${c.why.charAt(0).toUpperCase()}${c.why.slice(1)}.${worth}`, action: { label }, data: { key: c.key } };
    });
  },
  // a change decided through any door since the round (the page, the session's question, the command) is no longer open
  still(store, item, ctx) { return ctx.decided.has(item.data?.key) ? null : item; },
  pick(store, item, opts) { const view = opts.fns?.view ? opts.fns.view(store) : viewOf(store); return view ? pickChanges(allChanges(view), [item.data.key]) : []; },
  async act(store, item, opts) {
    const picked = this.pick(store, item, opts);
    if (!picked.length) return { error: 'that part is no longer in the report; send the janitor round again' };
    // the decision, its pull request and its undo are kept by context-suggest.js, where Recent activity reads them
    const said = await approveChanges(store, picked, { via: VIA.janitor, now: opts.now, ...(opts.fns?.spawn ? { spawnFn: opts.fns.spawn } : {}), ...(opts.pr === undefined ? {} : { pr: opts.pr }) });
    return { said: said.join(' '), kept: true };
  },
  dismiss(store, item, opts) {
    const picked = this.pick(store, item, opts);
    if (picked.length) dismissChanges(store, picked, { via: VIA.janitor, now: opts.now });
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
    const since = now - JANITOR.ruleDays * DAY, by = new Map();
    for (const [session, rec] of Object.entries(readValueState(store).sessions)) {
      const at = Date.parse(rec.judged?.at || '');
      if (!Number.isFinite(at) || at < since) continue;
      for (const [id, v] of Object.entries(rec.judged.verdicts || {})) {
        if (!by.has(id)) by.set(id, { bore: 0, broken: 0, evidence: [] });
        const g = by.get(id); g.bore++;
        if (v.verdict === 'violated') { g.broken++; if (v.evidence) g.evidence.push({ at, session, text: v.evidence }); }
      }
    }
    const broken = [...by].filter(([, g]) => g.broken >= JANITOR.ruleBroken);
    if (!broken.length) return [];
    const titles = sectionTitles(store.repo);
    // a section that has left the file is nobody's rule any more
    return broken.filter(([id]) => titles.has(id)).sort((a, b) => b[1].broken - a[1].broken).map(([id, g]) => ({
      id: `rule:${id}`, chore: 'rules', kind: 'note', title: `Agents keep breaking a rule: ${titles.get(id)}`,
      detail: `Broken in ${g.broken} of the ${plural(g.bore, 'session')} it came up in over the last ${JANITOR.ruleDays} days. It is in the file and still missed, so more words there will not fix it: make it a check, or say it where the work happens.`,
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
        out.push({ id: `wait:pr:${e.pr.number}`, chore: 'waiting', kind: 'wait', title: `PR #${e.pr.number} is waiting for you to merge it`, detail: e.title, link: e.pr.url ? { url: e.pr.url, text: `Open #${e.pr.number}` } : null, action: null, found: e.pr.at || e.at, data: { history: e.id } });
      } else if (e.attention === 'failed') {
        out.push({ id: `wait:job:${e.group || e.id}`, chore: 'waiting', kind: 'do', title: `A change did not go through: ${e.title}`, detail: short(e.job?.error || 'it failed', 200), action: { label: 'Try again' }, found: e.job?.finishedAt || e.at, data: { history: e.id } });
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

// --- a round -------------------------------------------------------------------------------------------------
// One look at everything, kept for the command and the page; then, where the person has let it (`auto`), the
// things it may do by itself. Returns what it found and did.
export async function janitorRound(store, { now = Date.now(), fns = {}, auto } = {}) {
  const cfg = janitorConfig(store);
  if (!cfg.enabled) return { skipped: 'disabled' };
  const st = readJanitor(store), at = new Date(now).toISOString(), items = [], errors = [];
  for (const c of CHORES) {
    if (!c.find) continue;
    try { items.push(...await c.find(store, { now, fns })); } catch (e) { errors.push({ chore: c.id, message: short(e.message || e, 200) }); }
  }
  // when each thing was first found: an item that leaves and comes back is found again
  st.seen = Object.fromEntries(items.map(it => [it.id, st.seen[it.id] || at]));
  st.items = items.map(it => ({ ...it, found: st.seen[it.id] }));
  for (const [id, t] of Object.entries(st.dismissed)) if (now - Date.parse(t) >= JANITOR.dismissDays * DAY) delete st.dismissed[id];
  st.lastRound = at;
  writeJanitor(store, st);
  const did = [];
  if (auto ?? cfg.auto) {
    // one pull request at a time: a second is put up when the first is merged or closed, so a team is never handed a pile
    let prOpen = changeHistory(store, { now }).some(e => !e.revertedAt && (e.attention === 'pr' || e.attention === 'running'));
    for (const it of janitorInbox(store, { now }).items) {
      if (!it.auto) continue;
      if (it.kind === 'pr') { if (prOpen) continue; prOpen = true; }
      const r = await janitorDo(store, it.id, { now, by: 'janitor', fns });
      if (!r.error) did.push({ id: it.id, said: r.said });
    }
  }
  const open = janitorInbox(store, { now }).items;
  store.log({ op: 'janitor', found: open.length, did: did.length, auto: Boolean(auto ?? cfg.auto), chores: Object.fromEntries(CHORES.map(c => [c.id, open.filter(i => i.chore === c.id).length]).filter(([, n]) => n)), ...(errors.length ? { errors: errors.length } : {}) });
  return { found: open.length, did, errors };
}

// --- the inbox -----------------------------------------------------------------------------------------------
const ORDER = { wait: 0, pr: 1, do: 2, note: 3 };
// what waits on the person first, then proposals, cleanups and notes; within a kind the chores in their own order
// (a sweep before a switch), then the costliest, then the newest
const choreAt = it => { const i = CHORES.findIndex(c => c.id === it.chore); return i < 0 ? CHORES.length : i; };
const byOrder = (a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || choreAt(a) - choreAt(b) || (b.rank || 0) - (a.rank || 0) || String(b.found || '').localeCompare(String(a.found || ''));
// What needs the person now: the last round's finds that still hold and were not left alone, with what earlier
// actions are waiting on, in the order they matter. Numbered, as the command names them.
export function janitorInbox(store, { now = Date.now() } = {}) {
  const st = readJanitor(store);
  let decided = new Set(); try { decided = decidedKeys(store, { now }); } catch {}
  const items = [];
  for (const c of CHORES) { if (c.live) { try { items.push(...c.live(store, { now })); } catch {} } }
  for (const it of st.items) {
    const c = choreOf(it.chore); if (!c) continue;
    let cur = it; try { if (c.still) cur = c.still(store, it, { decided, now }); } catch { cur = it; }
    if (cur) items.push(cur);
  }
  const open = items.filter(it => !st.dismissed[it.id] || now - Date.parse(st.dismissed[it.id]) >= JANITOR.dismissDays * DAY);
  open.sort(byOrder);
  return { lastRound: st.lastRound, items: open.map((it, i) => ({ ...it, n: i + 1 })) };
}
// an item by its number in the inbox or by its id
function itemOf(store, ref, now) {
  const { items } = janitorInbox(store, { now });
  return items.find(it => it.id === ref || String(it.n) === String(ref)) || null;
}
const forget = (st, id) => { st.items = st.items.filter(it => it.id !== id); };

// Do what an item offers. `by`: the person (`you`) or a round acting on its own (`janitor`). What was done is kept
// for the feed with its undo, except where the chore keeps the decision itself (a context change: Recent activity).
export async function janitorDo(store, ref, { now = Date.now(), by = 'you', fns = {}, pr } = {}) {
  const it = itemOf(store, ref, now);
  if (!it) return { error: `nothing in the inbox is ${ref}; \`thinker janitor\` lists it` };
  const c = choreOf(it.chore);
  if (!it.action || !c?.act) return { error: `${it.title}: there is nothing to do about it from here${it.link ? ` (${it.link.url})` : ''}` };
  let r; try { r = await c.act(store, it, { now, fns, pr }); } catch (e) { r = { error: short(e.message || e, 200) }; }
  if (r.error) return { error: r.error, item: it.id };
  const st = readJanitor(store);
  forget(st, it.id);
  const entry = { id: randomBytes(5).toString('hex'), at: new Date(now).toISOString(), item: it.id, chore: it.chore, title: it.title, said: r.said, by, ...(r.undo ? { undo: r.undo } : {}), ...(r.kept ? { kept: true } : {}) };
  st.done.push(entry);
  writeJanitor(store, st);
  store.log({ op: 'janitor-do', chore: it.chore, kind: it.kind, by });
  return { said: r.said, done: entry.id };
}
// Leave an item alone: it stays away a week (a context change is left alone in its own history, as on Find Savings).
export function janitorDismiss(store, ref, { now = Date.now(), fns = {} } = {}) {
  const it = itemOf(store, ref, now);
  if (!it) return { error: `nothing in the inbox is ${ref}; \`thinker janitor\` lists it` };
  const c = choreOf(it.chore), st = readJanitor(store);
  let kept = false; try { kept = Boolean(c?.dismiss?.(store, it, { now, fns })?.kept); } catch {}
  st.dismissed[it.id] = new Date(now).toISOString();
  if (kept) forget(st, it.id);
  writeJanitor(store, st);
  store.log({ op: 'janitor-dismiss', chore: it.chore, kind: it.kind });
  return { said: `${it.title}: left alone${it.kind === 'wait' ? '' : `; it may come back in ${plural(JANITOR.dismissDays, 'day')}`}` };
}
// Take back something the janitor did, by the id the feed carries.
export function janitorUndo(store, id, { now = Date.now() } = {}) {
  const st = readJanitor(store), e = st.done.find(d => d.id === id);
  if (!e) return { error: 'no such action' };
  if (e.undoneAt) return { error: 'already taken back' };
  const c = choreOf(e.chore);
  if (!e.undo || !c?.undo) return { error: e.kept ? 'this one is taken back under Recent activity (`thinker context --revert`)' : 'this one cannot be taken back' };
  let r; try { r = c.undo(store, e.undo); } catch (err) { r = { error: short(err.message || err, 200) }; }
  if (r.error) return { error: r.error };
  e.undoneAt = new Date(now).toISOString();
  writeJanitor(store, st);
  store.log({ op: 'janitor-undo', chore: e.chore });
  return { said: r.said };
}

// --- the feed ------------------------------------------------------------------------------------------------
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// What was done, newest first, in the janitor's own words: its actions, the decisions and pull requests that
// followed, and the offline work of each day (the sessions read, the profile tidied, the state thrown out).
export function janitorFeed(store, { now = Date.now(), days = JANITOR.feedDays, log } = {}) {
  const since = now - days * DAY, out = [];
  for (const d of readJanitor(store).done) {
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
    const by = e.via === VIA.janitor ? 'janitor' : 'you';
    const line = e.running ? `Working on it now: ${what}` : e.failed ? `Could not change ${what}: ${short(e.job?.error, 100)}`
      : e.pr ? `${e.pr.state === 'merged' ? `PR #${e.pr.number} merged` : e.pr.state === 'closed' ? `PR #${e.pr.number} was closed without merging` : `Put up PR #${e.pr.number}`}: ${what}`
      : `${what}: ${e.result || e.decision}`;
    // `shared`: a decision for the whole machine is in every repository's history, and is one line when they are read together
    out.push({ at, kind: e.pr ? 'pr' : 'change', text: line, by, ...(e.pr?.url ? { url: e.pr.url } : {}), ...(e.revertedAt ? { undone: true } : {}), ...(e.scope === 'machine' ? { shared: e.id } : {}) });
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
    if (g.kind === 'read') out.push({ at: g.at, kind: 'read', text: `Read ${plural(g.n, 'session')}${g.a ? ` and noted ${plural(g.a, 'thing')} about how you work` : '; nothing new to note'}`, by: 'janitor' });
    else if (g.kind === 'profile' && g.a + g.b + g.c) out.push({ at: g.at, kind: 'profile', text: `Tidied your profile: ${[g.a ? `${plural(g.a, 'line')} added` : '', g.b ? `${g.b} reworded` : '', g.c ? `${g.c} dropped` : ''].filter(Boolean).join(', ')}`, by: 'janitor' });
    else if (g.kind === 'pruned') out.push({ at: g.at, kind: 'pruned', text: `Threw out ${plural(g.n, 'stale state file')}`, by: 'janitor' });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, JANITOR.feedMax);
}

// --- what both doors read ------------------------------------------------------------------------------------
// One line on how things stand, in the janitor's voice.
export function mood({ enabled, lastRound, items }) {
  if (!enabled) return 'The janitor is off here (janitor in .thinker/config.json).';
  const mine = items.filter(i => i.kind !== 'note').length, notes = items.length - mine;
  if (!lastRound && !items.length) return 'Not been round yet.';
  if (!items.length) return 'All clean. Nothing needs you.';
  return [mine ? `${plural(mine, 'thing')} for you` : '', notes ? plural(notes, 'heads-up') : ''].filter(Boolean).join(', ') + '.';
}
export function janitorView(store, { now = Date.now(), log } = {}) {
  const cfg = janitorConfig(store), inbox = cfg.enabled ? janitorInbox(store, { now }) : { lastRound: readJanitor(store).lastRound, items: [] };
  const feed = janitorFeed(store, { now, log });
  const v = { enabled: cfg.enabled, auto: cfg.auto, lastRound: inbox.lastRound, items: inbox.items, feed, attention: inbox.items.filter(i => i.kind !== 'note').length };
  return { ...v, mood: mood(v) };
}
// Every repository's view as one (the page's All repositories): each item and line says whose it is, the inbox is
// numbered again, and the last round is the oldest one, since that is how stale the list can be.
export function mergeJanitorViews(pairs) {
  const items = [], feed = [], rounds = [], shared = new Map(), said = new Set();
  for (const { repo, name, view } of pairs) {
    if (!view) continue;
    for (const i of view.items) {
      // a tool is switched for the whole machine, so the same tool found in three repositories is one item: the
      // costliest of them, said once, and doing it from any one of them does it for all (context-suggest.js)
      if (i.machine) { const g = shared.get(i.id) || { n: 0, top: null }; g.n++; if (!g.top || (i.rank || 0) > (g.top.rank || 0)) g.top = { ...i, repo, repoName: name }; shared.set(i.id, g); }
      else items.push({ ...i, repo, repoName: name });
    }
    for (const f of view.feed) { if (f.shared) { if (said.has(f.shared)) continue; said.add(f.shared); feed.push({ ...f, repo, repoName: 'All repositories' }); } else feed.push({ ...f, repo, repoName: name }); }
    if (view.enabled) rounds.push(view.lastRound);
  }
  for (const g of shared.values()) items.push(g.n > 1 ? { ...g.top, repoName: `${g.n} repositories`, detail: `${g.top.detail} The figure is the costliest of the ${g.n} repositories it is loaded in.` } : g.top);
  items.sort(byOrder);
  feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const enabled = pairs.some(p => p.view?.enabled), lastRound = rounds.length && rounds.every(Boolean) ? rounds.sort()[0] : null;
  const v = { enabled, auto: pairs.length > 0 && pairs.every(p => p.view?.auto), lastRound, items: items.map((i, n) => ({ ...i, n: n + 1 })), feed: feed.slice(0, JANITOR.feedMax), attention: items.filter(i => i.kind !== 'note').length };
  return { ...v, mood: mood(v) };
}

// --- the command's page --------------------------------------------------------------------------------------
export const ago = (t, now = Date.now()) => { if (!t) return 'never'; const m = Math.max(0, Math.round((now - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const when = (t, now) => { const d = new Date(t), today = dayKey(now) === dayKey(t), time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return today ? `today ${time}` : dayKey(now - DAY) === dayKey(t) ? `yesterday ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`; };
export function renderJanitor(v, { now = Date.now(), feed = 12 } = {}) {
  const out = [`🧹 The janitor · last round ${ago(v.lastRound, now)}${v.auto ? ' · acting on its own (auto)' : ''}`, `   ${v.mood}`, ''];
  if (v.items.length) {
    out.push(`For you (${v.items.length})`);
    for (const it of v.items) {
      out.push(`  ${String(it.n).padStart(2)}  ${it.title}${it.repoName ? ` · ${it.repoName}` : ''}`);
      if (it.detail) out.push(`      ${it.detail}`);
      for (const l of it.lines || []) out.push(`        - ${l}`);
      out.push(`      ${it.action ? `thinker janitor do ${it.n}   (${it.action.label})` : it.link ? it.link.url : 'a note: nothing to run'}   ·   thinker janitor leave ${it.n}`);
    }
    out.push('');
  }
  if (v.feed.length) {
    out.push('Done lately');
    for (const f of v.feed.slice(0, feed)) out.push(`  ${when(f.at, now).padEnd(15)}  ${f.text}${f.by === 'janitor' && (f.kind === 'did' || f.kind === 'pr' || f.kind === 'change') ? ' (on its own)' : ''}${f.undone ? ' (taken back)' : ''}${f.undo ? `   · thinker janitor undo ${f.undo}` : ''}${f.repoName ? ` · ${f.repoName}` : ''}`);
    if (v.feed.length > feed) out.push(`  and ${v.feed.length - feed} more (--all)`);
  }
  return out;
}
