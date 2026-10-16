// Index bench/runs into the eval database. A run directory is rescanned only when a file in it
// changed, so the periodic scan costs a stat per directory once everything is indexed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalize } from './normalize.js';

// A run is one directory of records; a few runs nest one level (bench/runs/invalid/<run>).
function runDirs(runsDir) {
  const out = [];
  for (const d of safeList(runsDir)) {
    const p = path.join(runsDir, d);
    if (!isDir(p)) continue;
    const files = safeList(p);
    if (files.some(f => f.endsWith('.json'))) out.push(d);
    for (const sub of files) if (sub !== 'notes-staged' && isDir(path.join(p, sub)) && safeList(path.join(p, sub)).some(f => f.endsWith('.json'))) out.push(d + '/' + sub);
  }
  return out;
}

function safeList(p) { try { return fs.readdirSync(p); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

export function runnerOf(models) {
  if (models.some(m => /^gpt|codex|astra|sol/i.test(m))) return 'codex';
  if (models.some(m => /gemini/i.test(m))) return 'gemini';
  return 'claude';
}

// task id → { repo, title, pr } from the task files; a run of an unlisted task set falls back to the
// directory prefix for its repo
export function taskInfo(benchDir) {
  const map = new Map();
  for (const f of safeList(path.join(benchDir, 'tasks'))) {
    if (!f.endsWith('.json')) continue;
    const repo = f.replace(/(-hard|-adv)?\.json$/, '');
    for (const t of readJson(path.join(benchDir, 'tasks', f))?.tasks || []) {
      if (map.has(t.id)) continue;
      const pr = String(t.id).match(/^PR(\d+)/)?.[1] || null;
      const title = t.goldTitle || String(t.prompt || '').replace(/^Implement the following change[^\n]*\n\n/, '').split('\n')[0].slice(0, 140) || null;
      map.set(t.id, { repo, title, pr });
    }
  }
  return map;
}

const PREFIX_REPO = [[/^mitm/, 'mitmproxy'], [/^click/, 'click'], [/^posthog/, 'posthog'], [/^grafana/, 'grafana'], [/^mlflow/, 'mlflow'], [/^thinker/, 'thinker']];

export function scanRun(runsDir, dir, repos) {
  const p = path.join(runsDir, dir);
  const files = safeList(p).filter(f => f.endsWith('.json'));
  const byId = new Map();
  let first = Infinity, last = 0;
  const sidecars = new Map();
  for (const f of files) if (f.endsWith('.judge.json')) sidecars.set(f.replace(/\.judge\.json$/, ''), readJson(path.join(p, f)));
  const add = (rec, file, mtime) => {
    if (!rec || typeof rec !== 'object' || rec.arm == null || rec.task == null) return;
    const key = rec.id || `${rec.task}-${rec.arm}-${rec.rep ?? 0}`;
    if (byId.has(key) && file === 'summary.json') return;  // the per-result file wins over the summary copy
    const prefix = PREFIX_REPO.find(([r]) => r.test(dir.split('/').pop()));
    const repo = repos.get(String(rec.task))?.repo || (prefix && prefix[1]) || null;
    byId.set(key, normalize(rec, { dir, file, mtime, sidecar: sidecars.get(key) || null, repo }));
    first = Math.min(first, mtime); last = Math.max(last, mtime);
  };
  for (const f of files) {
    if (f.endsWith('.judge.json') || f === 'summary.json') continue;
    const mtime = Math.round(fs.statSync(path.join(p, f)).mtimeMs);
    add(readJson(path.join(p, f)), f, mtime);
  }
  if (files.includes('summary.json')) {
    const s = readJson(path.join(p, 'summary.json'));
    const mtime = Math.round(fs.statSync(path.join(p, 'summary.json')).mtimeMs);
    if (Array.isArray(s)) for (const r of s) add(r, 'summary.json', mtime);
  }
  const rows = [...byId.values()];
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))];
  return {
    rows,
    meta: {
      repo: [...new Set(rows.map(r => r.repo).filter(Boolean))].join(',') || null,
      runner: runnerOf(models), models: models.join(','), arms: [...new Set(rows.map(r => r.arm))].join(','),
      first_at: rows.length ? first : null, last_at: rows.length ? last : null,
      results: rows.length, invalid: rows.filter(r => r.invalid).length,
    },
  };
}

function dirMtime(p) {
  let m = fs.statSync(p).mtimeMs;
  for (const f of safeList(p)) if (f.endsWith('.json')) m = Math.max(m, fs.statSync(path.join(p, f)).mtimeMs);
  return Math.round(m);
}

export function ingest(db, benchDir, { force = false } = {}) {
  const runsDir = path.join(benchDir, 'runs');
  const repos = taskInfo(benchDir);
  const seen = new Set(), changed = [];
  for (const dir of runDirs(runsDir)) {
    seen.add(dir);
    const m = dirMtime(path.join(runsDir, dir));
    const prev = db.get('SELECT scanned_mtime FROM runs WHERE dir = ?', dir);
    if (!force && prev && prev.scanned_mtime === m) continue;
    const { rows, meta } = scanRun(runsDir, dir, repos);
    // criteria.js rewrites records when it regrades, so a file's mtime can be the regrade's; the
    // commit that first added the run bounds its start from above
    const added = gitAdded(benchDir, dir);
    if (added && meta.first_at) meta.first_at = Math.min(meta.first_at, added);
    db.replaceRun(dir, { ...meta, scanned_mtime: m }, rows);
    changed.push(dir);
  }
  for (const { dir } of db.all('SELECT dir FROM runs')) if (!seen.has(dir)) db.dropRun(dir);
  return changed;
}

function gitAdded(benchDir, dir) {
  try {
    const out = execFileSync('git', ['-C', benchDir, 'log', '--diff-filter=A', '--format=%ct', '--', path.join('runs', dir)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    return out.length ? Number(out[out.length - 1]) * 1000 : null;
  } catch { return null; }
}
