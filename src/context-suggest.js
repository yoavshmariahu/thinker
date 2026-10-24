// The Context view's five highest-leverage changes (context-view.js), each with a suggested action, put to the person
// in their coding session. Once a week maintenance reads the report and keeps the top five here; the next prompt's
// hook starts the local page (`thinker ui`) and tells the agent to pass the five on in a few lines with the link to
// the Context tab's All. There every part of the context is a row with the actions that can be taken on it (allChanges):
// a section compressed or removed after its diff is read, a skill or tool switched off or back on, an output's
// compression set; the person picks one in the row and applies it, and every decision is kept as the page's history
// with a Revert. `thinker context --approve|--dismiss|--history` is the same over the top five.
// Nothing is changed until the person chooses. Ranking and scheduling make no model call; compressing a section does.
//
//   topChanges                    the ranking (context-view.js keeps it on the report)
//   allChanges                    every part as a change with its options: the page's rows, whatever their waste
//   currentChanges                the top five not dismissed or decided lately: the summary, the command
//   scheduleContextSuggestion     maintenance: at most weekly, the five kept in <cache>/state/context-suggest.json
//   contextSuggestOffer           the prompt hook: once, the summary and the link, for the agent to pass on
//   approveChanges, dismissChanges, revertDecision   the person's decisions, kept as the history (changeHistory), and taken back
//   ensureUi                      a detached `thinker ui --background` for the machine, reused while it runs
//
// `maintain: { contextSuggest: false }` in .thinker/config.json turns it off for a repository.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { thinkerHome } from './update.js';
import { formatTokens } from './model-usage.js';
import { SIGNATURE } from './harness.js';
import { WASTE } from './instruction-value.js';

export const SUGGEST = {
  max: 5,
  days: 7,            // the window the changes are ranked and their totals counted over
  everyDays: 7,       // a new summary at most this often
  firstSessions: 10,  // and only once the repository has this many sessions to read
  answerDays: 3,      // a summary not passed on in this long (no prompt here) is dropped
  minSaving: 500,     // a change saving fewer input tokens a session is not worth a line
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

// Every change the report flags, by what it saves a session, the five largest. A section, skill or tool is flagged
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
    title: `${s.file} · ${s.parent ? `${s.parent}: ` : ''}${s.title}`, saving: s.wasted, text: String(s.text || '').slice(0, 1500),
    why: `${s.usedShare != null ? `acted on in ${Math.round(100 * s.usedShare)}% of sessions` : 'rarely acted on'}; ~${formatTokens(s.tokens)} tokens in every model call`,
    action: 'compress or remove the section', sessions: view.instructions?.sessions || 0, options: [ACTS.compress, ACTS.remove],
  });
  // a skill or tool thinker switched off has one action, back on (by the key the switch-off kept); one nothing switches
  // off has none
  const switchOpts = s => s.off ? [ACTS.on] : s.label ? [ACTS.off] : [];
  for (const s of view.skills || []) if (take(s)) out.push({
    kind: 'skill', view: 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name} skill`, saving: s.wasted, text: String(s.text || '').slice(0, 1200), why: `opened in ${s.used} of ${s.loaded} sessions; its listing is in every one`, action: 'switch it off here',
    sessions: s.loaded || 0, options: switchOpts(s),
  });
  for (const s of view.tools || []) if (take(s)) out.push({
    kind: 'tool', view: s.group === 'builtin' ? 'builtin' : 'custom', waste: s.waste, key: `${s.client}:${s.key}`, sourceKey: s.key, label: s.label, repo: s.repo, off: Boolean(s.off),
    title: `${s.name}${s.kind === 'mcp' ? ' MCP server' : s.kind === 'plugin' ? ' plugin' : ' tool'}`, saving: s.wasted, text: String(s.text || '').slice(0, 1200),
    why: `used in ${s.used} of ${s.loaded} sessions; ~${formatTokens(s.tokens)} tokens in every model call`, action: 'switch it off here',
    builtin: s.group === 'builtin', sessions: s.loaded || 0, options: switchOpts(s),
  });
  // the summary ranks an output by what compressing it would cut, as a share of what every tool's output costs a
  // session, since that is what its action saves; the page's Wasted column shows the output's reads after its last
  // use (tool-outputs.js:sessionOutputs), which no cap recovers
  const outCost = view.totals?.outputs?.perSession || (view.outputs?.tools || []).reduce((a, t) => a + (t.perSession || 0), 0);
  const outWaste = cut => { const sh = outCost ? cut / outCost : 0; return sh >= WASTE.high ? 'high' : sh >= WASTE.medium ? 'medium' : 'low'; };
  // one level (moderate, diet.js): Compress, or No compression once the output is compressed at any level (the
  // command line can set high)
  const levelOpts = t => t.compression ? [ACTS.uncompress] : [ACTS.compress];
  // a row measured under an earlier setting (tool-outputs.js:aggregateOutputs, `past`) is a comparison, not a change:
  // the tool's current row is the one acted on, measured over the sessions since the setting (its `sessions`)
  for (const t of view.outputs?.tools || []) if (!t.past && (all ? t.compressible : (t.compressible && !t.compression && t.saveModerate > 0))) out.push({
    kind: 'output', view: 'outputs', waste: outWaste(t.saveModerate), key: `output:${t.name}`, name: t.name, repo: t.repo, compression: t.compression || null,
    title: `${t.name.replace(/^Bash:/, '')} output`, saving: t.saveModerate,
    // how much smaller compressing makes this tool's results here: the part past the length cap, from these
    // transcripts (tool-outputs.js); trimming reads and searches round what the agent looked for cuts more
    why: `~${formatTokens(t.perCall)} tokens a call, read again by every call after it${t.wasted != null ? ` (~${formatTokens(t.wasted)} a session after the agent last used the result)` : ''}; compressed, ${pctLess(t.saveModerate, t.perSession)}`, action: 'compress its output (Claude Code)',
    sessions: t.sessions ?? view.outputs?.sessions ?? 0, options: levelOpts(t),
  });
  // the first option is the suggestion; `total` is what it could have saved over the report's window: its saving a
  // session times the sessions that read it (a skill or tool, the sessions it was loaded in)
  return out.map(c => ({ ...c, saving: c.saving || 0, default: c.options[0] || null, total: (c.saving || 0) * c.sessions, days: view.days }));
}

const configOn = store => store.config().maintain?.contextSuggest !== false;

// The decisions on the changes (<cache>/state/context-suggest.json `history`, newest first): approved (its suggested
// action made), applied after review, or dismissed, with what came of it.
const readState = store => readJson(stateFile(store)) || {};
// each entry with an id (entries written before ids are given one, once) and whether Revert can take it back
export function changeHistory(store) {
  const st = readState(store), h = st.history || [];
  if (h.some(e => !e.id)) { for (const e of h) e.id ||= randomBytes(6).toString('hex'); writeJson(stateFile(store), st); }
  return h.map(e => ({ ...e, revertible: !e.revertedAt && Boolean(undoOf(store, e)) }));
}
function record(store, entries) {
  const st = readState(store);
  st.history = [...entries, ...(st.history || [])].slice(0, HISTORY_KEPT);
  writeJson(stateFile(store), st);
}
// what a decision undoes by, kept beside the history (a section's text before and after can be large); a switch-off or
// compression approved before these were kept is undone by its key
const undoFile = (store, id) => path.join(store.dir, 'state', 'context-suggest-undo', `${id}.json`);
const undoOf = (store, e) => e.decision === 'dismissed' ? { kind: 'dismissed' } : (e.id && readJson(undoFile(store, e.id)))
  || (e.decision === 'approved' && (e.kind === 'tool' || e.kind === 'skill') ? { kind: 'off', key: e.key.replace(/^[^:]+:/, '') }
    : e.decision === 'approved' && e.kind === 'output' ? { kind: 'output', name: e.key.replace(/^output:/, '') } : null);
const entryOf = (store, c, decision, result, now, undo) => {
  const id = randomBytes(6).toString('hex');
  if (undo) writeJson(undoFile(store, id), undo);
  return { id, at: new Date(now).toISOString(), key: c.key, ...(c.keys ? { keys: c.keys } : {}), kind: c.kind, title: c.title, saving: c.saving, total: c.total, days: c.days ?? null, action: c.default?.text || null, act: c.default?.act || null, decision, result: result || null, ...(undo ? { revertible: true } : {}) };
};
// The view's changes less the ones decided in the last month, the five largest: what the page, the session's summary
// and `thinker context` offer
export function currentChanges(store, view, { now = Date.now(), max = SUGGEST.max } = {}) {
  // a dismissal taken back makes its change a suggestion again
  const decided = new Set(changeHistory(store).filter(h => now - Date.parse(h.at) < DECIDED_DAYS * DAY && !(h.decision === 'dismissed' && h.revertedAt)).flatMap(h => h.keys || [h.key]));
  return (view.suggestions || topChanges(view, { max: 20 })).filter(c => !decided.has(c.key)).slice(0, max);
}
export function dismissChanges(store, changes, { now = Date.now() } = {}) {
  record(store, changes.map(c => entryOf(store, c, 'dismissed', null, now)));
  store.log({ op: 'context-dismiss', changes: changes.length });
  return changes.map(c => `${c.title}: dismissed; not suggested again for a month`);
}
// a section compressed on the page after its diff was read: the edit applied there, recorded here
export function recordReviewed(store, change, result, { now = Date.now(), undo = null } = {}) { record(store, [entryOf(store, change, 'applied after review', result, now, undo)]); }
// The page's Apply on a section after its diff was read (ui/server.js /api/changes/apply): the previewed edit written
// (instruction-edit.js:applyEdit) and recorded with the files as they were, so History's Revert writes them back.
// Several sections previewed together are one edit and one decision: reverting it puts the whole file back.
export async function applyReviewed(store, changes, editKey, files, { now = Date.now(), edit } = {}) {
  const { applyEdit } = edit || await import('./instruction-edit.js');
  const read = f => { try { return fs.readFileSync(path.join(store.repo, f), 'utf8'); } catch { return null; } };
  const names = [...new Set((Array.isArray(files) ? files : []).map(String).filter(Boolean))];
  const before = names.map(read);
  const a = applyEdit(store, editKey);
  if (a.error) return a;
  const c = changes.length === 1 ? changes[0] : { ...changes[0], key: changes.map(x => x.key).join(','), keys: changes.map(x => x.key), title: `${changes.length} sections: ${changes.map(x => x.title.replace(/^.*? · /, '')).join(', ')}`, saving: changes.reduce((s, x) => s + (x.saving || 0), 0), total: changes.reduce((s, x) => s + (x.total || 0), 0) };
  const undo = names.length ? { kind: 'edit', files: names.map((f, i) => ({ file: f, before: before[i], after: read(f) })) } : null;
  record(store, [entryOf(store, c, 'applied after review', a.said, now, undo)]);
  store.log({ op: 'context-approve', changes: changes.length, saving: c.saving || 0, reviewed: true });
  return a;
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
  const total = p.changes.reduce((a, c) => a + (c.total ?? c.saving), 0);
  store.log({ op: 'context-offer', changes: p.changes.length, saving: total, ui: Boolean(url) });
  const lines = p.changes.map((c, i) => `${i + 1}. ${c.title}: ~${formatTokens(c.total ?? c.saving)} input tokens over the last ${p.days} days; ${c.why}. Suggested: ${c.default ? c.default.text : 'dismiss, or change it by hand'}${c.options?.length > 1 ? ` (or: ${c.options.slice(1).map(o => o.act).join(', ')})` : ''}`).join('\n');
  const where = url ? `at ${suggestionsUrl(url, repoId)} (thinker's page on this machine, just started)` : 'by running `thinker ui` (Context, All)';
  return `<thinker-context-suggestions>
thinker read the last ${p.days} days of agent sessions in this repository (${p.sessions} sessions) and found ${p.changes.length === 1 ? 'one change' : `${p.changes.length} changes`} to what loads into every session that would have saved up to ~${formatTokens(total)} input tokens over those days together.
Before you start on the request, pass this on to the user in a short message starting "${SIGNATURE}:": one line per change below (what it is, what it saves, and the suggested action), then that they can approve or review each ${where}, or reply here with the numbers to approve (or "all"). Keep it under ten lines. Do not make any of these changes yourself, and do not open the files to check them. Then go on with the task.
If the user later approves some of them in this conversation, run \`thinker context --days 7 --approve <their numbers, comma-separated, or all; a number may take another action after a colon, e.g. 3:remove>\` and tell them in one line what it did.
${lines}
</thinker-context-suggestions>`;
}

// The person approved these changes (`thinker context --approve 1,3|all`, the page's Approve): each one's default,
// made as the Context tab makes it. A section is compressed by a model and written to the working tree, uncommitted,
// for git diff to review (instruction-edit.js); a skill or tool is switched off for this repository, `thinker harness
// --undo` turning it back on (context-view.js:switchSources); an output gets moderate compression (diet.js). A change
// with no default (nothing switches it off) is left for review on the page. Returns one line per change.
export async function approveChanges(store, changes, { edit } = {}) {
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
      return { result: `${c.default.act === 'remove' ? 'Removed' : 'Compressed'}: ~${formatTokens(p.tokensBefore)} → ~${formatTokens(p.tokensAfter)} tokens in ${p.file}, uncommitted`, undo: { kind: 'edit', files: files.map((f, i) => ({ file: f, before: before[i], after: read(f) })) } };
    }
    const r = switchSources(store, { labels: [c.label], builtin: Boolean(c.builtin) });
    return /^Switched off here/.test(r) && !/Not switched off/.test(r) ? { result: 'Switched off from the next session on', undo: { kind: 'off', key: c.sourceKey || c.name } } : { error: r.replace(/^Not switched off: /, '') };
  };
  for (const c of changes) {
    let m; try { m = await make(c); } catch (e) { m = { error: String(e.message || e).split('\n')[0] }; }
    said.push(`${c.title}: ${m.error || m.result}`);
    if (!m.error) record(store, [entryOf(store, c, 'approved', m.result, at, m.undo)]);
  }
  store.log({ op: 'context-approve', changes: changes.length, saving: changes.reduce((a, c) => a + c.saving, 0) });
  return said;
}

// A decision taken back (the page's Revert, `thinker context --revert <n>`): a switched-off tool or skill is turned back
// on (harness.js:undoHarness), an output's compression set back to none, a section's file written back as it was when
// the file is still what the approval wrote (else the person's later edits would go: git has it), a dismissal
// withdrawn so the change is suggested again. The entry stays in the history, marked reverted.
export async function revertDecision(store, id, { now = Date.now() } = {}) {
  const st = readState(store), e = (st.history || []).find(h => h.id === id);
  if (!e) return { error: 'no such decision' };
  if (e.revertedAt) return { error: 'already reverted' };
  const u = undoOf(store, e);
  if (!u) return { error: 'nothing kept to revert this one by' };
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
  const s2 = readState(store), x = s2.history.find(h => h.id === id);
  x.revertedAt = new Date(now).toISOString(); writeJson(stateFile(store), s2);
  try { fs.rmSync(undoFile(store, id), { force: true }); } catch {}
  store.log({ op: 'context-revert', kind: u.kind });
  return { said: `${e.title}: ${{ off: 'turned back on from the next session on', on: 'switched off again from the next session on', output: u.level && u.level !== 'off' ? `${u.level} compression again` : 'compression off', edit: 'written back as it was', dismissed: 'suggested again' }[u.kind]}` };
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
