// Task sets: the PRs a benchmark can run — each one's request, base, gold diff, test command and,
// for loop experiments, acceptance criteria — kept in Artemis's database, the system of record, not
// in files under bench/tasks. A task set is imported from a JSON file or a git ref (its gold diffs read
// from the same place and stored whole), hashed, and versioned: an import that changes it, or a change
// to a task's acceptance criteria, writes a new version, and a PR set records the version it was drawn
// from. A launch writes that version into the run (bench/runs/<tag>/tasks.json, gold diffs beside it)
// for the runner, so every experiment says exactly what it ran.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NAME, hashOf } from './prsets.js';
import { acceptanceOf } from '../loop.js';

// a task set is named after its file: mlflow-b2-hard.json is the set mlflow-b2-hard
export const tasksetName = s => String(s || '').replace(/\.json$/, '');
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const show = (root, ref, p) => { try { return execFileSync('git', ['-C', root, 'show', `${ref}:${p}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

export function getTaskSet(db, name, { version = null, hash = null } = {}) {
  const n = tasksetName(name);
  if (!NAME.test(n)) return null;
  const row = hash ? db.get('SELECT data FROM taskset_versions WHERE name = ? AND hash = ?', n, hash)
    : version ? db.get('SELECT data FROM taskset_versions WHERE name = ? AND version = ?', n, Number(version))
    : db.get('SELECT data FROM tasksets WHERE name = ?', n);
  return row ? JSON.parse(row.data) : null;
}
export const listTaskSets = db => db.all('SELECT data FROM tasksets ORDER BY name').map(r => JSON.parse(r.data));
export const taskSetVersions = (db, name) => db.all('SELECT version, hash, created_at FROM taskset_versions WHERE name = ? ORDER BY version', tasksetName(name));

// what a version is identified by: the repository, base and tasks, gold diffs included
const content = s => ({ repo: s.repo, base: s.base, tasks: s.tasks });
function save(db, s, why) {
  const prev = getTaskSet(db, s.name);
  const hash = hashOf(content(s));
  if (prev?.hash === hash) return { ...prev, unchanged: true };
  const version = (prev?.version || 0) + 1;
  const rec = { ...s, hash, version, created_at: prev?.created_at || Date.now(), updated_at: Date.now(), change: why };
  db.tx(() => {
    db.run('INSERT INTO taskset_versions (name, version, hash, created_at, data) VALUES (?,?,?,?,?)', s.name, version, hash, Date.now(), JSON.stringify(rec));
    db.run('INSERT OR REPLACE INTO tasksets (name, repo, hash, version, created_at, data) VALUES (?,?,?,?,?,?)', s.name, s.repo, hash, version, rec.created_at, JSON.stringify(rec));
  });
  return rec;
}

// Import a task set from a file (under bench/tasks or a path) or from `ref:path` in this repository's
// git history; every task's gold diff comes from the same place and is stored whole. A task whose gold
// diff is missing, or whose test files are not in it, fails the import: a runner could not grade it.
export function importTaskSet(benchDir, db, { name, file = null, ref = null, repo = null }) {
  const root = path.dirname(benchDir);
  let spec, from, readGold;
  if (ref) {
    if (!file) throw new Error('a git import names the file at the ref, e.g. bench/tasks/mlflow-b2-hard.json');
    const text = show(root, ref, file);
    if (text == null) throw new Error(`${ref}:${file} not found`);
    spec = JSON.parse(text); from = { kind: 'git', ref, file };
    readGold = p => show(root, ref, p);
  } else {
    // a path from the repository root, or a file under the bench's tasks/ by name
    const f = file && fs.existsSync(path.resolve(root, file)) ? path.resolve(root, file) : path.join(benchDir, 'tasks', path.basename(String(file || name || '')).replace(/(\.json)?$/, '.json'));
    spec = readJson(f);
    if (!spec) throw new Error(`no task set file ${path.relative(root, f)}`);
    from = { kind: 'file', file: path.relative(root, f) };
    readGold = p => { try { return fs.readFileSync(path.resolve(root, p), 'utf8'); } catch { return null; } };
  }
  const n = tasksetName(name || path.basename(file || ''));
  if (!NAME.test(n)) throw new Error('task set name: letters, digits, . _ -');
  if (!spec?.tasks?.length) throw new Error('the task set has no tasks');
  const problems = [];
  const tasks = spec.tasks.map(t => {
    const out = { ...t };
    if (t.goldDiff) {
      const diff = readGold(t.goldDiff);
      if (diff == null) { problems.push(`${t.id}: gold diff ${t.goldDiff} not found`); return out; }
      const files = new Set([...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)/gm)].map(m => m[1]));
      const missing = (t.testFiles || []).filter(f => !files.has(f));
      if (missing.length) problems.push(`${t.id}: test files not in the gold diff: ${missing.join(', ')}`);
      out.goldDiffText = diff; out.goldDiffFrom = t.goldDiff; delete out.goldDiff;
    }
    return out;
  });
  if (problems.length) throw new Error('the task set cannot be graded as it is: ' + problems.join('; '));
  const r = String(repo || spec.repo || n.replace(/(-hard|-adv)$/, '')).split('/').pop();
  return save(db, { name: n, repo: r, base: spec.base || null, description: spec.description || null, from, tasks }, `imported from ${from.kind === 'git' ? `${ref}:${file}` : from.file}`);
}

// A task's acceptance criteria for loop experiments (bench/loop.js), written from the request and the
// base code, never the gold: setting them is a new version of the set.
export function setAcceptance(db, name, taskId, acceptance) {
  const s = getTaskSet(db, name);
  if (!s) throw new Error(`no task set ${name}`);
  const t = s.tasks.find(x => x.id === taskId);
  if (!t) throw new Error(`no task ${taskId} in ${s.name}`);
  const a = acceptanceOf({ acceptance });
  if (acceptance?.length && a.length !== acceptance.length) throw new Error('each criterion needs an id and a criterion');
  const ids = a.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('criterion ids repeat');
  return save(db, { ...s, tasks: s.tasks.map(x => (x.id === taskId ? { ...x, acceptance: a } : x)) }, `acceptance of ${taskId}`);
}

// The runner's task file for one run: the version a PR set froze, with each gold diff written beside it
// and `goldDiff` pointing at it from the repository root (as bench/oracle.js reads it).
export function writeRunTasks(benchDir, db, { name, hash, outDir }) {
  const s = getTaskSet(db, name, { hash });
  if (!s) throw new Error(`no task set ${name}${hash ? ` at ${hash}` : ''}`);
  const gold = path.join(outDir, 'gold');
  fs.mkdirSync(gold, { recursive: true });
  const tasks = s.tasks.map(t => {
    const { goldDiffText, goldDiffFrom, ...rest } = t;
    if (goldDiffText == null) return rest;
    const f = path.join(gold, `${t.id}.diff`);
    fs.writeFileSync(f, goldDiffText);
    return { ...rest, goldDiff: path.relative(path.dirname(benchDir), f) };
  });
  const file = path.join(outDir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ name: s.name, version: s.version, hash: s.hash, repo: s.repo, base: s.base, tasks }, null, 2) + '\n');
  return file;
}

// The version a PR set froze; a database that has never held the set (a fresh one, from before task
// sets were stored) imports its file under bench/tasks first.
export function ensureTaskSet(benchDir, db, name, hash = null) {
  const n = tasksetName(name);
  if (!getTaskSet(db, n) && fs.existsSync(path.join(benchDir, 'tasks', n + '.json'))) importTaskSet(benchDir, db, { name: n, file: path.join(path.basename(benchDir), 'tasks', n + '.json') });
  return getTaskSet(db, n, { hash });
}

// Task sets still under bench/tasks that the database does not hold are imported once, so the files
// that predate it keep working; from then on the database is what is read.
export function importTaskFiles(benchDir, db) {
  const dir = path.join(benchDir, 'tasks'), done = [], failed = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')) : []) {
    if (getTaskSet(db, tasksetName(f))) continue;
    try { importTaskSet(benchDir, db, { name: tasksetName(f), file: path.join('bench', 'tasks', f) }); done.push(f); } catch (e) { failed.push(`${f}: ${e.message}`); }
  }
  return { done, failed };
}
