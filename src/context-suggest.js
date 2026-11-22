import { readScopedState, writeScopedState, machineUndoDir } from './scoped-state.js';
// The changes the Context view finds to what loads into every prompt (context-view.js), each with a suggested action,
// and the decisions on them. Every part of the context with the actions that can be taken on it is `allChanges`: a
// section compressed or removed, a skill or tool switched off or back on; every decision is kept as Recent activity
// with its undo. Thinker makes the ones that clearly pay by itself, in batches (upkeep.js, the door `thinker`);
// `thinker context --approve|--dismiss|--history` is the person's own door over the top five.
// Ranking makes no model call; compressing a section does, and that call happens in a job of its own whichever door
// the decision came through (approveChanges), so nothing waits it out or writes the file without a pull request.
//
//   topChanges                    the ranking (context-view.js keeps it on the report)
//   allChanges                    every part as a change with its options, whatever its waste
//   currentChanges                the largest not dismissed or decided lately: the command's five, a batch's twenty
//   approveChanges, dismissChanges, revertDecision   the decisions, kept as the history (changeHistory), and taken back
//   startSectionJob, runSectionJob, retryJob   a section's change as a job in the background: recorded at once, made by
//                                    `thinker instructions … --job`, a pull request when done (instruction-pr.js) or failed
//   refreshPrStates               a pull request's state followed: open is pending, merged done, closed without merging rejected
//                                    and suggested again; a merged one that this checkout has not pulled is `unpulled`
//                                    (changeHistory, with `pullFrom`, the branch to pull): its section is not suggested
//                                    again, and Recent activity says to pull and tints the decisions waiting on it
//
// Until 2026-11-21 the top five were also put to the person once a week as a question in their session, and before
// that on the page's Find Savings tab; both went when the owner had thinker make these decisions itself (see "The
// weekly question, retired" below).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { thinkerHome } from './update.js';
import { isTestMode } from './test-mode.js';
import { formatTokens } from './model-usage.js';
import { sections, sectionId } from './instruction-value.js';
import { describePart, describeEntry } from './part-describe.js';
import { defaultBranch, prAvailable } from './instruction-pr.js';

export const SUGGEST = {
  max: 5,
  days: 7,            // the window the changes are ranked and their totals counted over
  minSaving: 15,      // a change saving fewer input tokens on an average prompt is not worth a line (500 a session
                      // until 2026-10-25, when the unit became a prompt: about 15 of them at this machine's median calls)
  // How long a dismissal holds (2026-11-04, the owner's call: a month was too long): under a week, so a change left
  // alone is listed again within the week, and not 0, or `thinker context` typed an hour after a dismissal would print
  // what was just dismissed.
  dismissedDays: 6,
};
const DAY = 86_400_000;
const DECIDED_DAYS = 30; // a change approved is not suggested again for this long (a dismissal: SUGGEST.dismissedDays)
const HISTORY_KEPT = 200;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateFile = store => path.join(store.dir, 'state', 'context-suggest.json');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.thinker-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(v) + '\n'); fs.renameSync(tmp, f); };
// What can be done with each kind of change, the suggested action first. One level of compression, so the person is
// not asked to choose one nothing has measured against the other: a section as the Context tab compresses it (high,
// instruction-edit.js). A tool's output is not here at all: the clearing compresses those, on by default and asked
// about nowhere (partChanges).
export const ACTS = {
  compress: { act: 'compress', text: 'Compress' },
  remove: { act: 'remove', text: 'Remove' },
  off: { act: 'off', text: 'Switch off' },
  // a built-in tool is not switched off (2026-11-06, tool-stubs.js): a tool reference is created, its definition is looked
  // up when needed, and the tool stays callable. The same `act`, since the switch and its undo are the same.
  ref: { act: 'off', text: 'Create tool reference' },
  on: { act: 'on', text: 'Turn back on' },
};
const flagged = r => !r.off && (r.waste === 'high' || r.waste === 'medium') && r.wasted > 0;

// Every change the report flags, by what it saves over the window, the five largest. A section, skill or tool is flagged
// when its cost in the sessions that did not use it is a share of its kind's (instruction-value.js:wasteLevel), and saves
// at most its cost in the sessions that did not use it.
export function topChanges(view, { max = SUGGEST.max, minSaving = SUGGEST.minSaving } = {}) {
  return partChanges(view).filter(c => c.saving >= minSaving).sort((a, b) => b.total - a.total || b.saving - a.saving).slice(0, max);
}
// Every part of the report as a change with what can be done to it, by its total: the Context tab's rows. A section
// can be compressed or removed; a skill or tool switched off, or back on when thinker switched it off. Nothing is
// filtered by waste.
export function allChanges(view) {
  return partChanges(view, { all: true }).sort((a, b) => b.total - a.total || b.saving - a.saving);
}
function partChanges(view, { all = false } = {}) {
  const out = [], take = r => all || flagged(r);
  for (const s of view.instructions?.sections || []) if (take(s)) out.push({
    kind: 'section', view: 'instructions', waste: s.waste, key: `section:${s.file}:${s.id}`, id: s.id, file: s.file, repo: s.repo,
    title: `${s.file} · ${s.parent ? `${s.parent}: ` : ''}${s.title}`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1500),
    why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : 'rarely acted on'}; ~${formatTokens(s.tokens)} tokens in every model call`,
    action: 'compress or remove the section', sessions: view.instructions?.sessions || 0, prompts: s.prompts || 0, usedShare: s.usedShare ?? null, options: [ACTS.compress, ACTS.remove], ...describePart({ kind: 'section', text: s.text }),
  });
  // a skill or tool thinker switched off has one action, back on (by the key the switch-off kept); one nothing switches
  // off has none
  const switchOpts = s => s.off ? [ACTS.on] : s.label ? [ACTS.off] : [];
  for (const s of view.skills || []) if (take(s)) out.push({
    kind: 'skill', view: 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name} skill`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1200), why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : `opened in ${s.used} of ${s.loaded} sessions`}; its listing is in every one`, action: 'switch it off here',
    sessions: s.loaded || 0, used: s.used ?? null, prompts: s.prompts || 0, options: switchOpts(s), ...describePart({ kind: 'skill', text: s.text }),
  });
  for (const s of view.tools || []) if (take(s)) out.push({
    kind: 'tool', view: s.group === 'builtin' ? 'builtin' : 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name}${s.kind === 'mcp' ? ' MCP server' : s.kind === 'plugin' ? ' plugin' : ' tool'}`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1200),
    why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : `used in ${s.used} of ${s.loaded} sessions`}; ~${formatTokens(s.tokens)} tokens in every model call`, action: s.group === 'builtin' ? 'create a tool reference; the tool can still be used' : 'switch it off here',
    // `used`: the sessions that called it, of the `sessions` that loaded it (upkeep.js judges a tool's use by them)
    builtin: s.group === 'builtin', sessions: s.loaded || 0, used: s.used ?? null, prompts: s.prompts || 0, options: s.group === 'builtin' && !s.off && s.label ? [ACTS.ref] : switchOpts(s), ...describePart({ kind: 'tool', name: s.name, builtin: s.group === 'builtin', toolKind: s.kind, text: s.text }),
  });
  // A tool's output is not a change anyone is offered (2026-11-04, the owner's call). The clearing is thinker's
  // compression and it is on by default (cutting.js, applied by proxy.js on every request): it takes out the results
  // the agent is done with, which is where the cost is -- 88% of what output costs a session is re-reads past the
  // agent's last use of the result (tool-outputs.js). Per-tool compression (diet.js) only shrinks what is still live:
  // the moderate cap took 7.5% of output cost over this machine's 38 most recent sessions, and the one arm measured in
  // agent sessions (a 4k cap on PostHog/Opus, 2026-10-28) saved nothing at all, because an agent fetches again what
  // was trimmed. So a row asking a person to choose it cost them a decision and bought what the clearing already has.
  // The diet stays as a command-line switch for an experiment arm (`thinker context --output-compression <tools>`);
  // what outputs cost is still measured and reported (context-view.js, the Report's parts table), just never asked
  // about. The tool outputs the page listed were also the thinnest question thinker ever put to anyone: on 2026-11-04
  // a desktop session was interrupted mid-answer with "1 -- compress repeated tool output, or none?".
  // the first option is the suggestion; `total` is what it could have saved over the report's window, and it is the
  // row's own figure (instruction-value.js, context-view.js: `wastedWindow`, an output's `saveModerateWindow`) -- its
  // size in every model call that carried it, times the share of prompts that did not need it. Not recomputed from
  // `saving`: that is already the window cost over *every* prompt of the window (`perPrompt`), so multiplying it by the
  // calls that carried this part divided by denom again, and a part carried by half the window's calls read half what
  // its own row showed (Artifact on this machine: 37M against the table's 68M). One figure, counted once.
  return out.map(c => ({ ...c, saving: c.saving || 0, default: c.options[0] || null,
    total: c.windowSaving ?? (c.saving || 0) * (c.prompts || c.sessions), days: view.days }));
}


// The decisions on the changes (<cache>/state/context-suggest.json `history`, newest first): approved (its suggested
// action made), applied after review, or dismissed, with what came of it.
const readState = store => readScopedState(stateFile(store), 'history');
const writeState = (store, state) => writeScopedState(stateFile(store), 'history', state);
// each entry with an id (entries written before ids are given one, once) and whether Revert can take it back; an entry
// made a pull request carries `pr` {number, url, branch, state, openedAt, at} and is `pending` while the pull request
// is open, `rejected` once it was closed without merging (refreshPrStates keeps the state). An entry a background job
// is making (startSectionJob) carries `job` {state: running | done | failed, pid, startedAt, finishedAt, error} and is
// `running` or `failed` (then `retryable`); a running job whose process is gone is marked failed here, once.
// `attention` names what is not complete: a job running or failed, a pull request not merged; Recent activity counts them.
// `git` answers whether a commit is in this checkout (inCheckout); tests pass their own.
export function changeHistory(store, { now = Date.now(), git = isAncestor } = {}) {
  const st = readState(store), h = st.history || [];
  let dirty = h.some(e => !e.id);
  const unpulled = new Set();
  for (const e of h) {
    e.id ||= randomBytes(6).toString('hex');
    if (e.job?.state === 'running' && jobDied(e.job, now)) { e.job = { ...e.job, state: 'failed', error: e.job.pid ? 'the process ended before it finished' : 'the process did not start', finishedAt: new Date(now).toISOString() }; dirty = true; }
    // a merged pull request this checkout has not pulled: the section is still in the file here, and its row would come
    // back as a suggestion (2026-10-25: two sections removed by a merged pull request were offered again on the page of the
    // checkout that had not pulled main). Asked until the merge is seen here once, then kept (`pulledAt`). `pullFrom` is
    // the branch to pull: the pull request's base, else the repository's default branch (main, master or whatever origin
    // names), for the banner on Recent activity.
    if (e.pr?.state === 'merged' && e.kind === 'section' && !e.revertedAt && !e.pr.pulledAt && now - Date.parse(e.pr.at || e.at) < DECIDED_DAYS * DAY) {
      const here = inCheckout(store, e, git);
      if (here === true) { e.pr.pulledAt = new Date(now).toISOString(); dirty = true; }
      else if (here === false) unpulled.add(e);
    }
  }
  if (dirty) writeState(store, st);
  const pullFrom = unpulled.size ? (defaultBranch(store.repo) || 'main') : null;
  return (h.some(e => e.scope === 'machine') ? h.sort((a, b) => b.at.localeCompare(a.at)) : h).map(e => {
    const running = e.job?.state === 'running', failed = e.job?.state === 'failed', pending = e.pr?.state === 'open';
    // what the part is and does (part-describe.js), worked out for an entry written before they were kept
    return { ...e, ...describeEntry(e), revertible: !e.revertedAt && !running && !failed && Boolean(undoOf(store, e)), ...(e.pr ? { pending, rejected: e.pr.state === 'closed', ...(unpulled.has(e) ? { unpulled: true, pullFrom: e.pr.base || pullFrom } : {}) } : {}), ...(e.job ? { running, failed, retryable: failed && !e.revertedAt } : {}), attention: running ? 'running' : failed && !e.revertedAt ? 'failed' : pending ? 'pr' : null };
  });
}
// Whether this checkout has a merged section change: by the merge commit GitHub named (prState), an ancestor of HEAD or not;
// for an entry from before the commit was kept, a removal is here once the section is gone from the file in the working
// tree, and a compression cannot be told (null: not marked). null too when git cannot answer.
const isAncestor = (repo, commit) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repo, stdio: 'ignore', timeout: 5000 }); return true; }
  catch (err) { return err?.status === 1 ? false : null; }
};
function inCheckout(store, e, git) {
  if (e.pr.mergeCommit) return git(store.repo, e.pr.mergeCommit);
  const act = e.act || e.job?.action, m = /^section:(.+):([^:]+)$/.exec(e.key || '');
  if (act !== 'remove' || !m) return null;
  const [, file, id] = m;
  let text; try { text = fs.readFileSync(path.join(store.repo, file), 'utf8'); } catch { return true; }
  const f = { file, kind: file.includes('/') ? 'nested' : 'root' };
  return !sections(text).some(s => sectionId(f, s).toLowerCase() === id.toLowerCase());
}
// a job is dead when its process is gone, or it never recorded one in JOB_START_MS (the spawn failed)
const JOB_START_MS = 2 * 60_000;
const jobDied = (job, now) => job.pid ? !alive(job.pid) : now - Date.parse(job.startedAt) > JOB_START_MS;
// The open pull requests asked after on GitHub (instruction-pr.js:prState), at most every PR_CHECK_MS each: merged or
// closed is kept with when. Returns how many changed state. A pull request GitHub cannot be asked about keeps its state.
export const PR_CHECK_MS = 60_000;
export async function refreshPrStates(store, { now = Date.now(), prs, force = false } = {}) {
  const due = e => force || !e.pr.checkedAt || now - Date.parse(e.pr.checkedAt) >= PR_CHECK_MS;
  // a merged entry from before the merge commit was kept is asked once more for it (changeHistory tells `unpulled` by it)
  const st = readState(store), open = (st.history || []).filter(e => e.pr && due(e) && (e.pr.state === 'open' || (e.pr.state === 'merged' && e.pr.mergeCommit === undefined && e.kind === 'section' && now - Date.parse(e.pr.at || e.at) < DECIDED_DAYS * DAY)));
  if (!open.length) return 0;
  const { prState } = prs || await import('./instruction-pr.js');
  let changed = 0;
  // the sections of one pull request are an entry each: GitHub is asked about the pull request once, every entry follows
  const asked = new Map();
  for (const e of open) {
    e.pr.checkedAt = new Date(now).toISOString();
    if (!asked.has(e.pr.number)) asked.set(e.pr.number, prState(store.repo, e.pr.number));
    const r = asked.get(e.pr.number);
    if (e.pr.state === 'merged') { if (r) e.pr.mergeCommit = r.commit || null; continue; } // asked once it answers: null says GitHub named no commit
    if (!r || r.state === 'open') continue;
    e.pr.state = r.state; e.pr.at = r.at || e.pr.checkedAt; if (r.url) e.pr.url = r.url; if (r.state === 'merged') e.pr.mergeCommit = r.commit || null;
    e.result = r.state === 'merged' ? `Pull request #${e.pr.number} merged` : `Pull request #${e.pr.number} closed without merging: suggested again`;
    changed++;
    store.log({ op: 'context-pr', pr: e.pr.number, state: r.state });
  }
  writeState(store, st);
  return changed;
}
function record(store, entries) {
  const st = readState(store);
  const all = [...entries, ...(st.history || [])];
  st.history = [...all.filter(e => e.scope !== 'machine').slice(0, HISTORY_KEPT), ...all.filter(e => e.scope === 'machine').sort((a, b) => b.at.localeCompare(a.at)).slice(0, HISTORY_KEPT)];
  writeState(store, st);
}
// what a decision undoes by, kept beside the history (a section's text before and after can be large); a switch-off or
// compression approved before these were kept is undone by its key. Sections written by one edit are one entry each
// (the person reads them as separate line items) sharing one undo, under the edit's `group` id: reverting any of them
// reverts the edit, and every entry of the group with it (revertDecision)
const undoFile = (store, id) => path.join(id.startsWith('machine-') ? machineUndoDir() : path.join(store.dir, 'state', 'context-suggest-undo'), `${id}.json`);
const undoOf = (store, e) => e.decision === 'dismissed' ? { kind: 'dismissed' } : e.pr ? (e.pr.state === 'open' ? { kind: 'pr', number: e.pr.number, branch: e.pr.branch } : e.pr.state === 'merged' ? { kind: 'revert-pr', number: e.pr.number, mergeCommit: e.pr.mergeCommit || null, base: e.pr.base || null } : null) : (e.id && readJson(undoFile(store, e.group || e.id)))
  || (e.decision === 'approved' && (e.kind === 'tool' || e.kind === 'skill') ? { kind: 'off', key: e.key.replace(/^[^:]+:/, '') }
    : e.decision === 'approved' && e.kind === 'output' ? { kind: 'output', name: e.key.replace(/^output:/, '') } : null);
// Where a decision was taken (`via`, on the log event and the history entry), so the funnel from a suggestion to a
// change can be read end to end: `session` is the weekly suggestion approved in the conversation it was passed on in
// (the command the offer text tells the agent to run), `page` was the page's Find Savings tab (removed 2026-11-21), `setup` the install's multi-select, and
// `command` someone typing `thinker context --approve` themselves. VIA.session is what says whether a suggestion
// converted; `page` is what says a person went to the dashboard and acted there.
// `thinker`: through upkeep.js -- thinker acting by itself at a check, or the person saying so in Recent activity or the chat
export const VIA = { session: 'session', page: 'page', setup: 'setup', command: 'command', thinker: 'thinker' };
const viaOf = v => VIA[String(v)] || VIA.command;
const entryOf = (store, c, decision, result, now, undo, { group = null, tokens = null, via = null, batch = null } = {}) => {
  const id = (c.scope === 'machine' ? 'machine-' : '') + randomBytes(6).toString('hex');
  if (undo && !group) writeJson(undoFile(store, id), undo);
  return { id, ...(c.scope === 'machine' ? { scope: 'machine' } : {}), ...(group ? { group } : {}), ...(batch ? { batch } : {}), at: new Date(now).toISOString(), ...(via ? { via } : {}), key: c.key, ...(c.keys ? { keys: c.keys } : {}), kind: c.kind, title: c.title, ...(c.what ? { what: c.what } : {}), ...(c.about ? { about: c.about } : {}), ...(c.kind === 'section' && c.file ? { file: c.file } : {}), ...(tokens ? { tokens } : {}), saving: c.saving, total: c.total, days: c.days ?? null, action: c.default?.text || null, act: c.default?.act || null, decision, result: result || null, ...(undo ? { revertible: true } : {}) };
};
// a section's tokens before and after its edit (instruction-edit.js:previewEdit `sections`), kept on the entry so the
// Report can cost the section a session on each side (accountant.js:actionEffect)
export const sectionTokens = (p, id) => { const x = (p?.sections || []).find(s => s.id === id) || (p?.sections?.length === 1 ? p.sections[0] : null); return x ? { before: x.tokensBefore, after: x.tokensAfter } : p && p.tokensBefore != null ? { before: p.tokensBefore, after: p.tokensAfter } : null; };
// the entries of one edit over several sections: one per section, each with its own title and saving, sharing the
// group id their undo is kept under (written once, here) and, for a pull request, the pull request
const entriesOf = (store, changes, decision, result, now, undo) => {
  if (changes.length === 1) return [entryOf(store, changes[0], decision, result, now, undo)];
  const group = randomBytes(6).toString('hex');
  if (undo) writeJson(undoFile(store, group), undo);
  return changes.map(c => entryOf(store, c, decision, result, now, undo, { group }));
};
// The view's changes less the ones lately decided (a dismissal holds a week, an action a month), the five largest:
// what the page, the session's summary
// and `thinker context` offer
export function currentChanges(store, view, { now = Date.now(), max = SUGGEST.max } = {}) {
  const decided = decidedKeys(store, { now });
  return (view.suggestions || topChanges(view, { max: 20 })).filter(c => !decided.has(c.key)).slice(0, max);
}
// The keys of the changes lately decided, through any door: what is no longer open (upkeep.js reads it too).
export function decidedKeys(store, { now = Date.now() } = {}) {
  // a dismissal taken back makes its change a suggestion again, and so does a pull request closed without merging:
  // nothing was followed through on
  // a job that failed decided nothing either
  // A change left alone is offered again in the next weekly summary (`SUGGEST.dismissedDays`); one that was acted on
  // waits a month, since what was done to it has to have time to show in the figures.
  const held = h => (h.decision === 'dismissed' ? SUGGEST.dismissedDays : DECIDED_DAYS) * DAY;
  return new Set(changeHistory(store, { now }).filter(h => now - Date.parse(h.at) < held(h) && !(h.decision === 'dismissed' && h.revertedAt) && !h.rejected && !h.failed).flatMap(h => h.keys || [h.key]));
}
export function dismissChanges(store, changes, { now = Date.now(), via = VIA.command } = {}) {
  record(store, changes.map(c => entryOf(store, c, 'dismissed', null, now, null, { via: viaOf(via) })));
  store.log({ op: 'context-dismiss', changes: changes.length, via: viaOf(via) });
  return changes.map(c => `${c.title}: left alone; suggested again next week`);
}
// a section compressed on the page after its diff was read: the edit applied there, recorded here
export function recordReviewed(store, change, result, { now = Date.now(), undo = null } = {}) { record(store, [entryOf(store, change, 'applied after review', result, now, undo)]); }

// The page's Apply on sections (ui/server.js /api/changes/start) is a job in the background, since 2026-10-24 (the
// owner's ask: a model call of some seconds is nothing to hold the person's attention with). The decision is recorded
// at once, a row per section sharing one `group` with `job: {state: 'running'}`, and the command the person would have
// typed is started detached: `thinker instructions --compress|--remove <ids> --pr --job <group>` (--apply where no pull
// request can be opened here: instruction-pr.js:prAvailable). The command runs runSectionJob: the model compresses, the
// change becomes a pull request (instruction-pr.js:openEditPr), recorded on every entry of the group and pending until
// it is merged (rejected if closed, Close PR its revert), or is written to the working tree with the files as they were,
// so Revert writes them back; a failure is recorded as such with its reason, and Retry (retryJob) runs the same command
// again. Recent activity shows the job under way, failed or pending, and counts them for the badge. Several sections
// applied together are one job, one pull request, one undo, and a line each (the owner's ask, 2026-10-24: no actions
// bundled into one row): reverting any one of them puts the whole file back, or closes the pull request, and marks the
// others reverted with it.
// The command a job is: each list by its action, so a change that shortens some sections and removes others is one run.
const SECTION_ACTS = ['compress', 'remove'];
const jobArgs = (cliPath, ids, pr, group) => [cliPath, 'instructions', ...SECTION_ACTS.flatMap(a => (ids[a]?.length ? [`--${a}`, ids[a].join(',')] : [])), pr ? '--pr' : '--apply', '--job', group];
// `action`: compress or remove for every section given, or `each` -- every section by its own suggested action, so a
// batch of thinker's own is one job and one pull request whatever it holds (upkeep.js). `batch`: that batch's id, kept
// on every entry.
export function startSectionJob(store, changes, action, { pr = false, now = Date.now(), spawnFn = spawn, cliPath = CLI, via = VIA.page, batch = null } = {}) {
  const actOf = c => (action === 'each' ? c.default?.act : action);
  changes = changes.filter(c => SECTION_ACTS.includes(actOf(c)));
  const ids = Object.fromEntries(SECTION_ACTS.map(a => [a, [...new Set(changes.filter(c => actOf(c) === a).map(c => c.id).filter(Boolean))]]));
  const n = ids.compress.length + ids.remove.length;
  if (!n) return { error: 'no section to change' };
  const group = randomBytes(6).toString('hex'), at = new Date(now).toISOString();
  const es = changes.map(c => ({ ...entryOf(store, { ...c, default: ACTS[actOf(c)] }, pr ? 'pull request' : 'applied', null, now, null, { group, via: viaOf(via), batch }), section: c.id, file: c.file, job: { state: 'running', action: actOf(c), pr, startedAt: at, pid: null, via: viaOf(via) } }));
  record(store, es);
  let pid = null;
  try { const child = spawnFn(process.execPath, jobArgs(cliPath, ids, pr, group), { cwd: store.repo, detached: true, stdio: 'ignore' }); child.on?.('error', () => {}); child.unref?.(); pid = child.pid || null; }
  catch (e) { finishJob(store, group, j => ({ ...j, state: 'failed', error: `could not start: ${String(e.message || e).split('\n')[0]}`, finishedAt: at })); return { error: 'could not start the change', group }; }
  finishJob(store, group, j => ({ ...j, pid }));
  const did = ids.compress.length && ids.remove.length ? 'each' : ids.remove.length ? 'remove' : 'compress';
  store.log({ op: 'context-job', group, action: did, sections: n, pr, state: 'started', via: viaOf(via) });
  const word = `${n} section${n === 1 ? '' : 's'}`;
  return { group, said: did !== 'remove' ? `${did === 'each' ? 'Compressing or removing' : 'Compressing'} ${word} in the background: ${pr ? 'a pull request opens with the change when the model is done' : 'the file in your working tree is rewritten when the model is done'}. Follow it under Recent activity.` : `Removing ${word}: ${pr ? 'a pull request opens with the change in a moment' : 'written to your working tree in a moment'}. Follow it under Recent activity.` };
}
// every entry of the job rewritten by `fn` over its `job`, and `also` over the entry, from the state as it is now
function finishJob(store, group, fn, also) {
  const st = readState(store), es = (st.history || []).filter(e => e.group === group && e.job);
  for (const e of es) { e.job = fn(e.job); also?.(e); }
  writeState(store, st);
  return es;
}
// the command's side (`thinker instructions … --job <group>`): the change made and the job's entries finished
export async function runSectionJob(store, { group, ids, action, pr = false }, { now, edit, prs } = {}) {
  const es = readState(store).history?.filter(e => e.group === group && e.job) || [];
  if (!es.length) return { error: `no job ${group} here` };
  ids = ids?.length ? ids : es.map(e => e.section).filter(Boolean);
  // a compression takes seconds: the finish is stamped when it comes (a test gives `now`)
  const stamp = () => new Date(now ?? Date.now()).toISOString();
  const fail = error => { finishJob(store, group, j => ({ ...j, state: 'failed', error, finishedAt: stamp() })); store.log({ op: 'context-job', group, action, state: 'failed', error }); return { error }; };
  try {
    const { previewEdit, applyEdit } = edit || await import('./instruction-edit.js');
    // a pull request is made from the base branch's own text (instruction-pr.js:baseTexts), whatever the checkout holds
    const prsMod = pr ? (prs || await import('./instruction-pr.js')) : null;
    const src = prsMod?.baseTexts ? prsMod.baseTexts(store.repo) : null;
    if (src?.error) return fail(src.error);
    // each section by the action its own entry was started with (they differ in a batch of thinker's own)
    const actions = Object.fromEntries(es.filter(e => e.section && e.job?.action).map(e => [e.section, e.job.action]));
    const p = await previewEdit(store, ids, action, { ...(src ? { texts: src.textOf, base: src } : {}), actions });
    if (p.error) return fail(p.error);
    const done = { state: 'done', finishedAt: stamp(), tokens: p.modelTokens || null };
    const saving = es.reduce((s, e) => s + (e.saving || 0), 0);
    if (pr) {
      const r = await prsMod.openEditPr(store, p.key, { changes: es, now: now ?? Date.now() });
      if (r.error) return fail(r.error);
      const prRecord = { number: r.number, url: r.url, branch: r.branch, commit: r.commit, base: r.base, state: 'open', openedAt: done.finishedAt, checkedAt: done.finishedAt };
      finishJob(store, group, j => ({ ...j, ...done }), e => { e.pr = { ...prRecord }; e.decision = 'pull request'; e.result = r.said; e.tokens = sectionTokens(p, e.section) || e.tokens || null; });
      store.log({ op: 'context-approve', changes: es.length, saving, reviewed: true, pr: r.number, group, via: viaOf(es[0]?.job?.via) });
      return { said: r.said, pr: prRecord };
    }
    const read = f => { try { return fs.readFileSync(path.join(store.repo, f), 'utf8'); } catch { return null; } };
    const names = [...new Set((p.files || [p.file]).map(String).filter(Boolean))], before = names.map(read);
    const a = applyEdit(store, p.key);
    if (a.error) return fail(a.error);
    writeJson(undoFile(store, group), { kind: 'edit', files: names.map((f, i) => ({ file: f, before: before[i], after: read(f) })) });
    finishJob(store, group, j => ({ ...j, ...done }), e => { e.decision = 'applied'; e.result = a.said; e.tokens = sectionTokens(p, e.section) || e.tokens || null; });
    store.log({ op: 'context-approve', changes: es.length, saving, reviewed: true, group, via: viaOf(es[0]?.job?.via) });
    return a;
  } catch (err) { return fail(String(err.message || err).split('\n')[0]); }
}
// A failed job run again (the page's Retry, `thinker context --retry <n>`): the same command, the entries running again
export function retryJob(store, id, { now = Date.now(), spawnFn = spawn, cliPath = CLI } = {}) {
  const e = changeHistory(store, { now }).find(h => h.id === id);
  if (!e) return { error: 'no such decision' };
  if (!e.failed) return { error: e.running ? 'still running' : 'nothing to retry' };
  const group = e.group, es = changeHistory(store, { now }).filter(h => h.group === group && h.job);
  const { pr } = e.job, ids = Object.fromEntries(SECTION_ACTS.map(a => [a, es.filter(h => h.section && h.job.action === a).map(h => h.section)]));
  const n = ids.compress.length + ids.remove.length, action = ids.compress.length && ids.remove.length ? 'each' : ids.remove.length ? 'remove' : 'compress';
  const at = new Date(now).toISOString();
  finishJob(store, group, j => ({ state: 'running', action: j.action, pr, startedAt: at, pid: null, tries: (j.tries || 1) + 1 }));
  let pid = null;
  try { const child = spawnFn(process.execPath, jobArgs(cliPath, ids, pr, group), { cwd: store.repo, detached: true, stdio: 'ignore' }); child.on?.('error', () => {}); child.unref?.(); pid = child.pid || null; }
  catch (err) { finishJob(store, group, j => ({ ...j, state: 'failed', error: `could not start: ${String(err.message || err).split('\n')[0]}`, finishedAt: at })); return { error: 'could not start the change' }; }
  finishJob(store, group, j => ({ ...j, pid }));
  store.log({ op: 'context-job', group, action, sections: n, pr, state: 'retried' });
  return { said: `${e.title}: ${action === 'remove' ? 'removing again' : 'compressing again in the background'}${es.length > 1 ? `, with the ${es.length - 1} other section${es.length > 2 ? 's' : ''} of the same change` : ''}` };
}

// The weekly question, retired (2026-11-21, the owner's answer to how a person should hear of a batch: "Recent
// activity plus one line in a session"; "the weekly question that asked you to approve savings is retired, since
// thinker no longer asks"). From 2026-10-22 maintenance kept the five largest changes once a week and the prompt hook
// had the person's own agent ask which to make (scheduleContextSuggestion, contextSuggestOffer, the MCP `context`
// tool's answerContextSuggestion); thinker now makes the ones that clearly pay itself, in batches (upkeep.js), and
// says what it did. The code is in git before this date. `maintain: { contextSuggest }` in a config is ignored.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// where a page started for the machine (`thinker ui --background`, cache.js:uiCommand) keeps its address while it runs
export const uiFile = (home = thinkerHome()) => path.join(home, 'state', 'ui.json');
// The address of the machine's page (`http://127.0.0.1:<port>/`), one started in the background where none runs, or
// null where none could be. A link in something thinker says (update-note.js) has to open when it is clicked, and the
// page is only up while somebody runs `thinker ui`: this is what puts it up. One per machine, reused while it runs,
// gone once nothing has asked it anything for cache.js:UI_IDLE_MS. The weekly question had this until it was retired;
// it came back on 2026-11-22 for the update note's links. Under THINKER_TEST nothing is started unless the test hands
// in its own spawnFn: a suite leaves no server behind.
export const UI_WAIT_MS = 3000;   // how long ensureUi waits for the page it started to say where it is
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function ensureUi(store, { home = thinkerHome(), spawnFn = isTestMode() ? null : spawn, cliPath = CLI, waitMs = UI_WAIT_MS } = {}) {
  const f = uiFile(home), running = () => { const u = readJson(f); return u?.url && u.pid && alive(u.pid) ? u.url : null; };
  const now = running();
  if (now || !spawnFn) return now;
  try {
    const child = spawnFn(process.execPath, [cliPath, 'ui', '--background'], { cwd: store.repo, detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); child.unref?.();
  } catch { return null; }
  for (let t = 0; t < waitMs; t += 100) { sleep(100); const u = running(); if (u) return u; }
  return null;
}

// The person approved these changes (`thinker context --approve 1,3|all`, the page's Approve, the answer to the weekly
// suggestion, the installer's picks): each one's default, made as the Context tab makes it. A skill or tool is switched
// off for this repository, `thinker harness --undo` turning it back on (context-view.js:switchSources). That is a line
// in a config file, so it is made here and done.
//
// A section is neither: it takes a model call to compress and it edits a file people read, so it goes to the background
// as a job and becomes a pull request (startSectionJob), whichever door the person answered through -- the owner's rule
// of 2026-10-24, which until 2026-10-29 only the page kept. Through the other doors a section was compressed inline:
// the agent's own session (the MCP `context` tool), the command and the installer each waited out the model call before
// the person's turn went on -- in a desktop app with no CLI signed in that call queues for a subagent of the very
// session that is blocked on it -- and the rewrite landed in the working tree, uncommitted, with no pull request, no
// Retry and nothing in Recent activity to follow. The job writes the working tree only where no pull request can be
// opened (instruction-pr.js:prAvailable), as the page's Apply does.
//
// A change with no default (nothing switches it off) is left for review on the page. Returns one line per change, and
// one per section job, since a job's sections share a pull request and an undo.
// `batch`: the id of a batch of thinker's own (upkeep.js), kept on every entry made; its sections are then one job and
// one pull request whatever their actions. `made`: an array given by the caller, filled with what became of each
// change ({ key, title, error | result | group }).
export async function approveChanges(store, changes, { via = VIA.command, pr, spawnFn = spawn, cliPath = CLI, now = Date.now(), batch = null, made = null } = {}) {
  // a change may carry the action the person picked (`chosen`, one of its options); else its suggestion
  changes = changes.map(c => ({ ...c, ...(c.kind === 'tool' ? { scope: 'machine' } : {}), default: c.options?.find(o => o.act === c.chosen) || c.default }));
  const { switchSources } = await import('./context-view.js');
  const said = [], at = now;
  // the sections to the background, one job per action (the rows' dropdowns may differ), a pull request where one can be
  // opened here; `pr` is given by a caller that knows already, and by the tests
  const act = c => (c.kind === 'section' && ['compress', 'remove'].includes(c.default?.act) ? c.default.act : null);
  const secs = changes.filter(c => act(c));
  if (secs.length) {
    const open = pr ?? prAvailable(store.repo).ok;
    for (const action of batch ? ['each'] : ['compress', 'remove']) {
      const xs = batch ? secs : secs.filter(c => act(c) === action);
      if (!xs.length) continue;
      const j = startSectionJob(store, xs, action, { pr: open, now, spawnFn, cliPath, via, batch });
      said.push(j.said || `${xs.map(c => c.title).join(', ')}: ${j.error}`);
      for (const c of xs) made?.push({ key: c.key, title: c.title, ...(j.said ? { group: j.group } : { error: j.error }) });
    }
    changes = changes.filter(c => !act(c));
  }
  // each change made returns what it did, in a line, and how to take it back (revertDecision); a failure is said, not kept
  const make = async c => {
    if (!c.default) return { error: 'nothing switches it off' };
    if (c.default.act === 'on') {
      const r = switchSources(store, { keys: [c.sourceKey || c.name], on: true });
      return /^Turned back on/.test(r) ? { result: 'Turned back on from the next session on', undo: c.label ? { kind: 'on', label: c.label, builtin: Boolean(c.builtin), global: c.kind === 'tool' } : null } : { error: r };
    }
    const r = switchSources(store, { labels: [c.label], builtin: Boolean(c.builtin), global: c.kind === 'tool' });
    if (c.builtin) return /^Tool reference created/.test(r) && !/Not switched off/.test(r) ? { result: 'Tool reference created for all repositories from the next session on; the tool can still be used', undo: { kind: 'off', key: c.sourceKey || c.name } } : { error: r.replace(/^Not switched off: /, '') };
    return /^Switched off here/.test(r) && !/Not switched off/.test(r) ? { result: c.scope === 'machine' ? 'Switched off across all repositories from the next session on' : 'Switched off from the next session on', undo: { kind: 'off', key: c.sourceKey || c.name } } : { error: r.replace(/^Not switched off: /, '') };
  };
  for (const c of changes) {
    if (c.scope === 'machine' && c.default?.act === 'off' && changeHistory(store).find(e => e.scope === 'machine' && e.key === c.key && !e.revertedAt)?.act === 'off') { said.push(`${c.title}: already ${c.builtin ? 'referenced' : 'switched off'} across all repositories`); made?.push({ key: c.key, title: c.title, error: 'already done' }); continue; }
    let m; try { m = await make(c); } catch (e) { m = { error: String(e.message || e).split('\n')[0] }; }
    said.push(`${c.title}: ${m.error || m.result}`);
    made?.push({ key: c.key, title: c.title, ...(m.error ? { error: m.error } : { result: m.result }) });
    if (!m.error) record(store, [entryOf(store, c, 'approved', m.result, at, m.undo, { tokens: m.tokens || null, via: viaOf(via), batch })]);
  }
  // a section's own approval is logged when its job finishes (runSectionJob), with the pull request it opened
  if (changes.length) store.log({ op: 'context-approve', changes: changes.length, saving: changes.reduce((a, c) => a + c.saving, 0), via: viaOf(via) });
  return said;
}

// A decision taken back (the page's Revert, `thinker context --revert <n>`): a switched-off tool or skill is turned back
// on (harness.js:undoHarness), an output's compression set back to none, a section's file written back as it was when
// the file is still what the approval wrote (else the person's later edits would go: git has it), a dismissal
// withdrawn so the change is suggested again, a pending pull request closed with its branch deleted (the page's Close
// PR), after which the sections are suggested again. The entry stays in the history, marked reverted.
const withOthers = siblings => siblings.length ? `, with ${siblings.length === 1 ? 'the other section' : `the ${siblings.length} other sections`} of the same change (${siblings.map(h => h.title.replace(/^.*? · /, '')).join(', ')})` : '';
export async function revertDecision(store, id, { now = Date.now(), prs } = {}) {
  const st = readState(store), e = (st.history || []).find(h => h.id === id);
  if (!e) return { error: 'no such decision' };
  if (e.revertedAt) return { error: 'already reverted' };
  const u = undoOf(store, e);
  if (!u) return { error: e.pr ? `pull request #${e.pr.number} is ${e.pr.state}; nothing to take back` : 'nothing kept to revert this one by' };
  if (u.kind === 'pr') {
    const { closePr } = prs || await import('./instruction-pr.js');
    const r = closePr(store.repo, u.number, { branch: u.branch });
    if (r.error) return { error: r.error };
    // every section of the pull request is closed with it
    const siblings = st.history.filter(h => h !== e && h.pr?.number === u.number && h.pr.state === 'open');
    for (const h of [e, ...siblings]) { h.pr.state = 'closed'; h.pr.at = new Date(now).toISOString(); h.result = `Pull request #${u.number} closed without merging: suggested again`; h.revertedAt = h.pr.at; }
    writeState(store, st);
    store.log({ op: 'context-revert', kind: 'pr', pr: u.number, sections: 1 + siblings.length });
    return { said: `${e.title}: pull request #${u.number} closed; suggested again${withOthers(siblings)}` };
  }
  // a merged pull request is taken back by another: one that reverts its merge, for every section the pull request made
  if (u.kind === 'revert-pr') {
    const { revertPr } = prs || await import('./instruction-pr.js');
    const siblings = st.history.filter(h => h !== e && h.pr?.number === u.number && h.pr.state === 'merged' && !h.revertedAt);
    const titles = [e, ...siblings].map(h => h.title.replace(/^.*? · /, ''));
    const r = revertPr(store.repo, { number: u.number, mergeCommit: u.mergeCommit, base: u.base, title: titles.length <= 3 ? titles.join(', ') : `${titles.length} sections` }, { now });
    if (r.error) return { error: r.error };
    const at = new Date(now).toISOString();
    for (const h of [e, ...siblings]) { h.revertPr = { number: r.number, url: r.url, branch: r.branch, base: r.base, openedAt: at }; h.result = `Pull request #${r.number} opened to revert #${u.number}`; h.revertedAt = at; }
    writeState(store, st);
    store.log({ op: 'context-revert', kind: 'revert-pr', pr: u.number, revertPr: r.number, sections: 1 + siblings.length });
    return { said: `${e.title}: pull request #${r.number} opened to revert #${u.number}: ${r.url}${withOthers(siblings)}` };
  }
  if (u.kind === 'off') {
    const { undoHarness } = await import('./harness.js');
    const r = undoHarness(store, { names: [u.key] });
    if (!/^Turned back on/.test(r)) return { error: r };
  } else if (u.kind === 'output') {
    const { setOutputCompression } = await import('./context-view.js');
    setOutputCompression(store, [u.name], u.level || 'off');
  } else if (u.kind === 'on') {
    const { switchSources } = await import('./context-view.js');
    const r = switchSources(store, { labels: [u.label], builtin: Boolean(u.builtin), global: Boolean(u.global) });
    if (!/^Switched off here/.test(r) || /Not switched off/.test(r)) return { error: r.replace(/^Not switched off: /, '') };
  } else if (u.kind === 'edit') {
    for (const f of u.files) { let now; try { now = fs.readFileSync(path.join(store.repo, f.file), 'utf8'); } catch { now = null; } if (now !== f.after) return { error: `${f.file} changed since; git diff shows what to undo by hand` }; }
    for (const f of u.files) { const p = path.join(store.repo, f.file); if (f.before == null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, f.before); }
  }
  // an edit over several sections is one undo: the file written back reverts every section of the group
  const s2 = readState(store), x = s2.history.find(h => h.id === id);
  const siblings = u.kind === 'edit' && e.group ? s2.history.filter(h => h !== x && h.group === e.group && !h.revertedAt) : [];
  for (const h of [x, ...siblings]) h.revertedAt = new Date(now).toISOString();
  writeState(store, s2);
  try { fs.rmSync(undoFile(store, e.group || id), { force: true }); } catch {}
  store.log({ op: 'context-revert', kind: u.kind, ...(siblings.length ? { sections: 1 + siblings.length } : {}) });
  return { said: `${e.title}: ${{ off: 'turned back on from the next session on', on: 'switched off again from the next session on', output: u.level && u.level !== 'off' ? `${u.level} compression again` : 'compression off', edit: 'written back as it was', dismissed: 'suggested again' }[u.kind]}${withOthers(siblings)}` };
}
// One section put back as it was before thinker shortened it, by a pull request of its own (upkeep.js, a week after
// the change took effect and only where it backfired): the rest of the pull request that shortened it stays. The
// section's earlier text is read from the merge's parent (instruction-pr.js:sectionBefore) and set over what the base
// branch holds now, so later edits elsewhere in the file are kept. `why` goes in the pull request's body. The entry is
// marked taken back, with the pull request that does it (`restorePr`).
export async function restoreSection(store, id, { now = Date.now(), prs, edit, why } = {}) {
  const st = readState(store), e = (st.history || []).find(h => h.id === id);
  if (!e) return { error: 'no such decision' };
  if (e.revertedAt) return { error: 'already taken back' };
  if (e.kind !== 'section' || e.act !== 'compress' || e.pr?.state !== 'merged') return { error: 'only a section shortened by a merged pull request is put back this way' };
  const prsMod = prs || await import('./instruction-pr.js'), { previewEdit } = edit || await import('./instruction-edit.js');
  const before = prsMod.sectionBefore(store.repo, { mergeCommit: e.pr.mergeCommit, number: e.pr.number, file: e.file, id: e.section });
  if (before == null) return { error: `the section as it was before #${e.pr.number} could not be read` };
  const src = prsMod.baseTexts(store.repo);
  if (src.error) return { error: src.error };
  const p = await previewEdit(store, [e.section], 'restore', { texts: src.textOf, base: src, restore: { [e.section]: before }, ...(why ? { note: why } : {}) });
  if (p.error) return { error: p.error };
  const r = await prsMod.openEditPr(store, p.key, { changes: [e], now });
  if (r.error) return { error: r.error };
  const at = new Date(now).toISOString();
  e.restorePr = { number: r.number, url: r.url, branch: r.branch, base: r.base, openedAt: at };
  e.result = `Pull request #${r.number} opened to put it back as it was`;
  e.revertedAt = at;
  writeState(store, st);
  store.log({ op: 'context-revert', kind: 'restore-pr', pr: e.pr.number, restorePr: r.number, sections: 1 });
  return { said: `${e.title}: pull request #${r.number} opened to put it back as it was`, pr: { number: r.number, url: r.url } };
}

// the changes a choice names: "all", or their numbers in the list (1-based), or their keys, each optionally with the
// action picked instead of the suggestion after a colon ("3:remove"; `acts` maps keys to actions)
// (`acts` maps keys to actions). The page gives keys as a list, read as they are: a key like `output:Read` is not a
// choice with an action after its colon.
export function pickChanges(changes, choice, acts = {}) {
  const w = Array.isArray(choice) ? choice.map(x => [String(x), null]) : String(choice || '').split(',').map(x => x.trim()).filter(Boolean).map(x => { const m = x.match(/^(.*?):([\w-]+)$/); return m && !m[1].includes(':') ? [m[1], m[2]] : [x, null]; });
  const all = w.find(([x]) => /^all$/i.test(x));
  const at = (c, i) => all ? all : w.find(([x]) => x === String(i + 1) || x === c.key);
  return changes.flatMap((c, i) => { const m = at(c, i); if (!m) return []; const chosen = acts[c.key] || m[1]; return [chosen && c.options?.some(o => o.act === chosen) ? { ...c, chosen } : c]; });
}
