#!/usr/bin/env node
// Grade a question-answering task by the facts its answers name: `facts.json` beside the task's prompts is a
// list of { id, turn, re } written before the run, each a pattern the answer to that turn must contain. No
// judge and no diff: these tasks change nothing, so bench.mjs's diff judge has nothing to read.
//   node bench/facts.mjs <tag>
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const RUNS = process.env.BENCH_RUNS || path.join(ROOT, 'bench', 'runs');
const tag = process.argv[2];
const rows = fs.readFileSync(path.join(ROOT, 'bench', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.tag === tag);
const byArm = {};
for (const r of rows) {
  const f = path.join(path.resolve(ROOT, r.tasksDir), r.task, 'facts.json');
  if (!fs.existsSync(f)) continue;
  const facts = JSON.parse(fs.readFileSync(f, 'utf8')).facts;
  const turns = JSON.parse(fs.readFileSync(path.join(RUNS, tag, `${r.id}.json`), 'utf8')).turns;
  const missed = facts.filter(x => !new RegExp(x.re).test(String(turns[x.turn - 1]?.result || ''))).map(x => x.id);
  const a = byArm[r.arm] ||= { met: 0, of: 0 };
  if (r.valid) { a.met += facts.length - missed.length; a.of += facts.length; }
  console.log(`${r.id}${r.valid ? '' : ' INVALID'}: ${facts.length - missed.length}/${facts.length}${missed.length ? ` missed ${missed.join(',')}` : ''}`);
}
for (const [arm, a] of Object.entries(byArm)) console.log(`${arm}: ${a.met}/${a.of} facts (valid sessions)`);
