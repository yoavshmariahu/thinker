// Evidence helpers for explicit, offline instruction-file analysis. No hooks or background work.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export function outcomeSampled(id, share) {
  if (!(share > 0)) return false;
  if (share >= 1) return true;
  return parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 8), 16) / 2 ** 32 < share;
}

// --- the change --------------------------------------------------------------------------------------------
export function sessionDiff(repo, files, { start } = {}) {
  const fs_ = [...new Set(files)].filter(f => f && !f.startsWith('..') && !path.isAbsolute(f) && !/(^|\/)SKILL\.md$/.test(f) && !/^\.(thinker|git|claude|codex|cursor|agents)\//.test(f));
  if (!fs_.length) return '';
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  let base = 'HEAD';
  if (start) { try { const b = git('rev-list', '-1', `--before=${start}`, 'HEAD').trim(); if (b) base = b; } catch {} }
  let diff = '';
  try { diff = git('diff', '--no-color', '--no-ext-diff', base, '--', ...fs_); } catch {}
  let untracked = [];
  try { untracked = git('ls-files', '--others', '--exclude-standard', '--', ...fs_).split('\n').filter(Boolean); } catch {}
  for (const f of untracked) {
    const r = spawnSync('git', ['-C', repo, 'diff', '--no-color', '--no-index', '--', '/dev/null', f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.stdout) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + r.stdout;
  }
  return diff;
}
export function changedPaths(diff) {
  const out = new Set();
  for (const m of String(diff || '').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2] === '/dev/null' ? m[1] : m[2]);
  return [...out];
}

// --- the guidance ------------------------------------------------------------------------------------------
// the path globs of a rule file's front matter (paths: or globs:, a list or a bracketed line)
export function ruleGlobs(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(paths|globs):\s*(.*)$/);
    if (!kv) continue;
    const rest = kv[2].trim(), unq = s => s.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/^\[.*\]$/.test(rest)) out.push(...rest.slice(1, -1).split(',').map(unq).filter(Boolean));
    else if (rest) out.push(...rest.split(',').map(unq).filter(Boolean));
    while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) out.push(unq(lines[++i].replace(/^\s+-\s/, '')));
  }
  return out;
}
// a gitignore-style glob over a repository path: ** any directories, * no slash, ? one character, {a,b}
export function globRegex(glob) {
  const g = String(glob).trim().replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = g.indexOf('}', i); if (end < 0) { re += '\\{'; continue; } re += '(?:' + g.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${g.endsWith('/') ? '.*' : '(?:/.*)?'}$`);
}
