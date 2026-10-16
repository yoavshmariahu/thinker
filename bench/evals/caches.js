// Caches: what the cache-on arm is served. A cache is built by the product's own mining path
// (`thinker mine-prs --git`, then `phrase` and `relink`) in a checkout whose history stops at an
// anchor commit, by the same model the agent will run (AGENTS.md: benchmark caches come from mining,
// out of the task's past; matched models). The build writes bench/caches/<name>/receipt.json with
// its provenance; the checkout and notes beside it are not checked in.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NAME, git, isAncestor } from './prsets.js';

export const LLMS = ['claude', 'codex', 'gemini'];
const dir = benchDir => path.join(benchDir, 'caches');
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export const cacheDir = (benchDir, name) => path.join(dir(benchDir), name);
export const notesDir = (benchDir, name) => path.join(cacheDir(benchDir, name), 'repo', '.thinker', 'notes');
export const readReceipt = (benchDir, name) => (NAME.test(name || '') ? readJson(path.join(cacheDir(benchDir, name), 'receipt.json')) : null);

export function listCaches(benchDir) {
  const d = dir(benchDir);
  return (fs.existsSync(d) ? fs.readdirSync(d) : []).map(n => readReceipt(benchDir, n)).filter(Boolean).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function countNotes(notes) {
  try { return fs.readdirSync(notes).filter(f => f.endsWith('.json') || f.endsWith('.md')).length; } catch { return 0; }
}
// how many notes came from mining (source.type 'pr', src/commands/learn.js:minePrs) and how many from anything else
export function noteSources(notes) {
  const c = { pr: 0, other: 0 };
  try { for (const f of fs.readdirSync(notes)) { try { const n = JSON.parse(fs.readFileSync(path.join(notes, f), 'utf8')); n.source?.type === 'pr' ? c.pr++ : c.other++; } catch {} } } catch {}
  return c;
}
export function hashNotes(notes) {
  const h = createHash('sha256');
  try { for (const f of fs.readdirSync(notes).sort()) h.update(f).update(fs.readFileSync(path.join(notes, f))); } catch { return null; }
  return h.digest('hex').slice(0, 16);
}

// Validate a build request; the job itself is build-cache.js.
export function planCache(req, benchDir) {
  const name = String(req.name || '');
  if (!NAME.test(name)) throw new Error('cache name: letters, digits, . _ -');
  if (fs.existsSync(cacheDir(benchDir, name))) throw new Error(`cache ${name} exists; caches are immutable, pick a new name`);
  const repo = String(req.repo || '');
  const repoDir = path.join(benchDir, 'repos', repo);
  if (!NAME.test(repo) || !git(repoDir, ['rev-parse', 'HEAD'])) throw new Error(`bench/repos/${repo} is not a git checkout`);
  const anchor = git(repoDir, ['rev-parse', '--verify', `${String(req.anchor || 'HEAD').replace(/[^A-Za-z0-9^~_./-]/g, '')}^{commit}`]);
  if (!anchor) throw new Error(`anchor ${req.anchor} is not a commit in bench/repos/${repo}`);
  const llm = String(req.llm || 'claude');
  if (!LLMS.includes(llm)) throw new Error('mining runs on claude, codex or gemini');
  const model = String(req.model || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,80}$/.test(model)) throw new Error('name the mining model; it must be the model the agent will run');
  const limit = Math.max(5, Math.min(200, Number(req.limit) || 60));
  const effort = req.effort ? String(req.effort) : null;
  if (effort && !/^[a-z]{1,12}$/.test(effort)) throw new Error('effort is not valid');
  return {
    name, repo, anchor, anchor_date: git(repoDir, ['show', '-s', '--format=%cI', anchor]), anchor_subject: git(repoDir, ['show', '-s', '--format=%s', anchor]),
    llm, model, effort, limit, source: 'git',
    steps: [`snapshot bench/repos/${repo} at ${anchor.slice(0, 10)} (history after it is not in the checkout)`, `thinker mine-prs --git --limit ${limit}`, 'thinker phrase', 'thinker relink'],
    estimate: { note: `about ${limit} merged changes distilled by ${model}; the product logs the tokens it spends, shown on the receipt` },
  };
}

// Whether a built cache may be served for a PR set: built and not empty, at or before the PR set's
// base, holding none of its fixes, by the model the agent runs.
export function checkCache(benchDir, receipt, prset, agentModel) {
  const out = [];
  if (!receipt) return [{ ok: false, check: 'cache', detail: 'no such cache' }];
  out.push({ ok: receipt.status === 'ok', check: 'built', detail: receipt.status === 'ok' ? `${receipt.notes} notes, ${receipt.described ?? '?'} described` : `status ${receipt.status}${receipt.error ? ': ' + receipt.error : ''}` });
  out.push({ ok: receipt.notes > 0, check: 'not empty', detail: `${receipt.notes || 0} notes` });
  const src = noteSources(notesDir(benchDir, receipt.name));
  out.push({ ok: src.pr > 0 && !src.other, check: 'every note mined from a PR', detail: `${src.pr} from PRs, ${src.other} from elsewhere` });
  const now = hashNotes(notesDir(benchDir, receipt.name));
  out.push({ ok: !receipt.notes_hash || now === receipt.notes_hash, check: 'unchanged since built', detail: now === receipt.notes_hash ? `notes hash ${now}` : `notes changed after the build (${receipt.notes_hash} → ${now})` });
  if (prset) {
    const repoDir = path.join(benchDir, 'repos', prset.repo);
    out.push({ ok: receipt.repo === prset.repo, check: 'same repository', detail: `cache ${receipt.repo}, PRs ${prset.repo}` });
    const base = prset.base || git(repoDir, ['rev-parse', 'HEAD']);
    out.push({ ok: Boolean(base) && isAncestor(repoDir, receipt.anchor, base), check: 'anchor at or before the base', detail: `anchor ${receipt.anchor.slice(0, 10)}, base ${(base || '?').slice(0, 10)}` });
    const leaked = prset.prs.filter(p => p.mergeCommit && isAncestor(repoDir, p.mergeCommit, receipt.anchor)).map(p => p.id);
    const unchecked = prset.prs.filter(p => !p.mergeCommit).length;
    out.push({ ok: !leaked.length, check: 'no PR fix in the cache\'s history', detail: leaked.length ? `fixes before the anchor: ${leaked.join(', ')}` : unchecked ? `${unchecked} PRs record no merge commit and were not checked` : 'none of the PRs is reachable from the anchor' });
  }
  if (agentModel != null) out.push({ ok: receipt.model === agentModel, check: 'mined by the agent\'s model', detail: `cache ${receipt.model}, agent ${agentModel}` });
  return out;
}
