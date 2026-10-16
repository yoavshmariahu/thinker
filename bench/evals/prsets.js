// PR sets: the PRs an experiment runs, chosen by a stated rule and frozen before any session is
// spent. A PR set is drawn from one task set (bench/tasks/*.json) and saved as bench/prsets/<name>.json
// with its base commit and a hash, so every experiment that uses it runs the same PRs at the same
// commit and says so.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const dir = benchDir => path.join(benchDir, 'prsets');
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
export const hashOf = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

export function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
export const isAncestor = (cwd, a, b) => { try { execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };

export function listPrsets(benchDir) {
  const d = dir(benchDir);
  return (fs.existsSync(d) ? fs.readdirSync(d) : []).filter(f => f.endsWith('.json')).map(f => readJson(path.join(d, f))).filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}
export const readPrset = (benchDir, name) => (NAME.test(name || '') ? readJson(path.join(dir(benchDir), name + '.json')) : null);

// The checks a PR set must pass to be run: the checkout is at the task set's base (the runners work
// at the checkout's HEAD), and every PR's merge commit is not already in that history.
export function checkPrset(benchDir, s) {
  const repoDir = path.join(benchDir, 'repos', s.repo);
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  const checks = [];
  checks.push(!head ? { ok: false, check: 'checkout', detail: `bench/repos/${s.repo} is not a git checkout` }
    : !s.base ? { ok: false, check: 'base', detail: 'the task set records no base commit, so it cannot be checked that the PRs run before their fix' }
    : { ok: head.startsWith(s.base) || s.base.startsWith(head), check: 'checkout at base', detail: `checkout ${head.slice(0, 10)}, task set base ${s.base.slice(0, 10)}` });
  const missing = s.prs.filter(p => !p.mergeCommit).length;
  const reachable = head ? s.prs.filter(p => p.mergeCommit && isAncestor(repoDir, p.mergeCommit, head)).map(p => p.id) : [];
  checks.push({ ok: !reachable.length, check: 'fixes absent from the base', detail: reachable.length ? `merged already: ${reachable.join(', ')}` : missing ? `${missing} PRs record no merge commit and were not checked` : 'no PR is merged in the checkout' });
  return checks;
}

export function createPrset(benchDir, { name, tasks, ids, rule, description }) {
  if (!NAME.test(name || '')) throw new Error('name: letters, digits, . _ -');
  if (fs.existsSync(path.join(dir(benchDir), name + '.json'))) throw new Error(`PR set ${name} exists; PR sets are frozen, pick a new name`);
  if (!NAME.test(tasks || '') || !tasks.endsWith('.json')) throw new Error('task set is not valid');
  const spec = readJson(path.join(benchDir, 'tasks', tasks));
  if (!spec?.tasks?.length) throw new Error(`bench/tasks/${tasks} has no tasks`);
  if (!String(rule || '').trim()) throw new Error('say how the PRs were chosen (the selection rule), before any result is seen');
  const want = ids?.length ? ids : spec.tasks.map(t => t.id);
  const unknown = want.filter(id => !spec.tasks.some(t => t.id === id));
  if (unknown.length) throw new Error('not in the task set: ' + unknown.join(', '));
  const repo = spec.repo ? String(spec.repo).split('/').pop() : tasks.replace(/(-hard|-adv)?\.json$/, '');
  const prs = spec.tasks.filter(t => want.includes(t.id)).map(t => ({
    id: t.id, pr: String(t.id).match(/^PR(\d+)/)?.[1] || null, title: t.goldTitle || null, area: t.area || null,
    mergeCommit: t.mergeCommit || null, mergedAt: t.mergedAt || null, oracle: t.testCmd ? 'tests' : t.type === 'change' ? 'judge' : 'answer judge',
  }));
  const base = spec.base || null;
  const frozen = { repo, tasks, base, ids: prs.map(p => p.id) };
  const s = { name, description: String(description || '').trim() || null, rule: String(rule).trim(), ...frozen, prs, hash: hashOf(frozen), created_at: Date.now() };
  s.checks = checkPrset(benchDir, s);
  fs.mkdirSync(dir(benchDir), { recursive: true });
  fs.writeFileSync(path.join(dir(benchDir), name + '.json'), JSON.stringify(s, null, 2) + '\n');
  return s;
}
