#!/usr/bin/env node
// Re-judge change-task runs with N judge samples; score = median. Keeps the
// original grade as grade0. Usage: node bench/rejudge.js <runTag> [samples=3] [conc=4]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, tag, samplesArg = '3', concArg = '4'] = process.argv;
const samples = Number(samplesArg), conc = Number(concArg);
const dir = path.join(HERE, 'runs', tag);
const SCHEMA = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } }, required: ['score', 'reason'] };
const SYSTEM = 'You grade a coding agent\'s patch against the patch that was actually merged upstream for the same request. Score 1.0 if the agent changed the right place(s) and the change is functionally equivalent to the merged patch (tests/changelog/formatting differences do not matter); 0.5 if the agent found the right location and the change is in the right direction but incomplete or partly wrong; 0 if the agent changed the wrong place, made no functional change, or the change would not achieve the request. Judge behavior, not style. Use only 0, 0.5 or 1.';
const specs = {};
function taskOf(rec) {
  for (const f of ['mitmproxy-hard.json', 'mitmproxy.json']) {
    specs[f] ||= JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', f), 'utf8'));
    const t = specs[f].tasks.find(t => t.id === rec.task); if (t) return t;
  }
  return null;
}
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json');
async function worker() {
  while (files.length) {
    const f = files.shift();
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (rec.grade?.samples?.length >= samples) continue;
    const task = taskOf(rec); if (!task || !task.goldDiff) continue;
    const gold = fs.readFileSync(path.join(HERE, '..', task.goldDiff), 'utf8');
    const prompt = `REQUEST:\n${task.prompt}\n\nMERGED UPSTREAM PATCH:\n${gold.slice(0, 30000)}\n\nAGENT PATCH:\n${(rec.diff || '(empty)').slice(0, 30000)}\n\nAGENT SUMMARY:\n${(rec.result || '').slice(0, 4000)}`;
    const scores = [], reasons = [];
    for (let i = 0; i < samples; i++) { try { const r = await complete({ model: 'sonnet', system: SYSTEM, prompt, schema: SCHEMA }); scores.push(Number(r.json.score)); reasons.push(r.json.reason); } catch (e) { reasons.push('ERR ' + e.message); } }
    if (!scores.length) continue;
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    rec.grade0 ||= rec.grade;
    rec.grade = { ...rec.grade, score: median, samples: scores, reasons };
    fs.writeFileSync(path.join(dir, f), JSON.stringify(rec, null, 2));
    console.log(`${rec.id}: ${scores.join('/')} → ${median}`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
