// The eval index: bench/runs stays the source of truth (the runners write there, git tracks it);
// this SQLite file is a rebuildable index over it plus the record of runs launched from the app.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  dir TEXT PRIMARY KEY, repo TEXT, runner TEXT, models TEXT, arms TEXT,
  first_at INTEGER, last_at INTEGER, results INTEGER, invalid INTEGER, scanned_mtime INTEGER
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT, area TEXT, arm TEXT, rep INTEGER, repo TEXT,
  model TEXT, effort TEXT, actual_models TEXT, turns INTEGER, wall_ms REAL, cost REAL,
  in_tokens REAL, fresh_in REAL, cache_read REAL, cache_write REAL, out_tokens REAL,
  tool_calls INTEGER, files_read INTEGER, calls_before_edit INTEGER, thinker_calls INTEGER, injected INTEGER,
  served INTEGER, pass INTEGER, score REAL, outcome_source TEXT, judge TEXT, invalid TEXT,
  mtime INTEGER, file TEXT
);
CREATE INDEX IF NOT EXISTS results_run ON results(run);
CREATE INDEX IF NOT EXISTS results_task ON results(task);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT DEFAULT 'experiment', tag TEXT, runner TEXT, args TEXT, plan TEXT,
  status TEXT, pid INTEGER, expected INTEGER, started_at INTEGER, ended_at INTEGER, exit_code INTEGER, log TEXT
);
`;

const COLS = ['id', 'run', 'task', 'area', 'arm', 'rep', 'repo', 'model', 'effort', 'actual_models', 'turns', 'wall_ms', 'cost',
  'in_tokens', 'fresh_in', 'cache_read', 'cache_write', 'out_tokens', 'tool_calls', 'files_read', 'calls_before_edit',
  'thinker_calls', 'injected', 'served', 'pass', 'score', 'outcome_source', 'judge', 'invalid', 'mtime', 'file'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // an index made before cache builds were jobs has no kind column
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'kind')) db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT DEFAULT 'experiment'");
  const insert = db.prepare(`INSERT OR REPLACE INTO results (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
  return {
    raw: db,
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    replaceRun(dir, meta, rows) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM results WHERE run = ?').run(dir);
        for (const r of rows) insert.run(Object.fromEntries(COLS.map(c => ['@' + c, r[c] ?? null])));
        db.prepare(`INSERT OR REPLACE INTO runs (dir, repo, runner, models, arms, first_at, last_at, results, invalid, scanned_mtime)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(dir, meta.repo, meta.runner, meta.models, meta.arms, meta.first_at, meta.last_at, meta.results, meta.invalid, meta.scanned_mtime);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    dropRun(dir) { db.prepare('DELETE FROM results WHERE run = ?').run(dir); db.prepare('DELETE FROM runs WHERE dir = ?').run(dir); },
  };
}
