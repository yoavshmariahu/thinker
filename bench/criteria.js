#!/usr/bin/env node
// Acceptance-criteria grading.
//   node bench/criteria.js build <tasksFile>          → adds task.criteria (behavioural checklist from the merged PR)
//   node bench/criteria.js grade <tasksFile> <tag...> → grades stored patches per criterion; writes grade.criteria
//     --judge <model> (default sonnet) regrades runs another judge graded; earlier grades are kept in grade.criteriaBy
//   node bench/criteria.js calibrate <tasksFile>      → grades the merged patch and an empty patch
import fs from 'node:fs';
import { createWorktree } from './worktrees.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete, resolveModel } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly } from './judge-protocol.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const strictIndex = argv.indexOf('--strict-model');
const STRICT_MODEL = strictIndex >= 0;
if (STRICT_MODEL) argv.splice(strictIndex, 1);
const ji = argv.indexOf('--judge');
const JUDGE = ji < 0 ? 'sonnet' : argv.splice(ji, 2)[1];
const [cmd, tasksFile, ...tags] = argv;
const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

const BUILD_SCHEMA = { type: 'object', properties: { criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, behavior: { type: 'string' }, essential: { type: 'boolean' } }, required: ['id', 'behavior', 'essential'] } } }, required: ['criteria'] };

import { execFileSync } from 'node:child_process';
const repo = path.join(HERE, 'repos', spec.repo);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
function worktree(i) {
  const wt = path.join(HERE, 'worktrees', `${spec.repo}-grade-${i}`);
  return createWorktree(repo, wt, spec.base || 'HEAD');
}
// post-patch code around every hunk, so behaviour can be judged in context
function hunks(diff) {
  const out = []; let file = null;
  for (const l of diff.split('\n')) {
    const f = l.match(/^\+\+\+ b\/(.+)$/); if (f) { file = f[1]; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/); if (h && file) out.push({ file, start: Number(h[1]), len: Number(h[2] ?? 1) });
  }
  return out;
}
function contextFrom(read, diff, pad = 80, cap = 80000) {
  const by = {}; for (const h of hunks(diff)) (by[h.file] ||= []).push([Math.max(1, h.start - pad), h.start + h.len + pad]);
  let text = '';
  for (const [file, ranges] of Object.entries(by)) {
    const src = read(file); if (src == null) continue;
    const lines = src.split('\n');
    if (lines.length <= 300) {
      text += `\n--- ${file} (full file, ${lines.length} lines after patch) ---\n${src}\n`;
      if (text.length > cap) return text.slice(0, cap);
      continue;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = []; for (const r of ranges) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 5) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
    for (const [a, b] of merged) { text += `\n--- ${file} lines ${a}-${Math.min(b, lines.length)} (after patch) ---\n${lines.slice(a - 1, b).join('\n')}\n`; if (text.length > cap) return text.slice(0, cap); }
  }
  return text;
}
function agentContext(wt, diff) {
  const src = srcOnly(diff).split(/^(?=diff --git )/m).filter(c => !/^diff --git a\/\.thinker/.test(c)).join('');
  if (!src.trim()) return '';
  try { git(wt, 'checkout', '-q', '--', '.'); git(wt, 'clean', '-qfd'); } catch {}
  try { execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: wt, input: src, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return ''; }
  const ctx = contextFrom(f => { try { return fs.readFileSync(path.join(wt, f), 'utf8'); } catch { return null; } }, src);
  try { git(wt, 'checkout', '-q', '--', '.'); git(wt, 'clean', '-qfd'); } catch {}
  return ctx;
}
function goldContext(t) {
  const gold = srcOnly(fs.readFileSync(path.join(HERE, '..', t.goldDiff), 'utf8'));
  const merge = t.mergeCommit; if (!merge) return '';
  return contextFrom(f => { try { return git(repo, 'show', `${merge}:${f}`); } catch { return null; } }, gold);
}

async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }

if (cmd === 'build') {
  await pool(spec.tasks.filter(t => !t.criteria), 4, async t => {
    const gold = fs.readFileSync(path.join(HERE, '..', t.goldDiff), 'utf8');
    const r = await complete({ model: 'opus', schema: BUILD_SCHEMA,
      system: 'You write acceptance criteria for a change request, to grade independent implementations. From the request and the patch that was merged, list the observable BEHAVIOURS a correct implementation must have. Rules: state behaviour, never implementation (no file, function, variable or class names; no "uses X"); each criterion independently checkable by reading a patch; include the edge cases the merged patch handles that follow from the request; do not include tests, docs, changelog, refactors, naming or style; mark as essential the criteria without which the request is not fulfilled, and as non-essential the extra hardening the merged patch happened to add. 3-8 criteria.',
      prompt: `REQUEST:\n${t.prompt}\n\nMERGED PATCH:\n${gold.slice(0, 40000)}` });
    t.criteria = r.json.criteria.map((c, i) => ({ ...c, id: 'c' + (i + 1) }));
    console.log(`${t.id}: ${t.criteria.length} criteria (${t.criteria.filter(c => c.essential).length} essential)`);
    fs.writeFileSync(tasksFile, JSON.stringify(spec, null, 1));
  });
} else {
  const gradePatch = async (t, patch, summary, context = '') => {
    const r = await complete({ model: JUDGE, schema: GRADE_SCHEMA,
      system: JUDGE_SYSTEM_PROMPT,
      prompt: `REQUEST:\n${t.prompt}\n\nCRITERIA:\n${t.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(patch) || '(empty patch)').slice(0, 40000)}\n\nCODE AFTER PATCH (around each change):\n${context || '(not available)'}\n\nAUTHOR SUMMARY:\n${(summary || '').slice(0, 3000)}` });
    const expectedModel = resolveModel('claude', JUDGE);
    if (STRICT_MODEL && r.model !== expectedModel) throw new Error(`judge model mismatch: requested ${expectedModel}, got ${r.model}`);
    const res = r.json.results; const by = Object.fromEntries(res.map(x => [x.id, x.verdict]));
    const usable = t.criteria.filter(c => c.calibrated !== false);
    const ess = usable.filter(c => c.essential), all = usable;
    const frac = cs => cs.length ? cs.filter(c => by[c.id] === 'met').length / cs.length : 1;
    return { judge: JUDGE, resolvedModel: r.model, essential: frac(ess), all: frac(all), extra: usable.some(c => !c.essential) ? frac(usable.filter(c => !c.essential)) : null, pass: ess.every(c => by[c.id] === 'met'), results: res };
  };
  const byId = Object.fromEntries(spec.tasks.map(t => [t.id, t]));
  if (cmd === 'calibrate') {
    for (const t of spec.tasks) for (const c of t.criteria) delete c.calibrated;
    await pool(spec.tasks, 4, async t => {
      const gold = fs.readFileSync(path.join(HERE, '..', t.goldDiff), 'utf8');
      const g = await gradePatch(t, gold, '', goldContext(t)), e = await gradePatch(t, '', '');
      const gv = Object.fromEntries(g.results.map(x => [x.id, x.verdict])), ev = Object.fromEntries(e.results.map(x => [x.id, x.verdict]));
      // keep a criterion only if the merged patch meets it and an empty patch does not
      for (const c of t.criteria) c.calibrated = gv[c.id] === 'met' && ev[c.id] !== 'met';
      const kept = t.criteria.filter(c => c.calibrated);
      console.log(`${t.id}: merged patch met ${g.results.filter(x => x.verdict === 'met').length}/${t.criteria.length}; empty patch met ${e.results.filter(x => x.verdict === 'met').length}; kept ${kept.length} criteria (${kept.filter(c => c.essential).length} essential)`);
    });
    fs.writeFileSync(tasksFile, JSON.stringify(spec, null, 1));
  } else if (cmd === 'grade') {
    for (const tag of tags) {
      const dir = path.join(HERE, 'runs', tag);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json');
      let n = 0;
      const free = [0, 1, 2, 3].map(worktree);
      await pool(files, 4, async f => {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const old = rec.grade?.criteria;
        // an empty run: one turn and no tool calls (Codex reports a whole session as one turn)
        if (rec.error || (rec.turns <= 1 && !rec.tools?.calls) || (old && (old.judge || 'sonnet') === JUDGE) || !byId[rec.task]) return;
        const wt = free.pop();
        try { const ctx = agentContext(wt, rec.diff || ''); free.push(wt); const criteria = await gradePatch(byId[rec.task], rec.diff || '', rec.result, ctx); rec.grade = { ...(rec.grade || {}), criteria, ...(old ? { criteriaBy: { ...(rec.grade.criteriaBy || {}), [old.judge || 'sonnet']: old } } : {}) }; fs.writeFileSync(path.join(dir, f), JSON.stringify(rec, null, 2)); n++; } catch (e) { if (!free.includes(wt)) free.push(wt); console.log(`${f}: ${e.message.slice(0, 100)}`); }
      });
      console.log(`${tag}: graded ${n}`);
    }
  }
}
