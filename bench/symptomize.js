#!/usr/bin/env node
// Rewrite PR-body tasks as symptom-only requests (no file, class, function or
// module names), verified against the gold diff's identifiers.
// Usage: node bench/symptomize.js <repo>   → bench/tasks/<repo>-hard.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';
import { explicitIdents } from '../src/guard.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', `${repo}.json`), 'utf8'));
const SCHEMA = { type: 'object', properties: { symptom: { type: 'string' } }, required: ['symptom'] };
const PRE = 'Implement the following change in this repository. Do not install dependencies or run the test suite; make the code change (and adjust or add a test if it is natural), then summarize what you changed and why.\n\n';
async function one(t) {
  const diff = fs.readFileSync(path.join(HERE, '..', t.goldDiff), 'utf8');
  const banned = new Set([...explicitIdents(diff), ...t.goldFiles.flatMap(f => f.split('/').pop().split('.')[0].split(/(?=[A-Z])|_/)).filter(s => s.length > 4)]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await complete({ model: 'sonnet', schema: SCHEMA,
      system: 'You rewrite a pull request description into the request a product manager or user would have written BEFORE the fix existed: what is wrong or missing, observable behavior, and the desired behavior. Keep every behavioral detail needed to implement it correctly. Remove every implementation detail: no file names, class names, function names, module or directory names, endpoint paths, variable names, or code identifiers of any kind. Use plain product vocabulary (the feature, the page, the button, the setting). 3-8 sentences.',
      prompt: `PR TITLE: ${t.goldTitle}\n\nPR DESCRIPTION:\n${t.prompt.replace(PRE, '')}\n\nFILES CHANGED (for your reference only, never mention them): ${t.goldFiles.join(', ')}` });
    const sym = r.json.symptom.trim();
    const leaks = explicitIdents(sym).filter(x => banned.has(x));
    if (!leaks.length) return sym;
    console.log(`  ${t.id}: retry, leaked ${leaks.join(', ')}`);
  }
  return null;
}
const out = [];
for (const t of spec.tasks) {
  const sym = await one(t);
  if (!sym) { console.log(`${t.id}: FAILED`); continue; }
  out.push({ ...t, id: t.id + '-hard', prompt: PRE + sym });
  console.log(`${t.id}: ${sym.slice(0, 160)}`);
}
fs.writeFileSync(path.join(HERE, 'tasks', `${repo}-hard.json`), JSON.stringify({ ...spec, tasks: out }, null, 1));
console.log(`wrote ${out.length} symptom-only tasks`);
