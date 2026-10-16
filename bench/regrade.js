#!/usr/bin/env node
// Regrade an experiment's answers with a named judge, from the answers already recorded: no agent
// session runs again. Each question's answer is graded against its reference (judge-protocol.js:
// judgeAnswer); the grade it replaces is kept in grade.gradedBefore. Started by Artemis
// (evals/jobs.js:launchRegrade), which reimports the run when this exits.
// Usage: node bench/regrade.js <run dir> <tasks.json> <judge model> [conc]
import fs from 'node:fs';
import path from 'node:path';
import { judgeAnswer } from './judge-protocol.js';

const [,, dir, tasksFile, judge, concArg = '4'] = process.argv;
if (!dir || !tasksFile || !judge) { console.error('usage: regrade.js <run dir> <tasks.json> <judge model> [conc]'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
const tasks = new Map((spec.tasks || spec).map(t => [t.id, t]));
const regradable = (rec, task) => Boolean(task?.gold && rec && !rec.error && typeof rec.result === 'string' && rec.result.trim());
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !['summary.json', 'tasks.json', 'arm-defs.json'].includes(f));
const todo = files.filter(f => { try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return regradable(r, tasks.get(r.task)) && r.grade?.judge !== judge; } catch { return false; } });
console.log(`regrading ${todo.length} answers with ${judge}`);
let failed = 0;
async function worker() {
  while (todo.length) {
    const f = todo.shift(), file = path.join(dir, f);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    try {
      const grade = await judgeAnswer(tasks.get(rec.task), rec.result, { model: judge });
      rec.grade = { ...grade, gradedBefore: [...(rec.grade?.gradedBefore || []), ...(rec.grade ? [{ ...rec.grade, gradedBefore: undefined }] : [])] };
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
      console.log(`${rec.id}: ${grade.score} (${judge})`);
    } catch (e) { failed++; console.log(`${rec.id} ERROR ${e.message.slice(0, 200)}`); }
  }
}
await Promise.all(Array.from({ length: Number(concArg) || 4 }, worker));
console.log(`done: ${failed} failed`);
process.exit(failed ? 1 : 0);
