#!/usr/bin/env node
// Generate expert reference answers for tasks with a strong model that has full repo access.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, repoName = 'click', model = 'opus', onlyIds] = process.argv;
const repo = path.join(HERE, 'repos', repoName);
const file = path.join(HERE, 'tasks', `${repoName}.json`);
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const only = onlyIds ? onlyIds.split(',') : null;

function run(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'Edit,Write,NotebookEdit', '--append-system-prompt', 'You are producing a reference answer for grading other agents. Be exhaustive and precise: verify every claim by reading the code; give file:symbol pointers; state the key facts explicitly. Do not hedge.'], { cwd: repo });
    let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => { try { resolve(JSON.parse(o)); } catch (e) { reject(e); } }); p.stdin.end(prompt);
  });
}

const tasks = spec.tasks.filter(t => !only || only.includes(t.id));
await Promise.all(tasks.map(async t => {
  if (t.gold && !only) return;
  const r = await run(t.prompt);
  t.gold = r.result; t.goldCost = r.total_cost_usd; t.goldTurns = r.num_turns;
  console.log(`${t.id}: ${r.num_turns} turns $${r.total_cost_usd?.toFixed(2)}`);
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
}));
