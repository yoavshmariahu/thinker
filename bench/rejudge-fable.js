#!/usr/bin/env node
// Standardized Fable criteria judge for all PostHog benchmark runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, targetDir = 'bench/runs/posthog-gemini-3.8'] = process.argv;
const tasksFile = path.join(HERE, 'tasks', 'posthog-hard.json');
const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
const byId = Object.fromEntries(spec.tasks.map(t => [t.id, t]));

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'not_met', 'unclear'] },
          evidence: { type: 'string' }
        },
        required: ['id', 'verdict', 'evidence']
      }
    }
  },
  required: ['results']
};

const srcOnly = d => (d || '').split(/^(?=diff --git )/m).filter(c => !/^diff --git a\/\S*(test_|\.test\.|\/tests?\/|__tests__|__snapshots__|\.ambr|\.snap)/.test(c)).join('');

async function gradeWithFable(task, diff, summary = '') {
  process.env.THINKER_LLM = 'claude';
  const system = "You check a patch against acceptance criteria. For each criterion decide whether the code after the patch would exhibit that behaviour: met, not_met, or unclear when what you are shown is not enough to tell. Any design that produces the behaviour counts; do not require a particular file, layer or approach. The author's summary is a claim, not evidence. Quote the code that decides each verdict.";
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(diff) || '(empty patch)').slice(0, 40000)}\n\nAUTHOR SUMMARY:\n${(summary || '').slice(0, 3000)}`;

  const res = await complete({ model: 'fable', system, prompt, schema: GRADE_SCHEMA });
  const results = res.json?.results || [];
  const by = Object.fromEntries(results.map(x => [x.id, x.verdict]));
  const usable = task.criteria.filter(c => c.calibrated !== false);
  const ess = usable.filter(c => c.essential);
  const frac = cs => cs.length ? cs.filter(c => by[c.id] === 'met').length / cs.length : 1;
  return {
    judge: 'fable',
    essential: frac(ess),
    all: frac(usable),
    pass: ess.every(c => by[c.id] === 'met'),
    results
  };
}

async function main() {
  const dir = path.resolve(targetDir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json');
  console.log(`Re-judging ${files.length} benchmark runs with Claude Fable:`);

  for (const f of files) {
    const file = path.join(dir, f);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!byId[rec.task]) continue;
    if (rec.grade?.judge === 'fable' && rec.grade?.essential !== undefined) {
      console.log(`[skip] ${f} (already judged by Fable: ess=${(rec.grade.essential * 100).toFixed(0)}%)`);
      continue;
    }

    try {
      const g = await gradeWithFable(byId[rec.task], rec.diff || '', rec.result || '');
      rec.grade = g;
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
      const passStr = g.pass ? 'PASS' : 'FAIL';
      console.log(`[graded] ${f}: essential=${(g.essential * 100).toFixed(0)}% [${passStr}]`);
    } catch (err) {
      console.error(`[error] ${f}: ${err.message}`);
    }
  }
  console.log('\nAll runs standardized with Claude Fable judgment.');
}

main().catch(e => { console.error(e); process.exit(1); });
