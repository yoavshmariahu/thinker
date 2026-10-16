// PR sets: the PRs an experiment runs, chosen by a stated rule and frozen before any session is
// spent. A PR set is drawn from one version of a task set (tasksets.js, in the database) and kept in
// the database with its base commit, that version's hash, and its own hash, so every experiment that
// uses it runs the same PRs, as they were defined, at the same commit and says so.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureTaskSet, tasksetName } from './tasksets.js';

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const hashOf = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
export const isAncestor = (cwd, a, b) => { try { execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };

export const listPrsets = db => db.listPrsets();
export const readPrset = (db, name) => (NAME.test(name || '') ? db.getPrset(name) : null);

// The checks a PR set must pass to be run: the checkout is at the task set's base (the runners work
// at the checkout's HEAD), and every PR's merge commit is not already in that history.
export function checkPrset(benchDir, s, db = null) {
  const repoDir = path.join(benchDir, 'repos', s.repo);
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  const checks = [];
  checks.push(!head ? { ok: false, check: 'checkout', detail: `bench/repos/${s.repo} is not a git checkout` }
    : !s.base ? { ok: false, check: 'base', detail: 'the task set records no base commit, so it cannot be checked that the PRs run before their fix' }
    : { ok: head.startsWith(s.base) || s.base.startsWith(head), check: 'checkout at base', detail: `checkout ${head.slice(0, 10)}, task set base ${s.base.slice(0, 10)}` });
  const missing = s.prs.filter(p => !p.mergeCommit).length;
  const reachable = head ? s.prs.filter(p => p.mergeCommit && isAncestor(repoDir, p.mergeCommit, head)).map(p => p.id) : [];
  checks.push({ ok: !reachable.length, check: 'fixes absent from the base', detail: reachable.length ? `merged already: ${reachable.join(', ')}` : missing ? `${missing} PRs record no merge commit and were not checked` : 'no PR is merged in the checkout' });
  // a PR whose tests call functions or signatures only its merged patch defines cannot be passed by
  // any other correct change (2026-10-15 smoke run: both router PRs failed to compile in every arm)
  const spec = (db && taskSetOf(benchDir, db, s)) || readJson(path.join(benchDir, 'tasks', tasksetName(s.tasks) + '.json'));
  const flagged = new Set((spec?.tasks || []).filter(t => t.testNeedsGoldSymbols).map(t => t.id));
  const gold = s.prs.filter(p => p.testNeedsGoldSymbols || flagged.has(p.id)).map(p => p.id);
  if (s.prs.some(p => p.oracle === 'tests')) checks.push({ ok: !gold.length, check: 'tests passable without the merged patch\'s own API', detail: gold.length ? `tests need the merged patch's symbols: ${gold.join(', ')}` : 'every test exercises behavior the request asks for' });
  return checks;
}

// A PR set is composed as a draft — its task set, PRs and rule can change — and frozen once: from then
// on it never changes, and only a frozen set can be run. A PR set from before drafts is frozen.
export const isFrozen = s => (s.status || 'frozen') === 'frozen';

// the task set version a PR set was drawn from (a set from before versions: the current one)
const taskSetOf = (benchDir, db, s) => ensureTaskSet(benchDir, db, s.tasks, s.taskset_hash || null);

function compose(benchDir, db, { name, tasks, ids, rule, description }) {
  if (!NAME.test(tasksetName(tasks))) throw new Error('task set is not valid');
  // a set still only on file under bench/tasks is imported on first use, as at startup (tasksets.js)
  const spec = ensureTaskSet(benchDir, db, tasks);
  if (!spec?.tasks?.length) throw new Error(`no task set ${tasksetName(tasks)} in Artemis (import_task_set)`);
  const want = ids?.length ? ids : spec.tasks.map(t => t.id);
  const unknown = want.filter(id => !spec.tasks.some(t => t.id === id));
  if (unknown.length) throw new Error('not in the task set: ' + unknown.join(', '));
  const repo = spec.repo;
  const prs = spec.tasks.filter(t => want.includes(t.id)).map(t => ({
    id: t.id, pr: String(t.id).match(/^PR(\d+)/)?.[1] || null, title: t.goldTitle || null, area: t.area || null,
    mergeCommit: t.mergeCommit || null, mergedAt: t.mergedAt || null, oracle: t.testCmd ? 'tests' : t.type === 'change' ? 'judge' : 'answer judge',
    testNeedsGoldSymbols: Boolean(t.testNeedsGoldSymbols),
  }));
  const base = spec.base || null;
  const frozen = { repo, tasks: spec.name, taskset_hash: spec.hash, base, ids: prs.map(p => p.id) };
  const s = { name, description: String(description || '').trim() || null, rule: String(rule || '').trim(), ...frozen, taskset_version: spec.version, prs, hash: hashOf(frozen) };
  s.checks = checkPrset(benchDir, s, db);
  return s;
}

export function createPrset(benchDir, db, { name, tasks, ids, rule, description, draft = false }) {
  if (!NAME.test(name || '')) throw new Error('name: letters, digits, . _ -');
  if (db.getPrset(name)) throw new Error(`PR set ${name} exists; pick a new name`);
  if (!draft && !String(rule || '').trim()) throw new Error('say how the PRs were chosen (the selection rule), before any result is seen');
  const s = { ...compose(benchDir, db, { name, tasks, ids, rule, description }), status: draft ? 'draft' : 'frozen', created_at: Date.now(), ...(draft ? {} : { frozen_at: Date.now() }) };
  db.putPrset(s);
  return s;
}

// change a draft; a frozen set is never changed
export function updatePrset(benchDir, db, name, changes) {
  const prev = db.getPrset(name);
  if (!prev) throw new Error(`no PR set ${name}`);
  if (isFrozen(prev)) throw new Error(`PR set ${name} is frozen: a different selection is a new PR set`);
  const s = { ...compose(benchDir, db, { name, tasks: changes.tasks ?? prev.tasks, ids: changes.ids ?? prev.ids, rule: changes.rule ?? prev.rule, description: changes.description ?? prev.description }), status: 'draft', created_at: prev.created_at, updated_at: Date.now() };
  db.putPrset(s);
  return s;
}

export function freezePrset(benchDir, db, name) {
  const prev = db.getPrset(name);
  if (!prev) throw new Error(`no PR set ${name}`);
  if (isFrozen(prev)) throw new Error(`PR set ${name} is already frozen`);
  if (!prev.rule) throw new Error('say how the PRs were chosen (the selection rule) before freezing');
  const s = { ...compose(benchDir, db, prev), status: 'frozen', created_at: prev.created_at, frozen_at: Date.now() };
  db.putPrset(s);
  return s;
}
