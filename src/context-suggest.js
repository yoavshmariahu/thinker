// The Context view's five highest-leverage changes (context-view.js), each with a suggested action, put to the person
// in their coding session. Once a week maintenance reads the report and keeps the top five here; the next prompt's
// hook starts the local page (`thinker ui`) and tells the agent to pass the five on in a few lines with the link to
// the Context tab's All. There every part of the context is a row with the actions that can be taken on it (allChanges):
// a section compressed or removed after its diff is read, a skill or tool switched off or back on, an output's
// compression set; the person picks one in the row and applies it, and every decision is kept as the page's Recent
// activity with a Revert. `thinker context --approve|--dismiss|--history` is the same over the top five.
// Nothing is changed until the person chooses. Ranking and scheduling make no model call; compressing a section does.
//
//   topChanges                    the ranking (context-view.js keeps it on the report)
//   allChanges                    every part as a change with its options: the page's rows, whatever their waste
//   currentChanges                the top five not dismissed or decided lately: the summary, the command
//   scheduleContextSuggestion     maintenance: at most weekly, the five kept in <cache>/state/context-suggest.json
//   contextSuggestOffer           the prompt hook: once, the summary and the link, for the agent to pass on
//   approveChanges, dismissChanges, revertDecision   the person's decisions, kept as the history (changeHistory), and taken back
//   startSectionJob, runSectionJob, retryJob   a section's change as a job in the background: recorded at once, made by
//                                    `thinker instructions … --job`, a pull request when done (instruction-pr.js) or failed with Retry
//   refreshPrStates               a pull request's state followed: open is pending, merged done, closed without merging rejected
//                                    and suggested again; a merged one that this checkout has not pulled is `unpulled`
//                                    (changeHistory, with `pullFrom`, the branch to pull): the page shows no row for its
//                                    section, and Recent activity says to pull and tints the decisions waiting on it
//   ensureUi                      a detached `thinker ui --background` for the machine, reused while it runs
//
// `maintain: { contextSuggest: false }` in .thinker/config.json turns it off for a repository.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { thinkerHome } from './update.js';
import { formatTokens } from './model-usage.js';
import { SIGNATURE } from './harness.js';
import { WASTE, sections, sectionId } from './instruction-value.js';
import { describePart, describeEntry } from './part-describe.js';
import { defaultBranch } from './instruction-pr.js';

export const SUGGEST = {
  max: 5,
  days: 7,            // the window the changes are ranked and their totals counted over
  everyDays: 7,       // a new summary at most this often
  firstSessions: 10,  // and only once the repository has this many sessions to read
  answerDays: 3,      // a summary not passed on in this long (no prompt here) is dropped
  minSaving: 15,      // a change saving fewer input tokens on an average prompt is not worth a line (500 a session
                      // until 2026-10-25, when the unit became a prompt: about 15 of them at this machine's median calls)
  uiWaitMs: 3000,     // how long the hook waits for the page to start
};
const DAY = 86_400_000;
const DECIDED_DAYS = 30; // a change approved or dismissed is not suggested again for this long
const HISTORY_KEPT = 200;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateFile = store => path.join(store.dir, 'state', 'context-suggest.json');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.thinker-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(v) + '\n'); fs.renameSync(tmp, f); };
// What can be done with each kind of change, the suggested action first. One level of compression each, so the person
// is not asked to choose one nothing has measured against the other: a section as the Context tab compresses it (high,
// instruction-edit.js), an output at the diet's default level (moderate). The diet's high level has run in no agent
// session and is set from the command line alone (`thinker context --output-compression <tools> --level high`), for an
// experiment arm; the rows offered it for a day on 2026-10-22 and that was taken back, the owner's call.
export const ACTS = {
  compress: { act: 'compress', text: 'Compress' },
  remove: { act: 'remove', text: 'Remove' },
  off: { act: 'off', text: 'Switch off' },
  on: { act: 'on', text: 'Turn back on' },
  uncompress: { act: 'uncompress', text: 'No compression' },
};
const pctLess = (cut, of) => { const p = of ? 100 * cut / of : 0; return p < 1 ? '<1% smaller' : `~${Math.round(p)}% smaller`; };
const flagged = r => !r.off && (r.waste === 'high' || r.waste === 'medium') && r.wasted > 0;

// Every change the report flags, by what it saves over the window, the five largest. A section, skill or tool is flagged
// when its cost in the sessions that did not use it is a share of its kind's (instruction-value.js:wasteLevel), and saves at most its cost
// in the sessions that did not use it; an output thinker can compress and does not, what moderate compression's cap
// alone would have cut from it (tool-outputs.js).
export function topChanges(view, { max = SUGGEST.max, minSaving = SUGGEST.minSaving } = {}) {
  return partChanges(view).filter(c => c.saving >= minSaving).sort((a, b) => b.total - a.total || b.saving - a.saving).slice(0, max);
}
// Every part of the report as a change with what can be done to it, by its total: the Context tab's rows. A section
// can be compressed or removed; a skill or tool switched off, or back on when thinker switched it off; an output
// thinker can compress compressed (moderate), or set back to none. Nothing is filtered by waste.
export function allChanges(view) {
  return partChanges(view, { all: true }).sort((a, b) => b.total - a.total || b.saving - a.saving);
}
function partChanges(view, { all = false } = {}) {
  const out = [], take = r => all || flagged(r);
  for (const s of view.instructions?.sections || []) if (take(s)) out.push({
    kind: 'section', view: 'instructions', waste: s.waste, key: `section:${s.file}:${s.id}`, id: s.id, file: s.file, repo: s.repo,
    title: `${s.file} · ${s.parent ? `${s.parent}: ` : ''}${s.title}`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1500),
    why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : 'rarely acted on'}; ~${formatTokens(s.tokens)} tokens in every model call`,
    action: 'compress or remove the section', sessions: view.instructions?.sessions || 0, prompts: s.prompts || 0, options: [ACTS.compress, ACTS.remove], ...describePart({ kind: 'section', text: s.text }),
  });
  // a skill or tool thinker switched off has one action, back on (by the key the switch-off kept); one nothing switches
  // off has none
  const switchOpts = s => s.off ? [ACTS.on] : s.label ? [ACTS.off] : [];
  for (const s of view.skills || []) if (take(s)) out.push({
    kind: 'skill', view: 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name} skill`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1200), why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : `opened in ${s.used} of ${s.loaded} sessions`}; its listing is in every one`, action: 'switch it off here',
    sessions: s.loaded || 0, prompts: s.prompts || 0, options: switchOpts(s), ...describePart({ kind: 'skill', text: s.text }),
  });
  for (const s of view.tools || []) if (take(s)) out.push({
    kind: 'tool', view: s.group === 'builtin' ? 'builtin' : 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name}${s.kind === 'mcp' ? ' MCP server' : s.kind === 'plugin' ? ' plugin' : ' tool'}`, saving: s.wasted, windowSaving: s.wastedWindow, text: String(s.text || '').slice(0, 1200),
    why: `${s.usedShare != null ? `needed in ${Math.round(100 * s.usedShare)}% of prompts` : `used in ${s.used} of ${s.loaded} sessions`}; ~${formatTokens(s.tokens)} tokens in every model call`, action: 'switch it off here',
    builtin: s.group === 'builtin', sessions: s.loaded || 0, prompts: s.prompts || 0, options: switchOpts(s), ...describePart({ kind: 'tool', name: s.name, builtin: s.group === 'builtin', toolKind: s.kind, text: s.text }),
  });
  // what an output's tool is, from the tool's own row (its definition's text): a built-in tool by its name, an MCP server by its key
  const toolText = n => (view.tools || []).find(s => n.startsWith('mcp:') ? s.kind === 'mcp' && (s.key === n || s.name === n.slice(4)) : s.group === 'builtin' && s.name === n)?.text || '';
  // the summary ranks an output by what compressing it would cut, as a share of what every tool's output costs a
  // session, since that is what its action saves; the page's Wasted column shows the output's reads after its last
  // use (tool-outputs.js:sessionOutputs), which no cap recovers
  const outCost = view.totals?.outputs?.perPrompt || (view.outputs?.tools || []).reduce((a, t) => a + (t.perPrompt || 0), 0);
  const outWaste = cut => { const sh = outCost ? cut / outCost : 0; return sh >= WASTE.high ? 'high' : sh >= WASTE.medium ? 'medium' : 'low'; };
  // one level (moderate, diet.js): Compress, or No compression once the output is compressed at any level (the
  // command line can set high)
  const levelOpts = t => t.compression ? [ACTS.uncompress] : [ACTS.compress];
  // a row measured under an earlier setting (tool-outputs.js:aggregateOutputs, `past`) is a comparison, not a change:
  // the tool's current row is the one acted on, measured over the sessions since the setting (its `sessions`)
  for (const t of view.outputs?.tools || []) if (!t.past && (all ? t.compressible : (t.compressible && !t.compression && t.saveModerate > 0))) out.push({
    kind: 'output', view: 'outputs', waste: outWaste(t.saveModerate), key: `output:${t.name}`, name: t.name, repo: t.repo, compression: t.compression || null,
    title: `${t.name.replace(/^Bash:/, '')} output`, saving: t.saveModerate, windowSaving: t.saveModerateWindow,
    // how much smaller compressing makes this tool's results here: the part past the length cap, from these
    // transcripts (tool-outputs.js); trimming reads and searches round what the agent looked for cuts more
    why: `~${formatTokens(t.perCall)} tokens a call, read again by every call after it${t.wasted != null ? ` (~${formatTokens(t.wasted)} a prompt after the agent last used the result)` : ''}; compressed, ${pctLess(t.saveModerate, t.perPrompt)}`, action: 'compress its output (Claude Code)',
    sessions: t.sessions ?? view.outputs?.sessions ?? 0, prompts: t.prompts || 0, options: levelOpts(t), ...describePart({ kind: 'output', name: t.name, text: toolText(t.name) }),
  });
  // the first option is the suggestion; `total` is what it could have saved over the report's window, and it is the
  // row's own figure (instruction-value.js, context-view.js: `wastedWindow`, an output's `saveModerateWindow`) -- its
  // size in every model call that carried it, times the share of prompts that did not need it. Not recomputed from
  // `saving`: that is already the window cost over *every* prompt of the window (`perPrompt`), so multiplying it by the
  // calls that carried this part divided by denom again, and a part carried by half the window's calls read half what
  // its own row showed (Artifact on this machine: 37M against the table's 68M). One figure, counted once.
  return out.map(c => ({ ...c, saving: c.saving || 0, default: c.options[0] || null,
    total: c.windowSaving ?? (c.saving || 0) * (c.prompts || c.sessions), days: view.days }));
}

const configOn = store => store.config().maintain?.contextSuggest !== false;

// The decisions on the changes (<cache>/state/context-suggest.json `history`, newest first): approved (its suggested
// action made), applied after review, or dismissed, with what came of it.
const readState = store => readJson(stateFile(store)) || {};
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
    if (e.pr?.state === 'merged' && e.kind === 'section' && !e.pr.pulledAt && now - Date.parse(e.pr.at || e.at) < DECIDED_DAYS * DAY) {
      const here = inCheckout(store, e, git);
      if (here === true) { e.pr.pulledAt = new Date(now).toISOString(); dirty = true; }
      else if (here === false) unpulled.add(e);
    }
  }
  if (dirty) writeJson(stateFile(store), st);
  const pullFrom = unpulled.size ? (defaultBranch(store.repo) || 'main') : null;
  return h.map(e => {
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
  writeJson(stateFile(store), st);
  return changed;
}
function record(store, entries) {
  const st = readState(store);
  st.history = [...entries, ...(st.history || [])].slice(0, HISTORY_KEPT);
  writeJson(stateFile(store), st);
}
// what a decision undoes by, kept beside the history (a section's text before and after can be large); a switch-off or
// compression approved before these were kept is undone by its key. Sections written by one edit are one entry each
// (the person reads them as separate line items) sharing one undo, under the edit's `group` id: reverting any of them
// reverts the edit, and every entry of the group with it (revertDecision)
const undoFile = (store, id) => path.join(store.dir, 'state', 'context-suggest-undo', `${id}.json`);
const undoOf = (store, e) => e.decision === 'dismissed' ? { kind: 'dismissed' } : e.pr ? (e.pr.state === 'open' ? { kind: 'pr', number: e.pr.number, branch: e.pr.branch } : null) : (e.id && readJson(undoFile(store, e.group || e.id)))
  || (e.decision === 'approved' && (e.kind === 'tool' || e.kind === 'skill') ? { kind: 'off', key: e.key.replace(/^[^:]+:/, '') }
    : e.decision === 'approved' && e.kind === 'output' ? { kind: 'output', name: e.key.replace(/^output:/, '') } : null);
// Where a decision was taken (`via`, on the log event and the history entry), so the funnel from a suggestion to a
// change can be read end to end: `session` is the weekly suggestion approved in the conversation it was passed on in
// (the command the offer text tells the agent to run), `page` is Find Savings, `setup` the install's multi-select, and
// `command` someone typing `thinker context --approve` themselves. VIA.session is what says whether a suggestion
// converted; `page` is what says a person went to the dashboard and acted there.
export const VIA = { session: 'session', page: 'page', setup: 'setup', command: 'command' };
const viaOf = v => VIA[String(v)] || VIA.command;
const entryOf = (store, c, decision, result, now, undo, { group = null, tokens = null, via = null } = {}) => {
  const id = randomBytes(6).toString('hex');
  if (undo && !group) writeJson(undoFile(store, id), undo);
  return { id, ...(group ? { group } : {}), at: new Date(now).toISOString(), ...(via ? { via } : {}), key: c.key, ...(c.keys ? { keys: c.keys } : {}), kind: c.kind, title: c.title, ...(c.what ? { what: c.what } : {}), ...(c.about ? { about: c.about } : {}), ...(c.kind === 'section' && c.file ? { file: c.file } : {}), ...(tokens ? { tokens } : {}), saving: c.saving, total: c.total, days: c.days ?? null, action: c.default?.text || null, act: c.default?.act || null, decision, result: result || null, ...(undo ? { revertible: true } : {}) };
};
// a section's tokens before and after its edit (instruction-edit.js:previewEdit `sections`), kept on the entry so the
// Report can cost the section a session on each side (report.js:actionEffect)
export const sectionTokens = (p, id) => { const x = (p?.sections || []).find(s => s.id === id) || (p?.sections?.length === 1 ? p.sections[0] : null); return x ? { before: x.tokensBefore, after: x.tokensAfter } : p && p.tokensBefore != null ? { before: p.tokensBefore, after: p.tokensAfter } : null; };
// the entries of one edit over several sections: one per section, each with its own title and saving, sharing the
// group id their undo is kept under (written once, here) and, for a pull request, the pull request
const entriesOf = (store, changes, decision, result, now, undo) => {
  if (changes.length === 1) return [entryOf(store, changes[0], decision, result, now, undo)];
  const group = randomBytes(6).toString('hex');
  if (undo) writeJson(undoFile(store, group), undo);
  return changes.map(c => entryOf(store, c, decision, result, now, undo, { group }));
};
// The view's changes less the ones decided in the last month, the five largest: what the page, the session's summary
// and `thinker context` offer
export function currentChanges(store, view, { now = Date.now(), max = SUGGEST.max } = {}) {
  // a dismissal taken back makes its change a suggestion again, and so does a pull request closed without merging:
  // nothing was followed through on
  // a job that failed decided nothing either
  const decided = new Set(changeHistory(store, { now }).filter(h => now - Date.parse(h.at) < DECIDED_DAYS * DAY && !(h.decision === 'dismissed' && h.revertedAt) && !h.rejected && !h.failed).flatMap(h => h.keys || [h.key]));
  return (view.suggestions || topChanges(view, { max: 20 })).filter(c => !decided.has(c.key)).slice(0, max);
}
export function dismissChanges(store, changes, { now = Date.now(), via = VIA.command } = {}) {
  record(store, changes.map(c => entryOf(store, c, 'dismissed', null, now, null, { via: viaOf(via) })));
  store.log({ op: 'context-dismiss', changes: changes.length, via: viaOf(via) });
  return changes.map(c => `${c.title}: dismissed; not suggested again for a month`);
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
export function startSectionJob(store, changes, action, { pr = false, now = Date.now(), spawnFn = spawn, cliPath = CLI, via = VIA.page } = {}) {
  const ids = [...new Set(changes.map(c => c.id).filter(Boolean))];
  if (!ids.length || !['compress', 'remove'].includes(action)) return { error: 'no section to change' };
  const group = randomBytes(6).toString('hex'), at = new Date(now).toISOString();
  const es = changes.map(c => ({ ...entryOf(store, { ...c, default: ACTS[action] }, pr ? 'pull request' : 'applied', null, now, null, { group, via: viaOf(via) }), section: c.id, file: c.file, job: { state: 'running', action, pr, startedAt: at, pid: null, via: viaOf(via) } }));
  record(store, es);
  const args = [cliPath, 'instructions', `--${action}`, ids.join(','), pr ? '--pr' : '--apply', '--job', group];
  let pid = null;
  try { const child = spawnFn(process.execPath, args, { cwd: store.repo, detached: true, stdio: 'ignore' }); child.on?.('error', () => {}); child.unref?.(); pid = child.pid || null; }
  catch (e) { finishJob(store, group, j => ({ ...j, state: 'failed', error: `could not start: ${String(e.message || e).split('\n')[0]}`, finishedAt: at })); return { error: 'could not start the change', group }; }
  finishJob(store, group, j => ({ ...j, pid }));
  store.log({ op: 'context-job', group, action, sections: ids.length, pr, state: 'started', via: viaOf(via) });
  const n = ids.length, word = `${n} section${n === 1 ? '' : 's'}`;
  return { group, said: action === 'compress' ? `Compressing ${word} in the background: ${pr ? 'a pull request opens with the change when the model is done' : 'the file in your working tree is rewritten when the model is done'}. Follow it under Recent activity.` : `Removing ${word}: ${pr ? 'a pull request opens with the change in a moment' : 'written to your working tree in a moment'}. Follow it under Recent activity.` };
}
// every entry of the job rewritten by `fn` over its `job`, and `also` over the entry, from the state as it is now
function finishJob(store, group, fn, also) {
  const st = readState(store), es = (st.history || []).filter(e => e.group === group && e.job);
  for (const e of es) { e.job = fn(e.job); also?.(e); }
  writeJson(stateFile(store), st);
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
    const p = await previewEdit(store, ids, action, src ? { texts: src.textOf, base: src } : {});
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
  const ids = es.map(h => h.section).filter(Boolean), { action, pr } = e.job;
  const at = new Date(now).toISOString();
  finishJob(store, group, j => ({ state: 'running', action, pr, startedAt: at, pid: null, tries: (j.tries || 1) + 1 }));
  let pid = null;
  try { const child = spawnFn(process.execPath, [cliPath, 'instructions', `--${action}`, ids.join(','), pr ? '--pr' : '--apply', '--job', group], { cwd: store.repo, detached: true, stdio: 'ignore' }); child.on?.('error', () => {}); child.unref?.(); pid = child.pid || null; }
  catch (err) { finishJob(store, group, j => ({ ...j, state: 'failed', error: `could not start: ${String(err.message || err).split('\n')[0]}`, finishedAt: at })); return { error: 'could not start the change' }; }
  finishJob(store, group, j => ({ ...j, pid }));
  store.log({ op: 'context-job', group, action, sections: ids.length, pr, state: 'retried' });
  return { said: `${e.title}: ${action === 'compress' ? 'compressing again in the background' : 'removing again'}${es.length > 1 ? `, with the ${es.length - 1} other section${es.length > 2 ? 's' : ''} of the same change` : ''}` };
}

// Maintenance: the top five kept for the next prompt, at most weekly, once there are enough sessions to read.
// `view` is the report (context-view.js:contextView), given by tests; read here otherwise.
export async function scheduleContextSuggestion(store, { now = Date.now(), view, force = false } = {}) {
  if (!configOn(store)) return null;
  const st = readJson(stateFile(store)) || {};
  if (st.pending && !force) {
    // never passed on (no prompt here since): dropped after a while, so a stale summary is not given
    if (now - Date.parse(st.pending.at) > SUGGEST.answerDays * DAY) { delete st.pending; writeJson(stateFile(store), st); }
    return null;
  }
  if (!force && st.checkedAt && now - Date.parse(st.checkedAt) < (st.firstAt ? SUGGEST.everyDays : 1) * DAY) return null;
  view ??= (await import('./context-view.js')).contextView(store, { days: SUGGEST.days });
  st.checkedAt = new Date(now).toISOString();
  if (!force && (view.sessions || 0) < SUGGEST.firstSessions) { writeJson(stateFile(store), st); return null; }
  st.firstAt ||= st.checkedAt;
  const changes = currentChanges(store, view, { now });
  if (changes.length) {
    st.pending = { at: st.checkedAt, days: view.days, sessions: view.sessions, changes };
    store.log({ op: 'context-suggest', changes: changes.length, saving: changes.reduce((a, c) => a + c.saving, 0) });
  }
  writeJson(stateFile(store), st);
  return changes;
}
export const contextSuggestPending = store => configOn(store) && Boolean(readJson(stateFile(store))?.pending);

// The page for the machine: one `thinker ui --background` (cache.js:uiCommand), its address in
// THINKER_HOME/state/ui.json while it runs; started here when none does, waited for up to uiWaitMs.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const uiFile = (home = thinkerHome()) => path.join(home, 'state', 'ui.json');
export function ensureUi(store, { home = thinkerHome(), spawnFn = spawn, waitMs = SUGGEST.uiWaitMs } = {}) {
  const f = uiFile(home), running = () => { const u = readJson(f); return u?.url && u.pid && alive(u.pid) ? u.url : null; };
  const now = running(); if (now) return now;
  try {
    const child = spawnFn(process.execPath, [CLI, 'ui', '--background'], { cwd: store.repo, detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); child.unref?.();
  } catch { return null; }
  for (let t = 0; t < waitMs; t += 100) { sleep(100); const u = running(); if (u) return u; }
  return null;
}
// the address of the Context tab's All for this repository (a page started by an older version keeps its key in
// the address; it is dropped, that version's server takes the Host check alone)
export const suggestionsUrl = (url, repoId) => `${String(url).replace(/#.*$/, '')}#tab=save&view=all${repoId ? `&repo=${encodeURIComponent(repoId)}` : ''}`;

// a session no person is at: `claude -p`, the Agent SDK
const unattended = (env = process.env) => /^sdk-/.test(env.CLAUDE_CODE_ENTRYPOINT || '');
// The prompt hook: the pending summary, once, with the page started and its link. `ui` (tests) stands in for
// ensureUi; `repoId` names the repository on the page (ui/server.js:machineRepos).
export function contextSuggestOffer(store, { now = Date.now(), env = process.env, ui = ensureUi, repoId } = {}) {
  if (!configOn(store) || unattended(env)) return '';
  const st = readJson(stateFile(store));
  if (!st?.pending) return '';
  const p = st.pending; delete st.pending; st.offeredAt = new Date(now).toISOString();
  writeJson(stateFile(store), st);
  const url = (() => { try { return ui(store); } catch { return null; } })();
  // the one cost rule, in the order the person can check it: what the changes add to every prompt here, and what
  // that came to over the window. Per prompt first since it is the figure they can hold against a prompt they have
  // seen; the window total is the same number times the calls that carried it, and alone it reads as a figure nobody
  // can place (a week of a 25k-token file across 7,600 calls is ~190M, true and useless).
  const perPrompt = p.changes.reduce((a, c) => a + (c.saving || 0), 0);
  const total = p.changes.reduce((a, c) => a + (c.total ?? c.saving ?? 0), 0);
  store.log({ op: 'context-offer', changes: p.changes.length, saving: total, perPrompt, ui: Boolean(url) });
  const lines = p.changes.map((c, i) => `${i + 1}. ${c.title}: ~${formatTokens(c.saving || 0)} input tokens in every prompt (~${formatTokens(c.total ?? c.saving ?? 0)} over the last ${p.days} days); ${c.why}. Suggested: ${c.default ? c.default.text : 'dismiss, or change it by hand'}${c.options?.length > 1 ? ` (or: ${c.options.slice(1).map(o => o.act).join(', ')})` : ''}`).join('\n');
  const where = url ? `at ${suggestionsUrl(url, repoId)} (thinker's page on this machine, just started)` : 'by running `thinker ui` (Context, All)';
  return `<thinker-context-suggestions>
thinker read the last ${p.days} days of agent sessions in this repository (${p.sessions} sessions) and found ${p.changes.length === 1 ? 'one change' : `${p.changes.length} changes`} to what loads into every session, together ~${formatTokens(perPrompt)} input tokens in every prompt here (~${formatTokens(total)} over those ${p.days} days).
Before you start on the request, pass this on to the user in a short message starting "${SIGNATURE}:": one line per change below (what it is, what it saves, and the suggested action), then that they can approve or review each ${where}, or reply here with the numbers to approve (or "all"). Keep it under ten lines. Do not make any of these changes yourself, and do not open the files to check them. Then go on with the task.
If the user later approves some of them in this conversation, run \`thinker context --days 7 --via session --approve <their numbers, comma-separated, or all; a number may take another action after a colon, e.g. 3:remove>\` and tell them in one line what it did.
${lines}
</thinker-context-suggestions>`;
}

// The person approved these changes (`thinker context --approve 1,3|all`, the page's Approve): each one's default,
// made as the Context tab makes it. A section is compressed by a model and written to the working tree, uncommitted,
// for git diff to review (instruction-edit.js); a skill or tool is switched off for this repository, `thinker harness
// --undo` turning it back on (context-view.js:switchSources); an output gets moderate compression (diet.js). A change
// with no default (nothing switches it off) is left for review on the page. Returns one line per change.
export async function approveChanges(store, changes, { edit, via = VIA.command } = {}) {
  // a change may carry the action the person picked (`chosen`, one of its options); else its suggestion
  changes = changes.map(c => ({ ...c, default: c.options?.find(o => o.act === c.chosen) || c.default }));
  const { switchSources, setOutputCompression } = await import('./context-view.js');
  const { previewEdit, applyEdit } = edit || await import('./instruction-edit.js');
  const said = [], at = Date.now();
  // each change made returns what it did, in a line, and how to take it back (revertDecision); a failure is said, not kept
  const make = async c => {
    if (!c.default) return { error: 'nothing switches it off' };
    if (c.kind === 'output') {
      // Compress is moderate (the diet's default, and the page's only level); the undo sets the level back to what it was
      const level = c.default.act === 'uncompress' ? 'off' : 'moderate';
      const r = setOutputCompression(store, [c.name], level);
      const ok = level === 'off' ? /^Compression off for/.test(r) : /^Moderate compression for/.test(r);
      return ok ? { result: level === 'off' ? 'Compression off from the next tool call' : 'Compressed from the next tool call', undo: { kind: 'output', name: c.name, level: c.compression || 'off' } } : { error: r };
    }
    if (c.default.act === 'on') {
      const r = switchSources(store, { keys: [c.sourceKey || c.name], on: true });
      return /^Turned back on/.test(r) ? { result: 'Turned back on from the next session on', undo: c.label ? { kind: 'on', label: c.label, builtin: Boolean(c.builtin) } : null } : { error: r };
    }
    if (c.default.act === 'compress' || c.default.act === 'remove') {
      const p = await previewEdit(store, c.id, c.default.act);
      if (p.error) return { error: p.error };
      const files = p.files || [p.file], read = f => { try { return fs.readFileSync(path.join(store.repo, f), 'utf8'); } catch { return null; } };
      const before = files.map(read), a = applyEdit(store, p.key);
      if (a.error) return { error: a.error };
      return { result: `${c.default.act === 'remove' ? 'Removed' : 'Compressed'}: ~${formatTokens(p.tokensBefore)} → ~${formatTokens(p.tokensAfter)} tokens in ${p.file}, uncommitted`, undo: { kind: 'edit', files: files.map((f, i) => ({ file: f, before: before[i], after: read(f) })) }, tokens: sectionTokens(p, c.id) };
    }
    const r = switchSources(store, { labels: [c.label], builtin: Boolean(c.builtin) });
    return /^Switched off here/.test(r) && !/Not switched off/.test(r) ? { result: 'Switched off from the next session on', undo: { kind: 'off', key: c.sourceKey || c.name } } : { error: r.replace(/^Not switched off: /, '') };
  };
  for (const c of changes) {
    let m; try { m = await make(c); } catch (e) { m = { error: String(e.message || e).split('\n')[0] }; }
    said.push(`${c.title}: ${m.error || m.result}`);
    if (!m.error) record(store, [entryOf(store, c, 'approved', m.result, at, m.undo, { tokens: m.tokens || null, via: viaOf(via) })]);
  }
  store.log({ op: 'context-approve', changes: changes.length, saving: changes.reduce((a, c) => a + c.saving, 0), via: viaOf(via) });
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
    writeJson(stateFile(store), st);
    store.log({ op: 'context-revert', kind: 'pr', pr: u.number, sections: 1 + siblings.length });
    return { said: `${e.title}: pull request #${u.number} closed; suggested again${withOthers(siblings)}` };
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
    const r = switchSources(store, { labels: [u.label], builtin: Boolean(u.builtin) });
    if (!/^Switched off here/.test(r) || /Not switched off/.test(r)) return { error: r.replace(/^Not switched off: /, '') };
  } else if (u.kind === 'edit') {
    for (const f of u.files) { let now; try { now = fs.readFileSync(path.join(store.repo, f.file), 'utf8'); } catch { now = null; } if (now !== f.after) return { error: `${f.file} changed since; git diff shows what to undo by hand` }; }
    for (const f of u.files) { const p = path.join(store.repo, f.file); if (f.before == null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, f.before); }
  }
  // an edit over several sections is one undo: the file written back reverts every section of the group
  const s2 = readState(store), x = s2.history.find(h => h.id === id);
  const siblings = u.kind === 'edit' && e.group ? s2.history.filter(h => h !== x && h.group === e.group && !h.revertedAt) : [];
  for (const h of [x, ...siblings]) h.revertedAt = new Date(now).toISOString();
  writeJson(stateFile(store), s2);
  try { fs.rmSync(undoFile(store, e.group || id), { force: true }); } catch {}
  store.log({ op: 'context-revert', kind: u.kind, ...(siblings.length ? { sections: 1 + siblings.length } : {}) });
  return { said: `${e.title}: ${{ off: 'turned back on from the next session on', on: 'switched off again from the next session on', output: u.level && u.level !== 'off' ? `${u.level} compression again` : 'compression off', edit: 'written back as it was', dismissed: 'suggested again' }[u.kind]}${withOthers(siblings)}` };
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
