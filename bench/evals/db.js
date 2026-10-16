// Artemis's database: the system of record for experiments, their task sets, PR sets and caches, every session
// with its full record and transcript, and the jobs that ran them. It lives on this machine, outside
// any checkout (~/.artemis/artemis.db), and is snapshotted daily (snapshot.js). The runners still
// write one JSON file per session under bench/runs/<tag>/: that is their hand-off, imported once.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.artemis');
export const DEFAULT_DB = path.join(HOME_DIR, 'artemis.db');
// ARTEMIS_<name>, or the EVALS_<name> it was called before the platform had a name
export const env = name => process.env[`ARTEMIS_${name}`] ?? process.env[`EVALS_${name}`];

// The platform's home before it was named (~/.thinker-evals, evals.db) moves once to ~/.artemis.
export function migrateHome(home = os.homedir()) {
  const from = path.join(home, '.thinker-evals'), to = path.join(home, '.artemis');
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  fs.renameSync(from, to);
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(path.join(to, 'evals.db' + ext))) fs.renameSync(path.join(to, 'evals.db' + ext), path.join(to, 'artemis.db' + ext));
  return true;
}
// One Artemis per database: the server that runs it holds <db>.server.json ({ pid, port }) while it lives.
export const lockFile = (db = DEFAULT_DB) => db + '.server.json';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// The running server for a database, or null (a lock left by a dead process does not count).
export function runningServer(db = DEFAULT_DB) {
  try { const s = JSON.parse(fs.readFileSync(lockFile(db), 'utf8')); return s.pid && s.port && alive(s.pid) ? s : null; }
  catch { return null; }
}

// Take the lock for this process, or return the server that already holds it. Removed again on exit.
export function lockServer(port, db = DEFAULT_DB) {
  const file = lockFile(db);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() }), { flag: 'wx' }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = runningServer(db);
      if (held && held.pid !== process.pid) return { held };
      fs.rmSync(file, { force: true });
      continue;
    }
    const release = () => { if (runningServer(db)?.pid === process.pid) fs.rmSync(file, { force: true }); };
    process.on('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { release(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]); });
    return { held: null };
  }
  return { held: runningServer(db) };
}

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS runs (
  dir TEXT PRIMARY KEY, repo TEXT, runner TEXT, models TEXT, arms TEXT,
  first_at INTEGER, last_at INTEGER, results INTEGER, invalid INTEGER, scanned_mtime INTEGER,
  definition TEXT, imported_at INTEGER
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT, area TEXT, arm TEXT, rep INTEGER, repo TEXT,
  model TEXT, effort TEXT, actual_models TEXT, turns INTEGER, wall_ms REAL, cost REAL,
  in_tokens REAL, fresh_in REAL, cache_read REAL, cache_write REAL, out_tokens REAL,
  tool_calls INTEGER, files_read INTEGER, calls_before_edit INTEGER, thinker_calls INTEGER, injected INTEGER,
  served INTEGER, pass INTEGER, score REAL, outcome_source TEXT, judge TEXT, invalid TEXT,
  mtime INTEGER, file TEXT, record TEXT, imported_at INTEGER,
  done INTEGER, iterations INTEGER, false_done INTEGER, loop_stop TEXT, checker TEXT, checker_tokens REAL
);
CREATE INDEX IF NOT EXISTS results_run ON results(run);
CREATE INDEX IF NOT EXISTS results_task ON results(task);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY, format TEXT, data BLOB, bytes INTEGER, source TEXT, archived_at INTEGER, flags TEXT
);
CREATE TABLE IF NOT EXISTS prsets (name TEXT PRIMARY KEY, repo TEXT, hash TEXT, created_at INTEGER, data TEXT);
-- task sets (tasksets.js): the current version of each, and every version it had
CREATE TABLE IF NOT EXISTS tasksets (name TEXT PRIMARY KEY, repo TEXT, hash TEXT, version INTEGER, created_at INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS taskset_versions (name TEXT, version INTEGER, hash TEXT, created_at INTEGER, data TEXT, PRIMARY KEY (name, version));
CREATE TABLE IF NOT EXISTS caches (name TEXT PRIMARY KEY, repo TEXT, status TEXT, created_at INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS arms (name TEXT PRIMARY KEY, runner TEXT, hash TEXT, created_at INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT DEFAULT 'experiment', tag TEXT, runner TEXT, args TEXT, plan TEXT,
  status TEXT, pid INTEGER, expected INTEGER, started_at INTEGER, ended_at INTEGER, exit_code INTEGER, log TEXT
);
`;

const COLS = ['id', 'run', 'task', 'area', 'arm', 'rep', 'repo', 'model', 'effort', 'actual_models', 'turns', 'wall_ms', 'cost',
  'in_tokens', 'fresh_in', 'cache_read', 'cache_write', 'out_tokens', 'tool_calls', 'files_read', 'calls_before_edit',
  'thinker_calls', 'injected', 'served', 'pass', 'score', 'outcome_source', 'judge', 'invalid', 'mtime', 'file', 'record', 'imported_at',
  'done', 'iterations', 'false_done', 'loop_stop', 'checker', 'checker_tokens'];

// columns added after a database was first made; added in place, nothing is rebuilt
const ADDED = {
  runs: { definition: 'TEXT', imported_at: 'INTEGER' },
  results: { record: 'TEXT', imported_at: 'INTEGER', done: 'INTEGER', iterations: 'INTEGER', false_done: 'INTEGER', loop_stop: 'TEXT', checker: 'TEXT', checker_tokens: 'REAL' },
  jobs: { kind: "TEXT DEFAULT 'experiment'" },
};

export function openDb(file = DEFAULT_DB) {
  if (file === DEFAULT_DB) migrateHome();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [c, type] of Object.entries(cols)) if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  const insert = db.prepare(`INSERT OR REPLACE INTO results (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
  const api = {
    raw: db, file,
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    putResult(r) { insert.run(Object.fromEntries(COLS.map(c => ['@' + c, r[c] ?? null]))); },
    // the run's summary row, recomputed from its sessions in the database
    refreshRun(dir, extra = {}) {
      const s = db.prepare(`SELECT count(*) n, sum(invalid IS NOT NULL) inv, min(mtime) first, max(mtime) last,
        group_concat(DISTINCT model) models, group_concat(DISTINCT arm) arms, group_concat(DISTINCT repo) repos FROM results WHERE run = ?`).get(dir);
      const prev = db.prepare('SELECT * FROM runs WHERE dir = ?').get(dir) || {};
      const row = { ...prev, dir, results: s.n, invalid: s.inv || 0, models: s.models || '', arms: s.arms || prev.arms || '', repo: s.repos || prev.repo || null,
        first_at: Math.min(...[s.first, prev.first_at, extra.first_at].filter(v => v != null)) || null, last_at: s.last ?? prev.last_at ?? null, ...extra };
      if (!Number.isFinite(row.first_at)) row.first_at = null;
      db.prepare(`INSERT OR REPLACE INTO runs (dir, repo, runner, models, arms, first_at, last_at, results, invalid, scanned_mtime, definition, imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(dir, row.repo, row.runner || null, row.models, row.arms, row.first_at, row.last_at, row.results, row.invalid,
        row.scanned_mtime ?? null, row.definition ?? null, row.imported_at ?? Date.now());
    },
    definition(dir) { const r = db.prepare('SELECT definition FROM runs WHERE dir = ?').get(dir); return r?.definition ? JSON.parse(r.definition) : null; },
    setDefinition(dir, def) {
      if (!db.prepare('SELECT 1 FROM runs WHERE dir = ?').get(dir)) api.refreshRun(dir, { definition: JSON.stringify(def) });
      else db.prepare('UPDATE runs SET definition = ? WHERE dir = ?').run(JSON.stringify(def), dir);
    },
    record(id) { const r = db.prepare('SELECT record FROM results WHERE id = ?').get(id); return r?.record ? JSON.parse(r.record) : null; },
    getPrset(name) { const r = db.prepare('SELECT data FROM prsets WHERE name = ?').get(name); return r ? JSON.parse(r.data) : null; },
    putPrset(s) { db.prepare('INSERT OR REPLACE INTO prsets (name, repo, hash, created_at, data) VALUES (?,?,?,?,?)').run(s.name, s.repo, s.hash, s.created_at, JSON.stringify(s)); },
    listPrsets() { return db.prepare('SELECT data FROM prsets ORDER BY created_at DESC').all().map(r => JSON.parse(r.data)); },
    getCache(name) { const r = db.prepare('SELECT data FROM caches WHERE name = ?').get(name); return r ? JSON.parse(r.data) : null; },
    putCache(c) { db.prepare('INSERT OR REPLACE INTO caches (name, repo, status, created_at, data) VALUES (?,?,?,?,?)').run(c.name, c.repo, c.status, c.created_at || Date.now(), JSON.stringify(c)); },
    listCaches() { return db.prepare('SELECT data FROM caches ORDER BY created_at DESC').all().map(r => JSON.parse(r.data)); },
    getArm(name) { const r = db.prepare('SELECT data FROM arms WHERE name = ?').get(name); return r ? JSON.parse(r.data) : null; },
    putArm(a) { db.prepare('INSERT OR REPLACE INTO arms (name, runner, hash, created_at, data) VALUES (?,?,?,?,?)').run(a.name, a.runner, a.hash, a.created_at, JSON.stringify(a)); },
    listArms() { return db.prepare('SELECT data FROM arms ORDER BY name').all().map(r => JSON.parse(r.data)); },
    dropRun(dir) { db.prepare('DELETE FROM results WHERE run = ?').run(dir); db.prepare('DELETE FROM runs WHERE dir = ?').run(dir); },
  };
  return api;
}
