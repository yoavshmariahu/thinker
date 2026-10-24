// What each section of a repository's instruction file (AGENTS.md, or CLAUDE.md) is worth, measured on the
// sessions agents ran here: what it costs (its tokens, read again on every model call of every session) against
// how often it bore on the work and whether the agent acted on it. A measurement for the person, never a rewrite
// of the team's file: what to keep is theirs to decide (a change is a pull request, instruction-edit.js).
//
//   applied   free, on every session: the session did what the section is about, by the triggers the
//             section's own text gives (instruction-sections.js:deriveTriggers): it named or edited a file of
//             the section's area, ran the command it is about (a commit, a pull request), or read code it names.
//             Replayed from the transcript's tool events. A section with no trigger is never "applied": the
//             judge alone says anything about it.
//   judged    a model call on a 25% sample of sessions as they end (VALUE.share; `instructions: { value: { judge:
//             false, share } }` in .thinker/config.json turns it off or changes the share; `thinker context --judge n`
//             judges n more by hand): shown the sections, what the session asked, the
//             commands it ran, the files it read and edited and its change, it names the sections that bore on
//             the session and says of each whether the agent followed it, went against it, or neither showed.
//             Through llm.js:complete, so a desktop app's session answers it (session-llm.js), within the daily
//             token cap. Logged as op "instruction-value".
//
// Kept per session in .thinker/state/instruction-value.json (this checkout's, never shared), by the transcript's
// size so a session that grew is read again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deriveTriggers, sectionFires, codeHits, globRegex as triggerGlob } from './instruction-sections.js';
import { diskCache, cacheKey } from './disk-cache.js';
import { parseTranscript, findSessions } from './transcripts.js';
import { complete, DEFAULT_DISTILL_MODEL } from './llm.js';
import { tokensOf } from './model-usage.js';
import { isTestMode } from './test-mode.js';
import { withinDailyCap } from './maintain.js';
import { outcomeSampled, sessionDiff, ruleGlobs, globRegex } from './skill-outcome.js';
import { execFileSync } from 'node:child_process';
import { checkouts } from './harness.js';

// Leaf sections: a "###" section on its own, a "##" one with the prose before its first "###"; the "#" title apart.
export function sections(text) {
  const out = []; let cur = null, parent = null; const head = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(#{2,3}) (.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      if (m[1].length === 2) parent = m[2];
      cur = { title: m[2], parent: m[1].length === 3 ? parent : null, level: m[1].length, lines: [line] };
    } else if (cur) cur.lines.push(line); else head.push(line);
  }
  if (cur) out.push(cur);
  const all = out.map(s => ({ ...s, text: s.lines.join('\n').trim(), tokens: Math.ceil(s.lines.join('\n').length / 4) }));
  all.head = head.join('\n').trim();
  return all;
}

export const VALUE = { share: 0.25, keepSessions: 500, diffChars: 30_000, sectionsChars: 60_000, commands: 60 };
// a section bearing on fewer than this share of the sessions that read it, with enough sessions to say so
export const RARE = { share: 0.1, minSessions: 5 };

export function valueConfig(store, env = process.env) {
  const c = store.config().instructions?.value || {};
  const v = env.THINKER_INSTRUCTION_JUDGE || '';
  const judge = /^(0|off|false)$/i.test(v) ? false : /^(1|on|true)$/i.test(v) ? true : !isTestMode(env) && c.judge !== false;
  return { judge, share: Number.isFinite(c.share) ? c.share : VALUE.share, model: c.model || null };
}

// The instruction file the agents read here, and which agents read it. Claude Code reads AGENTS.md when there is
// no CLAUDE.md, or when CLAUDE.md is AGENTS.md (a link, a copy, or `@AGENTS.md` alone); a CLAUDE.md with text of
// its own is what Claude Code reads instead, and then Claude Code's sessions say nothing about AGENTS.md.
export function instructionFile(repo) {
  const read = f => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } };
  const agents = read('AGENTS.md'), claude = read('CLAUDE.md');
  const sameAsAgents = claude != null && agents != null && (claude === agents || /^@?AGENTS\.md\s*$/.test(claude.trim()));
  if (agents != null) return { file: 'AGENTS.md', text: agents, notClients: claude == null || sameAsAgents ? [] : ['claude'] };
  if (claude != null) return { file: 'CLAUDE.md', text: claude, onlyClients: ['claude'] };
  return null;
}
const readsFile = (src, client) => src.onlyClients ? src.onlyClients.includes(client) : !src.notClients.includes(client);

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const sha = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// Every instruction file of the repository, with when a session reads it: the root file (above) in every session
// of the agents that read it; an AGENTS.md or CLAUDE.md in a directory below, when the session opens a file in
// that directory (Claude Code loads them lazily; Codex reads only those on the path to where it was started, the
// root's); a .claude/rules file with `paths:` when the session opens a matching file, one without at the start
// (Claude Code alone reads .claude/rules). A CLAUDE.md that is its directory's AGENTS.md counts once.
export function instructionFiles(repo) {
  const root = instructionFile(repo), out = root ? [{ ...root, kind: 'root' }] : [];
  let listed = []; try { listed = execFileSync('git', ['-C', repo, 'ls-files', '--', '*AGENTS.md', '*CLAUDE.md', '.claude/rules/*.md', '.claude/rules/**/*.md'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch {}
  const read = f => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } };
  for (const f of [...new Set(listed)].sort()) {
    if (f === 'AGENTS.md' || f === 'CLAUDE.md') continue;
    const text = read(f); if (text == null || !text.trim()) continue;
    if (f.startsWith('.claude/rules/')) { const globs = ruleGlobs(text); out.push({ file: f, text, kind: 'rule', globs, onlyClients: ['claude'] }); continue; }
    const dir = path.dirname(f), base = path.basename(f);
    if (base !== 'AGENTS.md' && base !== 'CLAUDE.md') continue;
    if (base === 'CLAUDE.md') { const a = read(path.join(dir, 'AGENTS.md')); if (a != null && (a === text || /^@?AGENTS\.md\s*$/.test(text.trim()))) continue; }
    out.push({ file: f, text, kind: 'nested', dir, onlyClients: ['claude'] });
  }
  return out;
}
// Whether a session read a file: by its agent, and for a nested file or a rule, by the files it opened.
export function fileLoaded(f, client, touched) {
  if (!readsFile(f, client)) return false;
  if (f.kind === 'nested') return touched.some(p => p.startsWith(f.dir + '/'));
  if (f.kind === 'rule' && f.globs?.length) { const res = f.globs.map(globRegex); return touched.some(p => res.some(r => r.test(p))); }
  return true;
}
const touchedFiles = activity => [...new Set([...activity.read, ...activity.edited, ...activity.calls.flatMap(c => c.files)])];
// a section's id: the root file's as before, another file's prefixed by its path
export const sectionId = (file, s) => { const id = slug(s.parent ? `${s.parent} ${s.title}` : s.title); return file.kind === 'root' ? id : `${slug(file.file)}--${id}`; };

// The sections with an id, their tokens and their triggers; the triggers kept by the section's text, since
// deriving them greps the repository.
export function valueSections(store, files = instructionFiles(store.repo)) {
  if (!Array.isArray(files)) files = files ? [{ ...files, kind: 'root' }] : [];
  if (!files.length) return [];
  const file = path.join(store.dir, 'state', 'instruction-triggers.json');
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let changed = false;
  // a file without headings (a rule, a short nested file) is one section, titled by its path
  const split = f => { const ss = sections(f.text); return ss.length ? ss.filter(s => s.text.split('\n').slice(1).join('\n').trim()) : [{ title: f.file, parent: null, level: 2, text: f.text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(), tokens: Math.ceil(f.text.length / 4), whole: true }]; };
  const out = files.flatMap(f => split(f).map(s => ({ s, f }))).map(({ s, f }) => {
    const id = sectionId(f, s), key = sha(s.text);
    // a nested file or a rule already says where it applies (its directory, its paths): that is its trigger, and
    // grepping a large repository for every name it holds (PostHog has 129 such files) is not needed
    let t;
    if (f.kind === 'nested') t = { paths: [`^${f.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`], edits: [], code: [], cmd: null };
    else if (f.kind === 'rule') t = { paths: (f.globs || []).map(triggerGlob), edits: [], code: [], cmd: null };
    else { if (!cache[key]) { cache[key] = deriveTriggers(store.repo, { title: s.title, text: s.text }); changed = true; } t = cache[key]; }
    const any = t.paths?.length || t.edits?.length || t.code?.length || t.codeRe?.length || t.cmd;
    return { id, file: f.file, fileKind: f.kind, title: s.title, parent: s.parent, whole: !!s.whole, tokens: s.tokens, text: s.text, triggers: t, triggered: Boolean(any) };
  });
  if (changed) {
    const keep = new Set(out.map(s => sha(s.text)));
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([k]) => keep.has(k))))); } catch {}
  }
  return out;
}

// --- one session ---------------------------------------------------------------------------------------------
const rel = (repo, f) => { const r = path.isAbsolute(f) ? path.relative(repo, f) : f.replace(/^\.\//, ''); return r && !r.startsWith('..') ? r : null; };
const PATHS = /(?:^|[\s'"`=:(\[])(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})(?=$|[\s'"`:|;)\],])/gm;

// What a session did, as the section triggers read it: per tool call the files it named or edited, the command
// it ran and what it printed; plus the prompts, commands and files the judge is shown.
export function sessionActivity(repo, events) {
  const calls = [], read = new Set(), edited = new Set(), commands = [], prompts = [];
  let answer = '';
  for (const e of events) {
    if (e.t === 'prompt') { prompts.push(e.text); continue; }
    if (e.t === 'say') { answer = e.text; continue; }
    if (e.t !== 'tool') continue;
    const inp = e.input || {}, command = typeof inp.command === 'string' ? inp.command : '';
    const named = [];
    for (const k of ['file_path', 'path']) if (typeof inp[k] === 'string') { const r = rel(repo, inp[k]); if (r) named.push(r); }
    for (const m of command.matchAll(PATHS)) { const r = rel(repo, m[1]); if (r) named.push(r); }
    const patched = [...JSON.stringify(inp).matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g)].map(m => rel(repo, m[1])).filter(Boolean);
    const edits = e.name === 'Edit' || e.name === 'Write' ? [...named, ...patched] : [];
    const seen = [];
    for (const m of String(e.result || '').slice(0, 200_000).matchAll(PATHS)) { const r = rel(repo, m[1]); if (r && seen.length < 40) seen.push(r); }
    for (const f of edits) edited.add(f);
    if (!edits.length) for (const f of named) read.add(f);
    if (command) commands.push(command);
    calls.push({ files: [...named, ...edits, ...seen], command, output: String(e.result || '').slice(0, 200_000), read: edits.length ? [] : named, edited: edits });
  }
  return { calls, read: [...read], edited: [...edited], commands, prompts, answer };
}

// The sections a session's tool calls fired, each with how it first fired.
export function appliedSections(secs, activity) {
  const out = {};
  for (const c of activity.calls) for (const s of secs) {
    if (out[s.id] || !s.triggered) continue;
    const how = sectionFires(s, c);
    if (how) out[s.id] = how;
  }
  return out;
}

// --- the state -----------------------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'instruction-value.json');
export const readValueState = store => { try { const j = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); return { sessions: j.sessions || {} }; } catch { return { sessions: {} }; } };
function writeValueState(store, st) {
  const ids = Object.keys(st.sessions).sort((a, b) => (st.sessions[a].mtime || 0) - (st.sessions[b].mtime || 0));
  for (const id of ids.slice(0, Math.max(0, ids.length - VALUE.keepSessions))) delete st.sessions[id];
  try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(st)); } catch {}
}

// The code names and patterns the sections' triggers look for in what source files printed (instruction-sections.js:
// codeHits): a session's kept activity holds which of them each tool event's output had, in place of the output.
const codeNames = secs => { const names = new Set(), res = new Set(); for (const s of secs) { for (const c of s.triggers?.code || []) names.add(c); for (const c of s.triggers?.codeRe || []) res.add(c); } return { names: [...names].sort(), res: [...res].sort() }; };
// whether an activity kept for the names `had` answers for `want`: every name and pattern wanted was looked for
export const coversCode = (had, want) => want.names.every(c => had?.names?.includes(c)) && want.res.every(c => had?.res?.includes(c));
// What the sections need of a session's tool calls, without the outputs: per call the files it named, its command (cut),
// the files it edited and the code names its output held. A call that named nothing and ran nothing fires no section.
const compactActivity = (activity, code) => ({
  read: activity.read, edited: activity.edited,
  calls: activity.calls.filter(c => c.files.length || c.command).map(c => ({ files: c.files, command: c.command.slice(0, 2000), edited: c.edited, hits: codeHits(c, code) })),
});
// kept on this machine by the transcript's size (disk-cache.js; none in the suite unless a test names a directory)
const ACTIVITY_CACHE = diskCache('session-activity', 1);

// A session's record: its transcript is read once, and what the sections need of it kept (compactActivity); the
// sections' triggers are matched again from that when the instruction files change, and the transcript is read again
// only when it grew, or the sections name code they did not name before (its outputs must be searched for it). Until
// 2026-10-24 any change to the instruction files re-read every transcript of the window on the next visit to the
// page, gigabytes on this repository, thirty seconds under load. The verdicts are kept across both.
function sessionRecord(store, st, s, secs, srcHash, files) {
  let size = 0; try { size = fs.statSync(s.file).size; } catch { return null; }
  const prev = st.sessions[s.session];
  if (prev && prev.size === size && prev.src === srcHash) return prev;
  const code = codeNames(secs), key = cacheKey('activity', store.repo, s.file);
  let kept = ACTIVITY_CACHE.get(key);
  if (!kept || kept.size !== size || !coversCode(kept.code, code)) {
    let parsed; try { parsed = parseTranscript(s.file); } catch { return null; }
    const empty = !parsed.events.some(e => e.t === 'tool' || e.t === 'prompt');
    kept = { size, code, empty, turns: parsed.stats?.turns || 0, activity: empty ? null : compactActivity(sessionActivity(store.repo, parsed.events), code) };
    ACTIVITY_CACHE.set(key, kept);
  }
  if (kept.empty) return null;
  const activity = kept.activity, touched = touchedFiles(activity);
  const loaded = (files || []).filter(f => fileLoaded(f, s.client, touched)).map(f => f.file);
  const rec = { client: s.client, file: s.file, mtime: s.mtime, size, src: srcHash, turns: kept.turns, loaded, applied: appliedSections(secs.filter(x => loaded.includes(x.file)), activity), edited: activity.edited.length, ...(prev?.judged ? { judged: prev.judged } : {}) };
  st.sessions[s.session] = rec;
  return rec;
}

// --- the judge -----------------------------------------------------------------------------------------------
export const VALUE_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the id of the section, exactly as given after [id:' },
          verdict: { type: 'string', enum: ['followed', 'violated', 'applicable'] },
          evidence: { type: 'string', description: 'one sentence: what in the session shows it, quoting a command, a file or a diff line' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
  },
  required: ['sections'],
};
export const VALUE_SYSTEM = `You read what a coding agent did in one session and say which sections of the repository's instruction file bore on that work.

List a section only when it bears on what the session actually did: the files it read or changed, the commands it ran, the change it made, what it was asked. Leave out every section that did not come up. Most sessions touch a few sections; an empty list is a valid answer.

For each section you list, one verdict:
- followed: the session did what the section asks in a way you can point to (a command it ran, a convention the diff keeps, a file it updated together with another), where the section is what told it so.
- violated: the session's work goes against what the section asks (the diff breaks its rule, it ran what the section forbids, it skipped a step the section requires for exactly this kind of change).
- applicable: the section bore on the work but the session shows neither following nor breaking it.

Judge only by the section's own words and the evidence given; no general best practice. When in doubt between followed and applicable, say applicable.`;

export function valuePrompt(secs, activity, diff) {
  let used = 0;
  const shown = [];
  for (const s of secs) { if (used + s.text.length > VALUE.sectionsChars) break; used += s.text.length; shown.push(`[id: ${s.id}]\n${s.text.trim()}`); }
  const cut = (s, n) => String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || '');
  const cmds = [...new Set(activity.commands.map(c => cut(c.replace(/\s+/g, ' '), 200)))].slice(-VALUE.commands);
  return `INSTRUCTION FILE SECTIONS:\n\n${shown.join('\n\n')}\n\nSESSION\nAsked:\n${activity.prompts.slice(0, 3).map(p => `- ${cut(p, 600)}`).join('\n') || '(nothing recorded)'}\n\nCommands run:\n${cmds.map(c => `- ${c}`).join('\n') || '(none)'}\n\nFiles read: ${activity.read.slice(0, 60).join(', ') || '(none)'}\nFiles edited: ${activity.edited.slice(0, 60).join(', ') || '(none)'}\n\nThe agent's last message:\n${cut(activity.answer, 1500) || '(none)'}\n\nCHANGE${diff.length > VALUE.diffChars ? ` (cut at ${VALUE.diffChars} of ${diff.length} characters)` : ''}:\n${diff.slice(0, VALUE.diffChars) || '(no change in the working tree)'}`;
}

export async function judgeSession(store, { secs, activity, diff = '', model, completeFn = complete, accounting }) {
  const res = await completeFn({ system: VALUE_SYSTEM, prompt: valuePrompt(secs, activity, diff), model: model || store.config().distillModel || DEFAULT_DISTILL_MODEL, schema: VALUE_SCHEMA, maxTokens: 3000, thinkingTokens: 0, structuredRetries: 1, accounting });
  const ids = new Set(secs.map(s => s.id)), verdicts = {};
  for (const v of Array.isArray(res.json?.sections) ? res.json.sections : []) {
    if (!v || !ids.has(v.id) || !['followed', 'violated', 'applicable'].includes(v.verdict) || verdicts[v.id]) continue;
    verdicts[v.id] = { verdict: v.verdict, evidence: String(v.evidence || '').slice(0, 300) };
  }
  return { verdicts, tokens: tokensOf(res), cost: res.cost ?? null, model: res.model || null };
}

// Judge one session now and keep the verdicts on its record. `force` judges a session judged before.
export async function judgeSessionFile(store, file, { session, client = null, phase = 'learning', completeFn = complete, force = false, now = Date.now() } = {}) {
  const files = instructionFiles(store.repo);
  if (!files.length) return { skipped: 'no-file' };
  const all = valueSections(store, files), srcHash = sha(files.map(f => f.file + f.text).join('\0')), st = readValueState(store);
  let mtime = now; try { mtime = fs.statSync(file).mtimeMs; } catch {}
  const id = session || path.basename(file).replace(/\.jsonl?$/, '');
  const rec = sessionRecord(store, st, { file, session: id, client, mtime }, all, srcHash, files);
  // the judge is shown the sections of the files this session read
  const secs = all.filter(x => (rec?.loaded || [files[0].file]).includes(x.file));
  const src = files[0];
  if (!rec) return { skipped: 'empty' };
  if (rec.judged && !force) return { skipped: 'judged' };
  if (phase !== 'init' && !withinDailyCap(store).ok) { store.log({ op: 'instruction-value', session: id, skipped: 'daily-cap' }); return { skipped: 'daily-cap' }; }
  const activity = sessionActivity(store.repo, parseTranscript(file).events);
  let start = null; try { start = new Date(fs.statSync(file).birthtimeMs).toISOString(); } catch {}
  const diff = activity.edited.length ? sessionDiff(store.repo, activity.edited, { start }) : '';
  const cfg = valueConfig(store);
  const r = await judgeSession(store, { secs, activity, diff, model: cfg.model, completeFn, accounting: { store, phase, session: id, purpose: 'instruction-value' } });
  rec.judged = { at: new Date(now).toISOString(), verdicts: r.verdicts };
  writeValueState(store, st);
  store.log({ op: 'instruction-value', session: id, file: src.file, sections: Object.fromEntries(Object.entries(r.verdicts).map(([k, v]) => [k, v.verdict])), tokens: r.tokens ?? undefined, cost: r.cost ?? undefined, metered: true, phase });
  return { verdicts: r.verdicts, tokens: r.tokens };
}

// The end-of-session path (commands/learn.js:distillFile): on a share of sessions by their id, when the switch is on.
export async function instructionValueCheck(store, file, { session, phase, completeFn = complete, env = process.env } = {}) {
  const cfg = valueConfig(store, env);
  if (!cfg.judge || !outcomeSampled(session || file, cfg.share)) return null;
  return judgeSessionFile(store, file, { session, phase, completeFn });
}

// Judge `n` sessions not judged yet, sampled over the window (`thinker context --judge n`, the page's button).
// A session written to in the last IDLE_MS is still running (this one, or another agent's): judged once it is quiet.
export const IDLE_MS = 20 * 60_000;
export async function judgeRecent(store, { n = 5, days = 30, completeFn = complete, sessions, onEach, now = Date.now() } = {}) {
  const files = instructionFiles(store.repo);
  if (!files.length) return { judged: 0, skipped: 'no-file' };
  const st = readValueState(store);
  sessions ??= findRepoSessions(store.repo, days);
  const src = files[0];
  let judged = 0, tokens = 0;
  // a sample spread over the window (by a hash of the session id), not the newest sessions alone
  const order = s => parseInt(createHash('sha1').update(String(s.session)).digest('hex').slice(0, 8), 16);
  for (const s of sessions.filter(s => readsFile(src, s.client)).sort((a, b) => order(a) - order(b))) {
    if (judged >= n) break;
    if (st.sessions[s.session]?.judged || now - s.mtime < IDLE_MS) continue;
    const r = await judgeSessionFile(store, s.file, { session: s.session, client: s.client, completeFn, phase: 'manual' });
    if (r.skipped === 'daily-cap') return { judged, tokens, skipped: 'daily-cap' };
    if (r.skipped) continue;
    judged++; tokens += r.tokens || 0; onEach?.(s, r);
  }
  return { judged, tokens };
}

// --- the report ----------------------------------------------------------------------------------------------
export function findRepoSessions(repo, days) {
  return [...new Map(checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 })).map(s => [s.file, s])).values()].sort((a, b) => b.mtime - a.mtime);
}
const median = xs => { const a = xs.filter(n => Number.isFinite(n) && n > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

// Per section over the window: tokens, what it costs a session (tokens × the median model calls), the sessions
// that read it, how many it bore on (applied), and the judged verdicts with the share followed.
export function instructionValue(store, { days = 30, sessions } = {}) {
  const files = instructionFiles(store.repo);
  // no instruction file: the same shape, empty, so the Context view of such a repository still renders
  if (!files.length) return { file: null, files: [], tokens: 0, sessions: 0, judged: 0, calls: 0, judge: valueConfig(store), sections: [], timeline: [], savings: { perSession: 0, sections: 0, share: 0, window: 0 } };
  const secs = valueSections(store, files), srcHash = sha(files.map(f => f.file + f.text).join('\0')), st = readValueState(store);
  sessions ??= findRepoSessions(store.repo, days);
  const recs = [];
  for (const s of sessions) {
    if (!files.some(f => readsFile(f, s.client))) continue;
    const r = sessionRecord(store, st, s, secs, srcHash, files);
    if (r) recs.push({ ...r, session: s.session });
  }
  writeValueState(store, st);
  // sessions recorded before the files were counted read the root file only
  const loadedIn = r => r.loaded || [files[0].file];
  const reading = recs.filter(r => loadedIn(r).length);
  const calls = median(reading.map(r => r.turns)), n = reading.length;
  const rows = secs.map(s => {
    // a section counts in the sessions that read its file: what it costs is averaged over every session
    const mine = reading.filter(r => loadedIn(r).includes(s.file)), judged = mine.filter(r => r.judged);
    const applied = mine.filter(r => r.applied[s.id]).length;
    const v = { followed: 0, violated: 0, applicable: 0 };
    for (const r of judged) { const x = r.judged.verdicts[s.id]; if (x) v[x.verdict]++; }
    const bore = v.followed + v.violated + v.applicable;
    const decided = v.followed + v.violated;
    const perSession = Math.round(s.tokens * Math.max(1, calls) * (n ? mine.length / n : 0));
    return {
      id: s.id, file: s.file, fileKind: s.fileKind, title: s.title, parent: s.parent, whole: s.whole, tokens: s.tokens, perSession, loadedIn: mine.length,
      sessions: mine.length, triggered: s.triggered, applied, judged: judged.length, ...v,
      // a share of the sessions judged that the section bore on, and of those it decided, how many it was followed in
      bore, boreShare: judged.length ? bore / judged.length : null, success: decided ? v.followed / decided : null,
      value: valueOf({ sessions: mine.length, applied, triggered: s.triggered, judged: judged.length, bore, followed: v.followed, violated: v.violated }),
      ...use({ sessions: mine.length, applied, triggered: s.triggered, judged: judged.length, followed: v.followed }, perSession),
      text: s.text,
    };
  });
  const judged = reading.filter(r => r.judged), recsAll = recs;
  // the waste flag: a section used in under half the sessions whose cost there is a large share of the file's
  const fileCost = rows.reduce((a, r) => a + r.perSession, 0);
  for (const r of rows) Object.assign(r, wasteLevel(r, fileCost));
  const flagged = rows.filter(r => r.waste === 'high' || r.waste === 'medium');
  const savings = { perSession: flagged.reduce((a, r) => a + r.wasted, 0), sections: flagged.length };
  savings.share = fileCost ? savings.perSession / fileCost : 0;
  savings.window = savings.perSession * n;
  const tok = f => Math.ceil(f.text.length / 4), fileTokens = tok(files[0]);
  // per session, for the trend: the tokens of the files it read, read again by each of its model calls (today's
  // files: an earlier size is not kept)
  // `files`: which instruction files the session read, so the Report can cost one section a session before and since its change (report.js:actionEffect)
  const timeline = reading.filter(r => r.turns).map(r => ({ t: r.mtime, session: r.session, client: r.client, calls: r.turns, tokens: files.filter(f => loadedIn(r).includes(f.file)).reduce((a, f) => a + tok(f), 0), files: loadedIn(r) }));
  const fileRows = files.map(f => ({ file: f.file, kind: f.kind, tokens: tok(f), loadedIn: reading.filter(r => loadedIn(r).includes(f.file)).length, ...(f.globs?.length ? { globs: f.globs } : {}), ...(f.dir ? { dir: f.dir } : {}) }));
  const label = files.length === 1 ? files[0].file : `${files[0].file} + ${files.length - 1} more`;
  return { file: label, files: fileRows, tokens: fileTokens, sessions: n, judged: judged.length, calls, judge: valueConfig(store), sections: rows, timeline, savings };
}

// How often sessions acted on a section, and the tokens spent on it in the sessions that did not: from the judge's
// verdicts (followed) once enough sessions are judged, else from its triggers (broad: a section about a common path applies
// often), else unknown. `wasted` ranks the sections that cost most for least.
// Acted on: the judged sessions whose agent followed the section (a verdict of followed), once enough are judged.
export function use({ sessions, applied, triggered, judged, followed = 0 }, perSession) {
  const [share, by] = judged >= RARE.minSessions ? [followed / judged, 'judge'] : triggered && sessions ? [applied / sessions, 'triggers'] : [null, null];
  return { usedShare: share, usedBy: by, wasted: share == null ? null : Math.round(perSession * (1 - share)) };
}

// Wasted is what a part cost in the sessions that did not use it. High waste: 5% or more of what its kind (the file,
// the skills, the tools) costs a session; medium: 2%; else low. That is the whole rule (until 2026-10-22 a part used in
// half the sessions or more was never flagged, whatever it cost in the rest; dropped, the owner found the two-part rule
// hard to read). The saving is that cost, at most: a session that needed the part would go without. Unknown while
// there is nothing to say how often it is used.
export const WASTE = { high: 0.05, medium: 0.02 };
export function wasteLevel(r, kindCost) {
  if (r.wasted == null) return { waste: 'unknown', wasteShare: null };
  const share = kindCost ? r.wasted / kindCost : 0;
  return { waste: share >= WASTE.high ? 'high' : share >= WASTE.medium ? 'medium' : 'low', wasteShare: share };
}

// A plain label for the table: `used` when sessions acted on it, `rare` when it bore on almost none, `unknown`
// while there is too little to say.
export function valueOf({ sessions, applied, triggered, judged, bore, followed, violated }) {
  if (judged >= RARE.minSessions) {
    if (followed + violated > 0 && (followed + violated) / judged >= RARE.share) return 'used';
    if (bore / judged < RARE.share) return 'rare';
    return 'situational';
  }
  if (triggered && sessions >= RARE.minSessions) return applied / sessions >= RARE.share ? 'situational' : 'rare';
  return 'unknown';
}
