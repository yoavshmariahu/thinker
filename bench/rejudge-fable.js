#!/usr/bin/env node
// Standardized Fable criteria judge for all PostHog benchmark runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, targetDir = 'bench/runs/posthog-gemini-3.8'] = process.argv;
const tasksFile = path.join(HERE, 'tasks', 'posthog-hard.json');
const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
const byId = Object.fromEntries(spec.tasks.map(t => [t.id, t]));

async function gradeWithFable(task, diff, summary = '') {
  process.env.THINKER_LLM = 'claude';
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(diff) || '(empty patch)').slice(0, 40000)}\n\nAUTHOR SUMMARY:\n${(summary || '').slice(0, 3000)}`;

  const res = await complete({ model: 'fable', system: JUDGE_SYSTEM_PROMPT, prompt, schema: GRADE_SCHEMA });
  const results = res.json?.results || [];
  return {
    judge: 'fable',
    ...computeGradeScores(task.criteria, results)
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
