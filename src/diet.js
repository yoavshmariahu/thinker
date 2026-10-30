// The context diet: a tool's result replaced before it enters the agent's context (off until an
// experiment, 2026-10-18). Claude Code's PostToolUse hook may answer with `updatedToolOutput`, which
// replaces the result the model reads; nothing thinker serves ever leaves the context again, and on a
// 60-call Opus session re-reading the accumulated context was over half the bill, so this is the one
// place where tokens can be taken out instead of added. Three results are trimmed:
//   - a whole file read through Read, cat or sed: the lines around the agent's recent search terms and
//     the request's identifiers, with an outline of what the omitted ranges define and how to read
//     any range (replaying 442 bare sessions, the region held the agent's next edit 20 of 23 times
//     and every gold hunk 149 of 166; a file with no hit, or where the hits cover most of it, is
//     passed whole);
//   - a test run: the counts and each distinct failure cause once, the full log kept in a file
//     (testing.js, as `thinker test` prints it);
//   - a large search: the hits grouped per file, a few per file.
// Everything else passes untouched. `diet` in .thinker/config.json turns it on; THINKER_DIET=on|off
// overrides it for an experiment arm.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { outlineText } from './codegraph.js';
import { sessionState, locked } from './ops.js';
import { classifyTestCommand, parseTestOutput, summarize, stripAnsi, testsConfig, logPathFor, pruneLogs } from './testing.js';
import { textOf } from './transcripts.js';
import { bashProgram, toolKey } from './tool-outputs.js';

export const DIET = {
  enabled: false,
  minLines: 120,     // a file shorter than this is passed whole
  window: 40,        // lines kept on each side of a hit
  cap: 0.6,          // when the kept lines reach this share of the file, it is passed whole
  terms: 8,          // recent search patterns remembered
  tests: true,       // test runs are summarized
  testChars: 2000,   // a test output shorter than this is passed whole
  searchChars: 8000, // a search output shorter than this is passed whole
  perFile: 3,        // matching lines kept per file in a grouped search
  maxFiles: 40,      // files kept in a grouped search
};
// Per tool, from the Context tab or `thinker context --output-compression`: `diet: { tools: { Bash: 'high', Read:
// 'moderate' } }` compresses those tools' results and no other's. Moderate is the trims above as measured; high keeps
// less of each (a narrower window round the hits, one hit a file, shorter test summaries) and caps any other output
// of the tool. A config without `tools` (`diet: true`) is moderate for every tool it knows.
export const DIET_LEVELS = {
  moderate: { outputChars: 12000 },
  high: { window: 15, cap: 0.35, searchChars: 3000, perFile: 1, maxFiles: 15, testChars: 1000, outputChars: 4000 },
};
// Every number a level or the defaults hold, so `diet: { outputChars: 4000 }` in .thinker/config.json
// is kept rather than overwritten by the level it is used with (dietConfig keeps them as `given`).
export const DIET_TUNABLE = new Set([...Object.keys(DIET), ...Object.values(DIET_LEVELS).flatMap(l => Object.keys(l))].filter(k => k !== 'enabled' && k !== 'tools'));
// the tools whose results the diet can replace (Claude Code's PostToolUse, checked against each one's output shape),
// and any MCP server's tools (`mcp:<server>`, 2026-10-22: the text of a result capped at the level's length, through
// `updatedMCPToolOutput`, which Claude Code passes through unchecked; images in it are left as they are).
// A shell command can have its own level by its program (`Bash:sed`), else Bash's.
export const COMPRESSIBLE = ['Bash', 'Read'];
export const compressible = name => COMPRESSIBLE.includes(name) || String(name).startsWith('Bash:') || String(name).startsWith('mcp:');
export const isMcp = name => String(name).startsWith('mcp__');
// An MCP server takes the moderate level alone (2026-10-22): over 30 days of this machine's sessions the high cap
// kept 28–58% of the tokens the agent went on to use from a large MCP result, moderate 65–99%; what is used sits
// anywhere in the result, so a tighter cap is a loss, not a saving. A level set before is read as moderate.
export const mcpLevel = level => level ? 'moderate' : null;
export const toolLevel = (cfg, name, input) => {
  if (!cfg.tools) return cfg.enabled ? 'moderate' : null;
  if (name === 'Bash' && input?.command) { const own = cfg.tools[`Bash:${bashProgram(input.command)}`]; if (own) return own; }
  if (isMcp(name)) return mcpLevel(cfg.tools[toolKey(name)]);
  return cfg.tools[name] || null;
};
// The level a config gives an output row's tool (a toolKey: `Read`, `Bash:sed`, `mcp:artemis`), as toolLevel gives the
// call: a shell program's own level, else Bash's; an MCP server's read as moderate; a config without `tools` moderate for
// every compressible tool when on.
export const levelOf = (cfg, name) => {
  if (!cfg) return null;
  if (!cfg.tools) return cfg.enabled && compressible(name) ? 'moderate' : null;
  if (String(name).startsWith('mcp:')) return mcpLevel(cfg.tools[name]);
  return cfg.tools[name] || (String(name).startsWith('Bash:') ? cfg.tools.Bash : null) || null;
};
// The levels in force over time, so a tool's output is measured under each setting it ran with (tool-outputs.js): a
// compressed `sed` is another row than `sed` before, and the two are compared, not averaged. The record is the log of
// every setting made (`op: "diet-settings"`, written by setDietLevel for the page, `thinker context --output-compression`
// and History's Revert alike), each a snapshot of `tools` at its time. `levelAt(name, at)` is the level `name` had at
// `at` (ms): the latest snapshot not after it, none before the first (the diet is off until a setting is made). The
// config of now is the truth from the last snapshot on: a config edited by hand differs from it, and changed at some
// time after it that nothing recorded; with no snapshot at all (THINKER_LOG off, a config written by hand) it applies to
// all time, the only record there is.
export function dietTimeline(cfg, log = []) {
  const snaps = log.filter(e => e && e.op === 'diet-settings' && e.tools && typeof e.tools === 'object').map(e => ({ at: Date.parse(e.t) || 0, cfg: { tools: e.tools, enabled: Object.keys(e.tools).length > 0 } })).sort((a, b) => a.at - b.at);
  const now = { tools: cfg?.tools, enabled: Boolean(cfg?.enabled) };
  if (snaps.length) snaps[snaps.length - 1] = { at: snaps[snaps.length - 1].at, cfg: now };
  const levelAt = (name, at) => {
    if (!snaps.length) return levelOf(now, name);
    let c = null;
    for (const s of snaps) { if (at != null && s.at > at) break; c = s.cfg; }
    return levelOf(c, name);
  };
  // when `name` last came to `level` (ms): the start of the latest run of snapshots giving it, null when none does now
  const since = (name, level) => { let t = null; for (const s of snaps) { if (levelOf(s.cfg, name) === level) { t ??= s.at; } else t = null; } return t; };
  // `key` names this timeline (the snapshots and the config of now), so a record attributed under another one, or under
  // none, is made again (tool-outputs.js:sessionRecords)
  const key = createHash('sha1').update(JSON.stringify(snaps.map(s => [s.at, s.cfg.tools || null, s.cfg.enabled]))).digest('hex').slice(0, 12);
  return { levelAt, since, changes: snaps.map(s => s.at), key };
}

export function setDietLevel(store, tools, level) {
  const file = path.join(store.dir, 'config.json');
  let c = {}; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const d = c.diet && typeof c.diet === 'object' ? c.diet : {};
  d.tools ||= {};
  for (const t of tools) { if (!compressible(t)) continue; if (level === 'high' || level === 'moderate') d.tools[t] = t.startsWith('mcp:') ? mcpLevel(level) : level; else delete d.tools[t]; }
  d.enabled = Object.keys(d.tools).length > 0;
  c.diet = d;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  store.log({ op: 'diet-settings', tools: d.tools });
  return d.tools;
}

export function dietConfig(store, over = {}) {
  const c = store?.config?.().diet;
  const given = c && typeof c === 'object' ? c : {};
  const cfg = { ...DIET, ...(c === true ? { enabled: true } : given), ...over };
  // the settings a person named, kept apart: a level's defaults must not overwrite them (set below)
  cfg.given = Object.fromEntries(Object.entries({ ...given, ...over }).filter(([k]) => DIET_TUNABLE.has(k)));
  if (cfg.tools && typeof cfg.tools === 'object' && c?.enabled === undefined) cfg.enabled = Object.keys(cfg.tools).length > 0;
  const env = process.env.THINKER_DIET;
  if (env === 'on' || env === '1') cfg.enabled = true;
  else if (env === 'off' || env === '0') cfg.enabled = false;
  return cfg;
}

// --- what the agent is looking for ------------------------------------------------------------
// The terms that centre a trimmed file: the patterns of the session's recent searches (Grep, rg, grep)
// and the identifier-shaped words of the request, kept in the session state by the hooks.
const STOP = new Set(('the and for with that this from into when then than have does should would could where which while about after before being ' +
  'there their these those will also only just like such each other some more most onto over under between within without implement following change ' +
  'repository install dependencies summarize changed please make sure').split(' '));
export function promptTerms(text) {
  const out = new Set();
  const t = String(text || '').replace(/<thinker-[a-z]+>[\s\S]*?<\/thinker-[a-z]+>/g, '');
  for (const m of t.matchAll(/`([^`\n]{3,80})`/g)) for (const w of m[1].split(/[^A-Za-z0-9_.]+/)) if (w.length >= 4) out.add(w);
  for (const m of t.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) { const w = m[0]; if (STOP.has(w.toLowerCase())) continue; if (/_|\d|[a-z][A-Z]/.test(w)) out.add(w); }
  return [...out].slice(0, 40);
}
export function searchTerms(name, input = {}) {
  if (name === 'Grep') return input.pattern ? [String(input.pattern)] : [];
  if (name !== 'Bash') return [];
  const out = [];
  for (const m of String(input.command || '').matchAll(/(?:^|[|;&(]\s*)(?:rg|grep|egrep|git\s+grep)\b([^|;&\n]*)/g)) {
    const args = m[1].match(/'[^']*'|"[^"]*"|\S+/g) || []; let pat = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e' || a === '--regexp') { pat = args[++i]; break; }
      if (a.startsWith('-')) { if (/^-[A-C]$|^--(?:include|exclude|glob|type|max-count)$|^-[a-zA-Z]*[ABCmg]$/.test(a)) i++; continue; }
      pat = a; break;
    }
    if (pat) out.push(pat.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}
export function rememberTerms(store, session, { prompt, name, input } = {}) {
  if (!session || session === 'unknown' || !store?.exists?.()) return;
  const pt = prompt ? promptTerms(prompt) : null, st2 = name ? searchTerms(name, input) : [];
  if (!pt && !st2.length) return;
  locked(store, session, () => {
    const { st, save } = sessionState(store, session);
    if (pt) st.dietPrompt = pt;
    if (st2.length) st.dietTerms = [...(st.dietTerms || []), ...st2].slice(-DIET.terms);
    save();
  });
}
function termsOf(store, session, cfg) {
  if (!session || session === 'unknown') return [];
  const { st } = sessionState(store, session);
  return [...(st.dietTerms || []).slice(-cfg.terms), ...(st.dietPrompt || [])];
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(term) {
  const t = String(term).replace(/\\b/g, '').trim();
  if (t.length < 3) return null;
  try { return new RegExp(t, 'i'); } catch { return new RegExp(escapeRe(t), 'i'); }
}

// --- a file, trimmed to the lines around the hits -------------------------------------------------
function headerEnd(lines) { let e = 0; for (let i = 0; i < Math.min(lines.length, 80); i++) if (/^(import\b|from\b|use |#include|require\(|const .* = require|package )/.test(lines[i])) e = i + 1; return e; }
// {text, kept, n, hits} or {skip: why}. `how` names the tool the agent used, for the line that says
// how to read an omitted range.
// `numbered: false` keeps every line in place, an omitted range as its marker followed by empty lines:
// for the Read tool, whose result Claude Code numbers itself from the file's first line (verified
// 2026-10-18: a numbered text came out numbered twice, and a plain string was refused), so the only way
// to keep the numbers right is to keep the count.
export function trimFile(text, { file, terms = [], window = DIET.window, cap = DIET.cap, minLines = DIET.minLines, how = 'sed', numbered = true } = {}) {
  const lines = String(text).split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const n = lines.length;
  if (n < minLines) return { skip: 'small', n };
  const ms = terms.map(matcher).filter(Boolean);
  if (!ms.length) return { skip: 'no-terms', n };
  const hits = []; for (let i = 0; i < n; i++) if (ms.some(m => m.test(lines[i]))) hits.push(i);
  if (!hits.length) return { skip: 'no-hits', n };
  const keep = new Uint8Array(n);
  for (const h of hits) for (let q = Math.max(0, h - window); q <= Math.min(n - 1, h + window); q++) keep[q] = 1;
  for (let q = 0; q < headerEnd(lines); q++) keep[q] = 1;
  let kept = 0; for (const k of keep) kept += k;
  if (kept / n >= cap) return { skip: 'over-cap', n, kept, hits: hits.length };
  let defs = []; try { defs = (outlineText(text, file, { limit: 5000 }) || []).filter(d => d.name); } catch {}
  const width = Math.max(6, String(n).length);
  const out = [];
  for (let i = 0; i < n;) {
    if (keep[i]) { out.push(numbered ? `${String(i + 1).padStart(width)}\t${lines[i]}` : lines[i]); i++; continue; }
    let j = i; while (j < n && !keep[j]) j++;
    const inGap = defs.filter(d => d.line - 1 >= i && d.line - 1 < j);
    const names = inGap.slice(0, 12).map(d => `${d.parent ? `${d.parent}.` : ''}${d.name} L${d.line}`).join(', ');
    out.push(`… lines ${i + 1}-${j} omitted${inGap.length ? ` (defines ${names}${inGap.length > 12 ? `, +${inGap.length - 12} more` : ''})` : ''}`);
    if (!numbered) for (let q = i + 1; q < j; q++) out.push('');
    i = j;
  }
  const range = how === 'Read' ? `Read with offset and limit` : `sed -n 'A,Bp' ${file}`;
  out.push(`[thinker: ${kept} of ${n} lines shown, around what you searched for; ${range} reads any omitted range]`);
  return { text: out.join('\n') + '\n', kept, n, hits: hits.length };
}

// --- a search, grouped by file ---------------------------------------------------------------------
export function groupSearch(text, { perFile = DIET.perFile, maxFiles = DIET.maxFiles } = {}) {
  const lines = String(text).split('\n').filter(l => l.length);
  const by = new Map(); let parsed = 0;
  for (const l of lines) {
    const m = /^([^\s:][^:\n]{1,240}?):(?:\d+)?[:-]/.exec(l); if (!m) continue;
    parsed++; const f = m[1]; if (!by.has(f)) by.set(f, []); by.get(f).push(l);
  }
  if (parsed < lines.length * 0.5 || by.size < 2) return null;
  const files = [...by.keys()]; const out = [];
  for (const f of files.slice(0, maxFiles)) {
    const ls = by.get(f); out.push(...ls.slice(0, perFile));
    if (ls.length > perFile) out.push(`${f}: +${ls.length - perFile} more matching lines`);
  }
  if (files.length > maxFiles) out.push(`… +${files.length - maxFiles} more files with matches`);
  out.push(`[thinker: ${parsed} matching lines in ${files.length} files, ${perFile} shown per file; search one file or a narrower pattern for the rest]`);
  return out.join('\n') + '\n';
}

// --- a test run, summarized -------------------------------------------------------------------------
export function trimTestOutput(store, { repo, command, stdout, stderr, exitCode, cfg = DIET }) {
  const c = classifyTestCommand(command); if (!c) return null;
  const raw = stripAnsi(`${stdout || ''}${stderr ? `\n${stderr}` : ''}`);
  if (raw.length < cfg.testChars) return null;
  const parsed = parseTestOutput(raw, { runner: c.runner }); if (!parsed) return null;
  const tcfg = testsConfig(store); let logPath = null;
  try { logPath = logPathFor(store, parsed.runner || c.runner); fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, raw); pruneLogs(store, tcfg.keepLogs); } catch { logPath = null; }
  const text = summarize(parsed, { repo, logPath: logPath ? path.relative(repo, logPath) : undefined, logLines: raw.split('\n').length,
    exitCode: exitCode ?? (parsed.failed ? 1 : 0), command: String(command).slice(0, 200), cfg: tcfg, tail: raw });
  return text.length < raw.length * 0.8 ? `${text}\n` : null;
}

// --- the hook's entry point --------------------------------------------------------------------------
const stripCd = c => String(c || '').trim().replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, '');
// `cat file`, `nl file`, `sed -n '1,$p' file`: one repository file, whole
function wholeRead(c) {
  let m = /^(?:cat|nl|bat)(?:\s+-[A-Za-z]+)*\s+(['"]?)([^\s'"|;&<>]+)\1$/.exec(c); if (m) return m[2];
  m = /^sed\s+-n\s+(['"]?)1,\$p\1\s+(['"]?)([^\s'"|;&<>]+)\2$/.exec(c); if (m) return m[3];
  return null;
}
function rel(repo, p, cwd) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd || repo, p);
  const r = path.relative(repo, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null;
}
// null, or {kind, file?, before, after, output}: the replacement for the tool's result, in the shape the
// client gave it (Claude Code checks it against the tool's own output), and the sizes for the log.
// The first and last lines of a long output within `chars`, the lines between counted (errors and summaries are
// usually at one end or the other).
export function capOutput(text, chars) {
  const lines = String(text).split('\n'), head = [], tail = [];
  let used = 0, i = 0, j = lines.length - 1;
  while (i <= j && used + lines[i].length + 1 <= chars * 0.6) { head.push(lines[i]); used += lines[i++].length + 1; }
  while (j >= i && used + lines[j].length + 1 <= chars) { tail.unshift(lines[j]); used += lines[j--].length + 1; }
  const gone = j - i + 1;
  return gone > 0 ? [...head, `[... ${gone} lines left out by thinker's output compression; run a narrower command to see them]`, ...tail].join('\n') : text;
}

// An MCP tool's result, its text capped at `chars`: the hook sees it as a string, an array of content blocks (text
// and image), or an object holding one; the text blocks past the cap become one capped block, in the same shape,
// and any other block (a screenshot) is kept. null when the text is within the cap.
export function capMcpResult(response, chars) {
  if (typeof response === 'string') { const c = capOutput(response, chars); return c === response ? null : { output: c, before: response.length, after: c.length }; }
  const blocks = Array.isArray(response) ? response : Array.isArray(response?.content) ? response.content : null;
  if (!blocks) return null;
  const texts = blocks.filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
  const before = texts.reduce((a, b) => a + b.text.length, 0);
  if (before <= chars) return null;
  const c = capOutput(texts.map(b => b.text).join('\n'), chars);
  let placed = false;
  const out = blocks.flatMap(b => texts.includes(b) ? (placed ? [] : (placed = true, [{ ...b, text: c }])) : [b]);
  return { output: Array.isArray(response) ? out : { ...response, content: out }, before, after: c.length };
}

export function dietResult(store, { session, repo, cwd, name, input = {}, response, cfg, turn, client = 'claude' }) {
  cfg = cfg || dietConfig(store);
  if (!cfg.enabled || !response || (typeof response !== 'object' && !(isMcp(name) && typeof response === 'string'))) return null;
  // only the tools given a level, at that level's settings
  const level = toolLevel(cfg, name, input);
  if (!level) return null;
  cfg = { ...cfg, ...DIET_LEVELS[level], ...(cfg.given || {}), level };
  const log = r => { if (r) store.log({ op: 'diet', kind: r.kind, session, turn, client, file: r.file, tool: r.tool, before: r.before, after: r.after }); return r; };
  const skip = (kind, file, why, n) => { store.log({ op: 'diet-skip', kind, session, turn, client, file, why, lines: n }); return null; };
  if (isMcp(name)) {
    if (!cfg.outputChars) return null;
    const c = capMcpResult(response, cfg.outputChars);
    return c ? log({ kind: 'cap', tool: toolKey(name), mcp: true, before: c.before, after: c.after, output: c.output }) : null;
  }
  if (name === 'Read') {
    const f = response.file; if (!f || typeof f.content !== 'string' || input.offset || input.limit) return null;
    const file = rel(repo, f.filePath || input.file_path, cwd); if (!file) return null;
    const r = trimFile(f.content, { ...cfg, file, terms: termsOf(store, session, cfg), how: 'Read', numbered: false });
    if (!r.text) return skip('read', file, r.skip, r.n);
    return log({ kind: 'read', file, before: f.content.length, after: r.text.length, output: { ...response, file: { ...f, content: r.text, numLines: r.text.split('\n').length - 1 } } });
  }
  if (name !== 'Bash') return null;
  const command = stripCd(input.command);
  const stdout = typeof response.stdout === 'string' ? response.stdout : textOf(response);
  const read = wholeRead(command);
  if (read) {
    const file = rel(repo, read, cwd); if (!file) return null;
    let text; try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { return null; }
    const r = trimFile(text, { ...cfg, file, terms: termsOf(store, session, cfg), how: 'sed' });
    if (!r.text) return skip('read', file, r.skip, r.n);
    return log({ kind: 'read', file, before: stdout.length, after: r.text.length, output: { ...response, stdout: r.text } });
  }
  if (cfg.tests && classifyTestCommand(command)) {
    const t = trimTestOutput(store, { repo, command, stdout, stderr: typeof response.stderr === 'string' ? response.stderr : '', exitCode: response.exitCode ?? response.exit_code ?? response.code, cfg });
    return t ? log({ kind: 'test', before: stdout.length + String(response.stderr || '').length, after: t.length, output: { ...response, stdout: t, stderr: '' } }) : null;
  }
  if (/^(?:rg|grep|egrep|git\s+grep)\b/.test(command) && !/[|;&]/.test(command) && stdout.length >= cfg.searchChars) {
    const g = groupSearch(stdout, cfg);
    if (g) return log({ kind: 'search', before: stdout.length, after: g.length, output: { ...response, stdout: g } });
  }
  // any other long output: its head and its tail, the middle named
  if (cfg.outputChars && stdout.length > cfg.outputChars) {
    const c = capOutput(stdout, cfg.outputChars);
    return log({ kind: 'cap', before: stdout.length, after: c.length, output: { ...response, stdout: c } });
  }
  return null;
}
