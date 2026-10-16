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
    // a nested run (bench/runs/invalid/<run>), never a run's own helper folders
    for (const sub of files) if (!HELPERS.has(sub) && isDir(path.join(p, sub)) && safeList(path.join(p, sub)).some(f => f.endsWith('.json'))) out.push(d + '/' + sub);
  }
  return out;
}

const HELPERS = new Set(['notes-staged', 'transcripts', 'events', 'raw']);
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

// The sessions on disk in one run folder, normalized, each with its full record.
export function scanRun(runsDir, dir, repos) {
  const p = path.join(runsDir, dir);
  const files = safeList(p).filter(f => f.endsWith('.json') && f !== 'experiment.json');
  const byId = new Map();
  const sidecars = new Map();
  for (const f of files) if (f.endsWith('.judge.json')) sidecars.set(f.replace(/\.judge\.json$/, ''), readJson(path.join(p, f)));
  const add = (rec, file, mtime) => {
    if (!rec || typeof rec !== 'object' || rec.arm == null || rec.task == null) return;
    const key = rec.id || `${rec.task}-${rec.arm}-${rec.rep ?? 0}`;
    if (byId.has(key) && file === 'summary.json') return;  // the per-result file wins over the summary copy
    const prefix = PREFIX_REPO.find(([r]) => r.test(dir.split('/').pop()));
    const repo = repos.get(String(rec.task))?.repo || (prefix && prefix[1]) || null;
    const sidecar = sidecars.get(key) || null;
    const record = sidecar ? { ...rec, judge_sidecar: sidecar } : rec;
    byId.set(key, { ...normalize(rec, { dir, file, mtime, sidecar, repo }), record: JSON.stringify(record) });
  };
  for (const f of files) {
    if (f.endsWith('.judge.json') || f === 'summary.json') continue;
    add(readJson(path.join(p, f)), f, Math.round(fs.statSync(path.join(p, f)).mtimeMs));
  }
  if (files.includes('summary.json')) {
    const sum = readJson(path.join(p, 'summary.json'));
    const mtime = Math.round(fs.statSync(path.join(p, 'summary.json')).mtimeMs);
    if (Array.isArray(sum)) for (const r of sum) add(r, 'summary.json', mtime);
  }
  return [...byId.values()];
}

function dirMtime(p) {
  let m = fs.statSync(p).mtimeMs;
  for (const f of safeList(p)) if (f.endsWith('.json')) m = Math.max(m, fs.statSync(path.join(p, f)).mtimeMs);
  return Math.round(m);
}

// Import what the runners handed off: a session's file is read into the database once, and the
// database is the record from then on (a later scan does not overwrite it; `force` re-imports a run,
// e.g. after it was regraded). A run folder removed from disk stays in the database.
export function ingest(db, benchDir, { force = false, only = null } = {}) {
  const runsDir = path.join(benchDir, 'runs');
  const repos = taskInfo(benchDir);
  const changed = [];
  for (const dir of runDirs(runsDir)) {
    if (only && dir !== only) continue;
    const m = dirMtime(path.join(runsDir, dir));
    const prev = db.get('SELECT scanned_mtime FROM runs WHERE dir = ?', dir);
    if (!force && prev && prev.scanned_mtime === m) continue;
    const have = new Set(db.all('SELECT id FROM results WHERE run = ?', dir).map(r => r.id));
    const rows = scanRun(runsDir, dir, repos).filter(r => force || !have.has(r.id));
    const now = Date.now();
    db.tx(() => { for (const r of rows) db.putResult({ ...r, imported_at: now }); });
    // an experiment defined before the database (experiment.json beside the results) is imported once
    const def = db.definition(dir) || readJson(path.join(runsDir, dir, 'experiment.json'));
    const models = (db.get('SELECT group_concat(DISTINCT model) m FROM results WHERE run = ?', dir)?.m || '').split(',').filter(Boolean);
    const added = gitAdded(benchDir, dir);
    db.refreshRun(dir, { runner: runnerOf(models), scanned_mtime: m, definition: def ? JSON.stringify(def) : null, ...(added ? { first_at: added } : {}) });
    if (rows.length) changed.push(dir);
  }
  importModules(db, benchDir);
  return changed;
}

// PR sets and cache receipts written as files before the database held them, imported once
export function importModules(db, benchDir) {
  for (const f of safeList(path.join(benchDir, 'prsets'))) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(path.join(benchDir, 'prsets', f));
    if (s?.name && !db.getPrset(s.name)) db.putPrset(s);
  }
  for (const n of safeList(path.join(benchDir, 'caches'))) {
    const r = readJson(path.join(benchDir, 'caches', n, 'receipt.json'));
    if (r?.name && !db.getCache(r.name)) db.putCache(r);
  }
}

function gitAdded(benchDir, dir) {
  try {
    const out = execFileSync('git', ['-C', benchDir, 'log', '--diff-filter=A', '--format=%ct', '--', path.join('runs', dir)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    return out.length ? Number(out[out.length - 1]) * 1000 : null;
  } catch { return null; }
}
