// The keep list: file reads the cut never takes and the delegation trigger never hands away (2026-11-17, the
// owner's call, from a person's report: an agent that "doesn't remember or forgets what worked", whose notes
// file the person had to shout at it to read again).
//
// What went wrong there is the one harm no figure of ours sees. A cut replaces every old tool result with a
// placeholder, and a read of the person's notes is a tool result like any other; the re-read measure
// (rereads.js) counts the model fetching it back, and a model that carries on without it scores zero.
//
// The rule, with no model in it: the **newest copy** of a kept file stays in the prompt. A file is kept when
//   - its path matches a pattern: `*.md` everywhere (written to carry context from one call to the next, which
//     is the opposite of a result the agent has finished with), and what the profile learned the person points
//     at (`sources` on an observation, profile.js; the machine's keep file below);
//   - the person named it in a prompt of this conversation;
//   - the model read it again after a cut took it, so a file is lost at most once.
// A copy is a whole read, a `cat`, or a Write of the file. Older copies of a kept file are cut as before -- the
// newest one holds the content -- so a file read ten times costs one copy, not ten. A ranged read never
// displaces a whole one.
//
// One rule, every door: the three wire formats the proxy cuts (proxy.js, proxy-responses.js, proxy-chat.js)
// call `keptCalls` on the calls of the request, the clearing mod mirrors it (claude-clear/hooks/register.tsx,
// held to this file by test/keep.test.js), delegate.js asks `keepReason` before it denies a read, and
// rereads.js leaves kept results out of the cleared set it replays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellRead } from './shell-read.js';

export const KEEP_DEFAULT = ['*.md'];

// ---- patterns ----
// A pattern without a slash is matched against the file's name; one with a slash against the end of its path
// (`docs/plan.txt` matches `/repo/docs/plan.txt`). `*` stays inside one path segment, `**` crosses them. Case
// is ignored: README.MD is the same file to the person who named it.
const esc = s => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
const glob = p => esc(p).replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
const norm = f => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
export function keepMatcher(patterns = KEEP_DEFAULT) {
  const names = [], paths = [];
  for (const raw of patterns || []) {
    const p = norm(String(raw || '').trim());
    if (!p) continue;
    if (p.includes('/')) paths.push(new RegExp(`(?:^|/)${glob(p.replace(/^\//, ''))}$`, 'i'));
    else names.push(new RegExp(`^${glob(p)}$`, 'i'));
  }
  return file => {
    const f = norm(file);
    if (!f) return false;
    const base = f.slice(f.lastIndexOf('/') + 1);
    return names.some(r => r.test(base)) || paths.some(r => r.test(f));
  };
}

// ---- named in a prompt ----
// What the harness puts into a user message is not the person speaking: an instruction file quoted in a
// reminder names dozens of files nobody asked for.
const INJECTED = /<(thinker-[\w-]+|system[-_]reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|agent-message)>[\s\S]*?<\/\1>/g;
export const spoken = text => String(text || '').replace(INJECTED, ' ');
// A file is named when its own name stands in the person's words: `learnings.md`, `notes/learnings.md`, or the
// whole path. Only a name with an extension counts, since a bare word (`notes`, `main`) names nothing.
const NAMEABLE = /^[^\s/]{1,120}\.[A-Za-z0-9]{1,8}$/;
export function namedIn(prompts = []) {
  const said = (Array.isArray(prompts) ? prompts : [prompts]).map(spoken).join('\n').toLowerCase();
  const memo = new Map();
  return file => {
    const f = norm(file), base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    if (!said || !NAMEABLE.test(base)) return false;
    if (!memo.has(base)) memo.set(base, new RegExp(`(?:^|[^\\w.-])${esc(base)}(?![\\w-]|\\.\\w)`).test(said) || said.startsWith(base));
    return memo.get(base);
  };
}

// ---- what a call holds ----
// The files one tool call put into the prompt, and whether it holds them whole. Every agent names its tools
// differently (Claude Code `Read`/`file_path`, OpenCode `read`/`path`, Codex a `shell` whose command is an
// array), so the reading is by shape: a read tool's path, a write tool's path where it carries the content, a
// shell line that prints a file (shell-read.js, the delegation trigger's own parser).
const READ_TOOL = /^(read|read_file|view|view_file|open_file|cat)$/i;
const WRITE_TOOL = /^(write|write_file|create_file)$/i;
const SHELL_TOOL = /^(bash|shell|exec_command|local_shell|run_terminal_cmd|run_shell_command|execute_command|container\.exec)$/i;
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const unquote = f => String(f).replace(/^["']|["']$/g, '').replace(/^\.\//, '');
const pathOf = input => [input.file_path, input.filePath, input.path, input.target_file, input.filename].find(v => typeof v === 'string' && v) || '';
const RANGED = ['offset', 'limit', 'start_line', 'end_line', 'view_range', 'line_start', 'line_end'];
export function copyOf(name, input) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return null; } }
  if (!name || !input || typeof input !== 'object') return null;
  if (READ_TOOL.test(name)) {
    const f = pathOf(input);
    return f ? { files: [unquote(f)], whole: !RANGED.some(k => input[k] != null && input[k] !== '') } : null;
  }
  if (WRITE_TOOL.test(name)) {
    const f = pathOf(input);
    return f && typeof (input.content ?? input.contents ?? input.text) === 'string' ? { files: [unquote(f)], whole: true } : null;
  }
  if (SHELL_TOOL.test(name)) {
    // Codex sends the command as an argv (`["bash", "-lc", "cat notes.md"]`): the line is its last element
    const raw = input.command ?? input.cmd;
    const cmd = Array.isArray(raw) ? String(raw[raw.length - 1] ?? '') : typeof raw === 'string' ? raw : '';
    if (!cmd) return null;
    const m = cmd.match(CD), dir = m ? unquote(m[1]) : '';
    const line = m ? cmd.slice(m[0].length) : cmd;
    const r = shellRead(line);
    if (!r) return null;
    return {
      files: r.files.map(unquote).map(f => (dir && !f.startsWith('/') ? `${dir.replace(/\/+$/, '')}/${f}` : f)),
      whole: /^\s*(cat|less|more)\s/.test(line),
    };
  }
  return null;
}
// the same file, written absolute by one tool and relative by another: equal, or one the tail of the other
export const sameFile = (a, b) => a === b || (a.startsWith('/') && !b.startsWith('/') ? a.endsWith('/' + b) : (!a.startsWith('/') && b.startsWith('/') ? b.endsWith('/' + a) : false));

/** Why a file is kept, before anything is known of the conversation's cuts: 'pattern', 'named', or null. */
export function keepReason(file, { patterns = KEEP_DEFAULT, prompts = [], match = null, said = null } = {}) {
  if ((match || keepMatcher(patterns))(file)) return 'pattern';
  if ((said || namedIn(prompts))(file)) return 'named';
  return null;
}

/**
 * The calls whose results stay, of a conversation's calls oldest first (`{ id, name, input }`).
 * `cut` is the set of ids already cut: a file read again after one of its copies was cut is kept from then on.
 * Returns the ids, and for each kept file why and which call holds it (what the log and `thinker keep` show).
 */
export function keptCalls(calls = [], { patterns = KEEP_DEFAULT, prompts = [], cut = null } = {}) {
  const gone = cut instanceof Set ? cut : new Set(cut || []);
  const match = keepMatcher(patterns), said = namedIn(prompts);
  const seen = [];   // { file, last, lastWhole, wasCut, reread }
  const byName = new Map();
  const entryOf = file => {
    const hit = byName.get(file);
    if (hit) return hit;
    let e = seen.find(x => sameFile(x.file, file));
    if (!e) { e = { file, last: null, lastWhole: null, wasCut: false, reread: false }; seen.push(e); }
    byName.set(file, e);
    return e;
  };
  for (const c of calls) {
    if (!c || !c.id) continue;
    const copy = copyOf(c.name, c.input);
    if (!copy) continue;
    for (const f of copy.files) {
      const e = entryOf(f);
      if (gone.has(c.id)) { e.wasCut = true; continue; }
      if (e.wasCut) e.reread = true;
      e.last = c.id;
      if (copy.whole) e.lastWhole = c.id;
    }
  }
  const ids = new Set(), files = [];
  for (const e of seen) {
    const id = e.lastWhole || e.last;
    if (!id) continue;
    const why = keepReason(e.file, { match, said }) || (e.reread ? 'reread' : null);
    if (!why) continue;
    ids.add(id);
    files.push({ file: e.file, why, id });
  }
  return { ids, files };
}

// ---- the machine's keep file ----
// `<THINKER_HOME>/state/keep.json`: what the profile learned the person points at, a list per repository so
// each repository's reading replaces only its own. Read by every door on the machine, which is why it is one
// file and not the repository's: the proxy sees a request, never a checkout. The patterns of every repository
// apply everywhere -- a name learned in one checkout keeps a same-named file in another, one copy of it.
const home = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
export const keepFile = (dir = home()) => path.join(dir, 'state', 'keep.json');
let cache = { file: '', at: 0, mtime: -1, patterns: KEEP_DEFAULT };
/** Every pattern in force on this machine: the defaults and what the profile learned. Stats at most once a second. */
export function keepPatterns({ dir = home(), now = Date.now() } = {}) {
  const file = keepFile(dir);
  if (cache.file === file && now - cache.at < 1000) return cache.patterns;
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
  if (cache.file !== file || mtime !== cache.mtime) {
    let learned = [];
    try { learned = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).repos || {}).flatMap(r => (Array.isArray(r?.files) ? r.files : [])); } catch { learned = []; }
    cache = { file, at: now, mtime, patterns: [...new Set([...KEEP_DEFAULT, ...learned.filter(p => typeof p === 'string' && p.trim())])] };
  } else cache.at = now;
  return cache.patterns;
}
/** Replace one repository's learned patterns. An empty list takes the repository out of the file. */
export function writeKeep(repo, files, { dir = home(), now = Date.now() } = {}) {
  const file = keepFile(dir);
  let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { all = {}; }
  const repos = all.repos && typeof all.repos === 'object' ? all.repos : {};
  const list = [...new Set((files || []).map(f => String(f || '').trim()).filter(Boolean))].sort();
  const before = JSON.stringify(repos[repo]?.files || []);
  if (before === JSON.stringify(list)) return false;
  if (list.length) repos[repo] = { files: list, at: new Date(now).toISOString() }; else delete repos[repo];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ repos }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache.at = 0;
  return true;
}

// ---- what a person pointed at, as a pattern ----
// A source the session reader returned (profile.js: `sources`), held to what the person actually wrote: it must
// stand in one of their prompts, and it must look like a file. A name alone becomes a name pattern, a path a
// path pattern. Nothing with a wildcard is learned: a model does not get to widen the list.
const SOURCE = /^[\w@~./-]{1,200}\.[A-Za-z0-9]{1,8}$/;
export function sourcePattern(source, prompts = []) {
  const s = norm(String(source || '').trim().replace(/^[`'"]+|[`'".,;:]+$/g, ''));
  if (!SOURCE.test(s) || s.includes('*')) return null;
  if (!spoken((Array.isArray(prompts) ? prompts : [prompts]).join('\n')).toLowerCase().includes(s.toLowerCase())) return null;
  const rel = s.replace(/^~\//, '').replace(/^\/+/, '');
  return rel;
}
