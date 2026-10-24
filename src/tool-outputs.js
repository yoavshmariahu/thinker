// What tool results cost a session: a result stays in the conversation, so every model call after it reads it
// again. Per session and per tool (Read, Bash, Grep, an MCP server…): the calls, the tokens the results added, and
// the input tokens they cost, each result's tokens times the model calls left after it. An estimate: tokens are
// characters / 4, the calls left are the tool calls left scaled to the session's model calls (several tool calls can
// share one), and a result is counted until the session ends or a compaction drops it (Claude Code records its
// compactions; the other agents' are not seen). For the Context tab (context-view.js). Kept per session in
// .thinker/state/tool-outputs.json, by the transcript's size.
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscript } from './transcripts.js';

const KEEP = 1000, VERSION = 11;
// what each level's cap leaves of an output, in tokens (diet.js:DIET_LEVELS outputChars / 4): the part of a
// compressible tool's result past it is a saving at least (the other trims, round search hits and file windows, come on top);
// an MCP server has the moderate level alone (diet.js:mcpLevel), so its high saving is its moderate one
const CAP = { moderate: 3000, high: 1000 };
// The program a shell command runs, which is what decides how much it prints: the first command of the line after
// any `cd`, environment assignments and wrappers (`sudo`, `timeout 60`, `env`), its path left out; for a tool with
// subcommands (git, gh, npm…) the subcommand too, since `git diff` and `git status` print very differently.
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'xargs']);
const SUBCOMMANDS = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'uv', 'docker', 'kubectl', 'pip', 'poetry', 'make', 'bun', 'deno', 'dotnet', 'mvn', 'gradle']);
export function bashProgram(command) {
  for (const seg of String(command || '').split(/&&|\|\||;|\||\n/)) {
    const words = seg.trim().match(/'[^']*'|"[^"]*"|\S+/g) || [];
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || WRAPPERS.has(words[i]) || (words[i] === 'timeout' && ++i))) i++;
    const w = words[i]; if (!w || w === 'cd' || w === 'source' || w === '.' || w === 'export' || w === 'set') continue;
    const prog = w.replace(/^.*\//, '').replace(/^['"]|['"]$/g, '');
    if (/^(for|while|until|if|case|do|then|\{|\()$/.test(prog)) return 'shell loop';
    if (!/^[\w.+-]+$/.test(prog)) return 'other';
    // the first word after the program that is no option, nor the value of one that takes a value (`git -C dir log`)
    let sub = '';
    if (SUBCOMMANDS.has(prog)) for (let k = i + 1; k < words.length; k++) { if (/^-[Cc]$|^--(?:git-dir|work-tree|prefix|cwd|dir|directory|manifest-path|project)$/.test(words[k])) { k++; continue; } if (!words[k].startsWith('-')) { sub = words[k]; break; } }
    return sub && /^[\w:.-]+$/.test(sub) ? `${prog} ${sub}` : prog;
  }
  return 'shell';
}
// one row per tool, an MCP server's tools as one, a shell command by its program (`Bash:rg`, `Bash:git diff`)
export const toolKey = (name, input) => {
  const m = String(name).match(/^mcp__(.+?)__/); if (m) return `mcp:${m[1]}`;
  if (name === 'Bash' && input?.command) return `Bash:${bashProgram(input.command)}`;
  return String(name || 'unknown');
};

// the files a tool call is about, by name: the path-like words of its input (`sed -n 1,80p src/a.js`, an Edit's file_path)
const filesOf = input => new Set((JSON.stringify(input || '').match(/[\w./~-]+\.[a-z]{1,5}\b/gi) || []).map(p => p.replace(/^.*\//, '')).filter(p => p.length > 3));

// A tool's results measured under each output compression setting they ran with (diet.js:dietTimeline): the record of
// `sed` is keyed `Bash:sed` for calls made with no compression set and `Bash:sed@moderate` for calls made while it was
// set to moderate. Compressing a tool makes it another entity with a measurement of its own from that moment, instead
// of its month of uncompressed results going on to rank it first; the rows of one tool are linked (linkRows) so the
// two are compared.
export const recordKey = (name, level) => level ? `${name}@${level}` : name;
export const splitKey = k => { const m = /^(.*)@(moderate|high)$/.exec(k); return m ? { name: m[1], level: m[2] } : { name: k, level: null }; };

// `turns`: the session's model calls, when the transcript counts them; the calls left after a result are its share of
// those (agents make several tool calls in one model call), else one a tool call. `compactions`: the event indices where
// the transcript records a compaction (transcripts.js), after which the results before it are read no more.
// `unneeded` is the cost of reading a result again after the agent last used it: the last call of the same turn that
// edited with text copied from it or named a file its own call named; with no such call, every read but the first.
// An estimate: it misses a result the agent used from memory, and takes a later call on `index.js` for use of this one.
// `levelAt(key, at)`: the compression the tool had when the call was made (`at`, ms, from the transcript; absent for an
// agent that does not time its calls, and the caller's levelAt then takes the session's time).
export function sessionOutputs(events, turns = 0, compactions = [], { levelAt = null } = {}) {
  const tools = [], turnOf = [], bounds = [], cuts = [...compactions].sort((a, b) => a - b);
  let turn = 0, c = 0;
  events.forEach((e, k) => { while (c < cuts.length && cuts[c] <= k) { bounds.push(tools.length); c++; } if (e.t === 'prompt') turn++; else if (e.t === 'tool') { tools.push(e); turnOf.push(turn); } });
  while (c < cuts.length) { bounds.push(tools.length); c++; }
  const n = tools.length, by = {}, scale = turns > 0 && n > 0 ? Math.min(1, turns / (n + 1)) : 1;
  const inputs = tools.map(e => ({ files: filesOf(e.input), old: typeof e.input?.old_string === 'string' && e.input.old_string.length >= 20 ? e.input.old_string : null }));
  tools.forEach((e, i) => {
    // a screenshot costs its pixels, not its base64 (transcripts.js:imageTokens); the caps cut text alone
    const key = toolKey(e.name, e.input), result = String(e.result || ''), text = Math.ceil(result.length / 4), tokens = text + (e.imageTokens || 0), r = (by[recordKey(key, levelAt ? levelAt(key, e.at) : null)] ||= { calls: 0, tokens: 0, input: 0, unneeded: 0, saveModerate: 0, saveHigh: 0 });
    const end = bounds.find(b => b > i) ?? n, reads = Math.max(1, (end - i) * scale);
    let last = i;
    for (let j = i + 1; j < end && turnOf[j] === turnOf[i]; j++) { const q = inputs[j]; if ((q.old && result.includes(q.old)) || (inputs[i].files.size && [...q.files].some(f => inputs[i].files.has(f)))) last = j; }
    r.calls++; r.tokens += tokens; r.input += Math.round(tokens * reads); r.unneeded += Math.round(tokens * Math.max(0, (end - last - 1) * scale));
    const mcp = key.startsWith('mcp:');
    if (key === 'Read' || key === 'Bash' || key.startsWith('Bash:') || mcp) { r.saveModerate += Math.round(Math.max(0, text - CAP.moderate) * reads); r.saveHigh += Math.round(Math.max(0, text - CAP[mcp ? 'moderate' : 'high']) * reads); }
  });
  return by;
}

const stateFile = store => path.join(store.dir, 'state', 'tool-outputs.json');
// One record per session, kept by the transcript's size: the outputs by tool (sessionOutputs), and, since version 8,
// the model the session ran on and what it cost as the agent reported it (transcripts.js:Stats; since version 9 with
// what the conversation itself cost, `carried`; version 10 with the notes and the instruction payload), read by the Report page (report.js:sessionUsage) from the same parse.
// Since version 11 the outputs are keyed by tool and the compression it had (recordKey), each call by its own time, and
// the record carries `at`, when the session's first call was made (its transcript's time where no call is timed), and
// `tk`, the key of the settings timeline the calls were attributed under (diet.js:dietTimeline). A record made under
// another timeline, or under none (a reader that wants the usage alone), is made again when a reader brings one: the
// Report's usage reader parsed new transcripts first and without it, and every call of those sessions read as
// uncompressed to the readers after (2026-10-24).
// `carried`: what the conversation itself cost in input tokens, by kind (transcripts.js:parseClaude; Claude Code alone)
const usageOf = (st, carried) => st && st.inputTokens != null ? { input: st.inputTokens, output: st.outputTokens ?? 0, cacheRead: st.cacheReadTokens ?? 0, cacheWrite: st.cacheWriteTokens ?? 0, turns: st.turns || 0, carried: carried || null } : null;
function sessionRecords(store, sessions, { levelAt = null, key = '' } = {}) {
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch {}
  const recs = [];
  let changed = false;
  for (const s of sessions) {
    let size = 0; try { size = fs.statSync(s.file).size; } catch { continue; }
    let r = st[s.session];
    if (!r || r.size !== size || r.v !== VERSION || (key && r.tk !== key)) {
      let parsed; try { parsed = parseTranscript(s.file); } catch { continue; }
      const at = parsed.events.reduce((a, e) => e.t === 'tool' && e.at && (!a || e.at < a) ? e.at : a, 0) || s.mtime;
      const level = levelAt ? (key, t) => levelAt(key, t ?? at) : null;
      r = st[s.session] = { v: VERSION, size, mtime: s.mtime, at, tk: levelAt ? key : '', model: parsed.model || null, usage: usageOf(parsed.stats, parsed.carried), by: sessionOutputs(parsed.events, parsed.stats?.turns || 0, parsed.compactions || [], { levelAt: level }) };
      changed = true;
    }
    recs.push({ ...r, at: r.at || s.mtime, session: s.session, client: s.client, t: s.mtime });
  }
  if (changed) {
    const ids = Object.keys(st).sort((a, b) => (st[a].mtime || 0) - (st[b].mtime || 0));
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete st[id];
    try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(st)); } catch {}
  }
  return recs;
}
// every session of the window with its model, its reported usage (null where the agent reported none: Cursor) and
// what its tool outputs cost in input tokens
export function sessionUsage(store, sessions, { levelAt = null, key = '' } = {}) {
  // `by`: each tool's own cost in the session, so the Report can cost one tool's outputs a session before and since its compression (report.js:actionEffect)
  return sessionRecords(store, sessions, { levelAt, key }).map(r => ({ session: r.session, t: r.t, client: r.client, model: r.model || null, usage: r.usage || null, outputs: Object.values(r.by).reduce((a, x) => a + x.input, 0), by: Object.fromEntries(Object.entries(r.by).map(([k, x]) => [k, x.input])) }));
}
// The rows of one tool linked: each carries `others`, the same tool's rows under its other settings (level, sessions,
// from, to, perCall, perSession, wasted), so the page and the command compare a compressed tool with itself before.
export function linkRows(rows) {
  const brief = r => ({ level: r.level, sessions: r.sessions, from: r.from, to: r.to, perCall: r.perCall, perSession: r.perSession, wasted: r.wasted, calls: r.calls });
  return rows.map(r => ({ ...r, others: rows.filter(o => o !== r && o.name === r.name).map(brief) }));
}
// The rows from the session records: one per tool and compression setting (splitKey). A row's figures are averaged over
// the sessions that ran while its tool had that setting (`levelAt(name, at)` at the session's first call), not over
// every session of the window: `sed` compressed since Tuesday is measured over Tuesday's sessions on, `sed` before it
// over the ones until then, and each says so (`sessions`, `from`, `to`). The totals are over every session, whatever
// the settings. Without `levelAt` there is one row a tool over every session, as before.
export function aggregateOutputs(recs, { levelAt = null } = {}) {
  const n = recs.length, rows = new Map();
  for (const r of recs) for (const [k, x] of Object.entries(r.by)) {
    const row = rows.get(k) || { key: k, ...splitKey(k), usedIn: 0, calls: 0, tokens: 0, input: 0, unneeded: 0, saveModerate: 0, saveHigh: 0 };
    row.usedIn++; row.calls += x.calls; row.tokens += x.tokens; row.input += x.input; row.unneeded += x.unneeded || 0; row.saveModerate += x.saveModerate || 0; row.saveHigh += x.saveHigh || 0; rows.set(k, row);
  }
  const span = xs => xs.length ? { from: Math.min(...xs), to: Math.max(...xs) } : { from: null, to: null };
  // `wasted`: the input tokens a session spent reading the tool's results after the agent last used them (sessionOutputs)
  const tools = [...rows.values()].map(r => {
    const at = levelAt ? recs.filter(s => levelAt(r.name, s.at ?? s.t) === r.level).map(s => s.at ?? s.t) : recs.map(s => s.at ?? s.t);
    // a session's calls fall under a setting its first call did not have (made during it): the sessions that called it are a floor
    const d = Math.max(at.length, r.usedIn, 1);
    return { name: r.name, level: r.level, sessions: levelAt ? d : n, ...span(at), usedIn: r.usedIn, calls: r.calls / d, tokens: Math.round(r.tokens / d), perSession: Math.round(r.input / d), perCall: Math.round(r.tokens / (r.calls || 1)), wasted: Math.round(r.unneeded / d), saveModerate: Math.round(r.saveModerate / d), saveHigh: Math.round(r.saveHigh / d) };
  }).sort((a, b) => b.perSession - a.perSession);
  const sum = k => Math.round([...rows.values()].reduce((a, r) => a + r[k], 0) / (n || 1));
  return { sessions: n, tools: linkRows(tools), tokens: sum('tokens'), perSession: sum('input'), wasted: sum('unneeded') };
}
export function toolOutputs(store, sessions, { levelAt = null, key = '' } = {}) {
  const recs = sessionRecords(store, sessions, { levelAt, key }).filter(r => Object.keys(r.by).length);
  return {
    ...aggregateOutputs(recs, { levelAt }),
    timeline: recs.map(r => ({ t: r.t, session: r.session, outputs: Object.values(r.by).reduce((a, x) => a + x.input, 0) })),
  };
}
