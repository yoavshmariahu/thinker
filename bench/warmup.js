#!/usr/bin/env node
// Warm-up: run the learning tasks cold (no cache), then distill each session
// transcript into the cache. Usage: node bench/warmup.js click [concurrency] [model]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const [,, repoName = 'click', conc = '2', model = 'sonnet', onlyIds] = process.argv;
const repo = path.join(HERE, 'repos', repoName);
const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', `${repoName}.json`), 'utf8'));
const only = onlyIds ? onlyIds.split(',') : null;
const outDir = path.join(HERE, 'runs', `warmup-${repoName}`);
fs.mkdirSync(outDir, { recursive: true });
const enc = repo.replace(/[\/.]/g, '-');

function run(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'Edit,Write,NotebookEdit', '--max-turns', '60'], { cwd: repo });
    let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => { try { resolve(JSON.parse(o)); } catch (e) { reject(new Error('bad output: ' + o.slice(0, 200))); } }); p.stdin.end(prompt);
  });
}

const queue = spec.learn.filter(t => !only || only.includes(t.id));
async function worker() {
  while (queue.length) {
    const t = queue.shift();
    const f = path.join(outDir, t.id + '.json');
    if (fs.existsSync(f)) { console.log(`skip ${t.id}`); continue; }
    const t0 = Date.now();
    let r; try { r = await run(t.prompt); } catch (e) { console.log(`${t.id} ERROR ${e.message}`); continue; }
    const transcript = path.join(os.homedir(), '.claude', 'projects', enc, r.session_id + '.jsonl');
    let distill = '';
    try { distill = execFileSync('node', [CLI, 'distill', transcript, '--repo', repo], { encoding: 'utf8' }); } catch (e) { distill = 'DISTILL ERROR ' + e.message; }
    fs.writeFileSync(f, JSON.stringify({ id: t.id, session: r.session_id, turns: r.num_turns, cost: r.total_cost_usd, ms: Date.now() - t0, result: r.result, distill }, null, 2));
    console.log(`${t.id}: ${r.num_turns} turns, $${r.total_cost_usd?.toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(0)}s\n  ${distill.trim().split('\n').join('\n  ')}`);
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
