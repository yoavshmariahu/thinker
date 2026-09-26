// Co-change edges mined from git history: which files change together.
// Stored in .thinker/cochange.json as {a: {b: count}} plus per-file totals,
// and served as "usually changes with" lines next to notes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP = /(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS)|\.lock$|package-lock\.json$|(^|\/)(docs?|\.github)\//i;

export function mineCochange(repo, { commits = 800, maxFiles = 15 } = {}) {
  const log = execFileSync('git', ['log', `-n${commits}`, '--name-only', '--pretty=format:%x00%H'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString();
  const pairs = {}, totals = {};
  let n = 0;
  for (const chunk of log.split('\0').slice(1)) {
    const files = chunk.split('\n').slice(1).map(s => s.trim()).filter(f => f && !SKIP.test(f) && fs.existsSync(path.join(repo, f)));
    if (files.length < 2 || files.length > maxFiles) continue;
    n++;
    for (const f of files) totals[f] = (totals[f] || 0) + 1;
    for (const a of files) for (const b of files) if (a !== b) (pairs[a] ||= {})[b] = (pairs[a][b] || 0) + 1;
  }
  const index = { minedAt: new Date().toISOString(), commits: n, totals, pairs };
  fs.mkdirSync(path.join(repo, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.thinker', 'cochange.json'), JSON.stringify(index));
  return index;
}

export function loadCochange(repo) {
  const cands = [process.env.THINKER_NOTES_DIR && path.join(process.env.THINKER_NOTES_DIR, '..', 'cochange.json'), path.join(repo, '.thinker', 'cochange.json')].filter(Boolean);
  for (const f of cands) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  return null;
}

// Partners of a file: [{file, conf: P(partner | file), support}], strongest first.
export function partners(index, file, { minSupport = 3, minConf = 0.4, limit = 4 } = {}) {
  if (!index?.pairs?.[file]) return [];
  const tot = index.totals[file] || 1;
  return Object.entries(index.pairs[file])
    .map(([b, c]) => ({ file: b, support: c, conf: c / tot }))
    .filter(p => p.support >= minSupport && p.conf >= minConf)
    .sort((x, y) => y.conf - x.conf || y.support - x.support)
    .slice(0, limit);
}

// Compact block for a set of files, for injection next to notes.
export function renderCochange(index, files, opts = {}) {
  const lines = [];
  for (const f of files) {
    const ps = partners(index, f, opts);
    if (ps.length) lines.push(`${f} usually changes with ${ps.map(p => `${p.file} (${Math.round(p.conf * 100)}%, n=${p.support})`).join(', ')}`);
  }
  return lines.length ? `Co-change (from git history):\n- ${lines.join('\n- ')}` : '';
}
