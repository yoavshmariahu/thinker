// Instruction sections served when they apply. A repository's instruction file (AGENTS.md) is read whole on every
// model call; most of it bears on a few kinds of change. A section kept out of it lives as a markdown file in a
// directory thinker reads (`instructions: { sections: { enabled: true, dir: ".thinker/agents-md" } }` in
// .thinker/config.json, or THINKER_SECTIONS=on with that directory), and the tool hook serves it, verbatim and once a
// session, at the moment the session does what it is about:
//   - a file of the section's area is named in a tool call or edited (`paths:` frontmatter, as Claude Code's
//     .claude/rules use it, or the repository paths the section names);
//   - code the section names appears in a source file the agent read (the identifiers it names, when specific);
//   - a commit, a push or a pull request is about to be made (a section about commits, pull requests or merging).
// Replayed against 160 Codex sessions on 24 PostHog tasks (2026-10-19, research in the session scratchpad), triggers
// of these kinds fired before the first edit for nearly every task whose change a section bore on, at a median
// of ~1k tokens served a session against ~5.8k of section text. A new way of reaching the agent: off until an
// experiment shows it helps (AGENTS.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SECTIONS = { perSession: 6, codeMaxShare: 0.01, minIdent: 6, scanFiles: 20000 };
// the version of how triggers are read: cached triggers from an earlier reading are read again
const TRIGGERS_VERSION = 2;
const SOURCE = /\.(py|tsx?|jsx?|go|rs|rb|java|kt|swift|cs|php|scala)$/;
const DOC = /\.mdx?$|(^|\/)\.agents\//;

export const sectionsConfig = store => {
  const c = store.config().instructions?.sections || {};
  const env = process.env.THINKER_SECTIONS || '';
  const enabled = /^(0|off|false)$/i.test(env) ? false : /^(1|on|true)$/i.test(env) || c.enabled === true;
  return { enabled, dir: c.dir || '.thinker/agents-md' };
};

// A list in a markdown file's frontmatter (`paths:` as Claude Code reads .claude/rules; `edits:`, `code:`, `commands:`
// for thinker), as a block (`- item` lines) or inline (`[a, b]`); null when the key is absent.
export function frontmatterList(md, key) {
  const fm = String(md).match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const keys = key === 'paths' ? '(?:paths|globs)' : key;
  const m = fm[1].match(new RegExp(`^${keys}:\\s*\\n((?:[ \\t]*-[ \\t]*.+\\n?)+)`, 'm')) || fm[1].match(new RegExp(`^${keys}:\\s*\\[(.*)\\]`, 'm'));
  if (!m) return null;
  return m[1].split(/\n|,(?=\s*['"])/).map(l => unquote(l.replace(/^\s*-\s*/, '').trim())).filter(Boolean);
}
// a YAML scalar: a double-quoted one is a JSON string (escapes and all), a single-quoted or bare one is taken as is
const unquote = v => { if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch {} } return v.replace(/^['"]|['"]$/g, ''); };
// a pattern from a file the team wrote: one that does not compile matches nothing, and never stops the hook
const regex = p => { try { return new RegExp(p); } catch { return null; } };
export const frontmatterPaths = md => frontmatterList(md, 'paths');

// a glob (`products/*/backend/**`, `posthog/api/`) as a regular expression over repository-relative paths
export function globRegex(g) {
  const s = String(g).replace(/^\.\//, '').replace(/<[^>]+>|\{[^}]+\}/g, '*');
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') { if (s[i + 1] === '*') { re += '.*'; i++; if (s[i + 1] === '/') i++; } else re += '[^/]*'; }
    else re += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return `^${re}${s.endsWith('/') || !/\.[\w]+$/.test(s) ? '' : '$'}`;
}

// how many source files of the repository hold a string (git grep), to leave out names that are everywhere
function sourceShare(repo, ident, total) {
  try {
    const n = execFileSync('git', ['-C', repo, 'grep', '-l', '-F', '-I', ident, '--', ...['*.py', '*.ts', '*.tsx', '*.js', '*.go', '*.rs']], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length;
    return n / Math.max(1, total);
  } catch { return 0; }
}
function sourceCount(repo) {
  try { return execFileSync('git', ['-C', repo, 'ls-files', '--', '*.py', '*.ts', '*.tsx', '*.js', '*.go', '*.rs'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).length; } catch { return 0; }
}

// The triggers of one section, from its own text: what it names, kept when it is specific to this repository.
export function deriveTriggers(repo, { title = '', text = '' }, { total = null } = {}) {
  const t = { paths: [], edits: [], code: [], cmd: null };
  // stated triggers, when the file has frontmatter: paths and edits are globs, code and commands regular expressions
  const fm = ['paths', 'edits', 'code', 'commands'].map(k => frontmatterList(text, k));
  if (fm.some(Boolean)) {
    const [paths, edits, code, commands] = fm;
    return { paths: (paths || []).map(globRegex), edits: (edits || []).map(globRegex), code: [], codeRe: code || [], cmd: commands?.length ? commands.join('|') : null };
  }
  if (/\bcommit|\bpull requests?\b|\bPRs?\b|\bpush(ing)?\b|\bmerg(e|ing)\b/i.test(title)) t.cmd = '\\bgit (commit|push)\\b|\\bgh pr (create|edit|merge)\\b';
  if (/\bCI\b|GitHub Actions|workflows?\b/i.test(title)) t.paths.push('^\\.github/(workflows|actions)/');
  const spans = [...String(text).matchAll(/`([^`\n]{2,80})`|\]\(([^)\s]+)\)/g)].map(m => (m[1] || m[2]).trim());
  for (const s of new Set(spans)) {
    if (/^https?:|^\/|\s/.test(s)) continue;
    if (s.includes('/')) {
      // a path: kept when it exists, is no document, and is deeper than a top-level directory
      const fixed = s.replace(/^\.\//, '').split(/[*{<]/)[0].replace(/\/$/, '');
      if (!fixed || DOC.test(s) || /^docs\//.test(s) || fixed.split('/').length < 2) continue;
      if (!fs.existsSync(path.join(repo, fixed))) continue;
      t.paths.push(globRegex(s));
    } else if (s.length >= SECTIONS.minIdent && /^[@\w][\w.]*\(?\)?$/.test(s) && /[._(@]|[a-z][A-Z]/.test(s)) {
      // code: a dotted, called, decorated or CamelCase name, kept when few source files hold it
      const ident = s.replace(/\(\)?$/, '');
      total ??= sourceCount(repo);
      const share = sourceShare(repo, ident, total);
      if (share > 0 && share <= SECTIONS.codeMaxShare) t.code.push(ident);
    }
  }
  t.paths = [...new Set(t.paths)];
  return t;
}

// The cards: one per markdown file in the sections directory, with its triggers, kept by the file's content.
export function sectionCards(store) {
  const { dir } = sectionsConfig(store);
  const abs = path.isAbsolute(dir) ? dir : path.join(store.repo, dir);
  let files = [];
  try { files = fs.readdirSync(abs).filter(f => f.endsWith('.md')).sort(); } catch { return []; }
  const cacheFile = path.join(store.dir, 'state', 'sections.json');
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  let total = null, changed = false;
  const cards = files.map(f => {
    const text = fs.readFileSync(path.join(abs, f), 'utf8');
    const key = `${f}:${TRIGGERS_VERSION}:${text.length}:${hash(text)}`;
    if (!cache[key]) {
      const title = (text.match(/^#{1,4} (.+)$/m) || [])[1] || f.replace(/\.md$/, '');
      total ??= sourceCount(store.repo);
      cache[key] = { id: f.replace(/\.md$/, ''), title, triggers: deriveTriggers(store.repo, { title, text }, { total }) };
      changed = true;
    }
    return { ...cache[key], file: path.relative(store.repo, path.join(abs, f)), text: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
  });
  if (changed) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([k]) => files.some(f => k.startsWith(f + ':')))))); } catch {} }
  return cards;
}
const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

// Which card a tool event fires: { files named or edited, the command, what it printed, whether it edited }.
export function sectionFires(card, { files = [], command = '', output = '', read = [], edited = [] }) {
  const t = card.triggers || {};
  const any = (res, list) => res?.some(p => { const re = regex(p); return !!re && list.some(f => re.test(f)); });
  if (t.cmd && command && regex(t.cmd)?.test(command)) return 'cmd';
  if (any(t.paths, files)) return 'path';
  if (any(t.edits, edited)) return 'edit';
  // code counts only in what a source file printed, never in documents or skills that quote it
  if (output && read.some(f => SOURCE.test(f)) && !read.some(f => DOC.test(f))) {
    if (t.code?.some(c => output.includes(c)) || t.codeRe?.some(c => regex(c)?.test(output))) return 'code';
  }
  return null;
}

// The tool hook: the sections this event fires that the session has not been shown, verbatim, or ''.
export function sectionsForEvent(store, { session, client, files = [], command = '', output = '', read = [], edited = [] }) {
  if (!sectionsConfig(store).enabled) return '';
  const cards = sectionCards(store);
  if (!cards.length) return '';
  const stateFile = path.join(store.dir, 'state', 'sections-served.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const shown = new Set(st[session] || []);
  if (shown.size >= SECTIONS.perSession) return '';
  const hits = [];
  for (const c of cards) {
    if (shown.has(c.id) || hits.length + shown.size >= SECTIONS.perSession) continue;
    const how = sectionFires(c, { files, command, output, read, edited });
    if (how) hits.push({ c, how });
  }
  if (!hits.length) return '';
  if (session && session !== 'unknown') {
    st[session] = [...shown, ...hits.map(h => h.c.id)];
    const keys = Object.keys(st); for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete st[k];
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st)); } catch {}
  }
  for (const h of hits) store.log({ op: 'section', session: session === 'unknown' ? undefined : session, client, section: h.c.id, how: h.how });
  return `<thinker-instructions>\nFrom this repository's instructions (${hits.map(h => h.c.file).join(', ')}), for what you are doing now:\n\n${hits.map(h => h.c.text).join('\n\n')}\n</thinker-instructions>`;
}
