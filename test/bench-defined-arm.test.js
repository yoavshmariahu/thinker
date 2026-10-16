import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// bench/run.js with an arm defined as data (--arm-defs) and a fake `claude` on PATH: no model is called.
test('run.js gives a defined arm its MCP servers, system text, env, before/after steps and diff exclusions, and stages no notes for arms served none', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-defined-arm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bench'));
  for (const f of ['run.js', 'worktrees.js', 'oracle.js']) fs.copyFileSync(path.join(ROOT, 'bench', f), path.join(root, 'bench', f));
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  const repo = path.join(root, 'bench', 'repos', 'r');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const tasks = path.join(root, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify({ repo: 'r', tasks: [{ id: 'T1', type: 'change', prompt: 'Implement the following change in this repository.\n\nChange a.txt.' }] }));
  const defs = path.join(root, 'arm-defs.json');
  fs.writeFileSync(defs, JSON.stringify({ tool: {
    description: 'a tool', notes: false, mcpServers: { tool: { command: 'tool-mcp', args: ['--workspace', '{cwd}'] } },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] }, system: 'TOOL INSTRUCTIONS', env: { TOOL_HOME: '/tool-home' },
    before: { command: ['sh', '-c', 'mkdir -p .tool && echo built > .tool/index && echo indexed'] }, after: { command: ['sh', '-c', 'echo after'] }, exclude: ['.tool'],
  } }));
  // the fake agent: records how it was started, edits a.txt, prints Claude Code's JSON result
  const bin = path.join(root, 'bin'), log = path.join(root, 'claude-calls.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), toolHome: process.env.TOOL_HOME || null, index: fs.existsSync('.tool/index') }) + '\\n');
fs.writeFileSync('a.txt', 'changed\\n');
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: 'done', session_id: 's-' + Date.now(), num_turns: 2, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { m: {} } })));
`, { mode: 0o755 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-defined-arm-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = execFileSync(process.execPath, [path.join(root, 'bench', 'run.js'), '--repo', 'r', '--tasks', tasks, '--arm', 'nocache,tool', '--model', 'm', '--tag', 't', '--no-judge', '--arm-defs', defs],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, THINKER_TEST: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  assert.ok(fs.existsSync(log), out);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(calls.length, 2);
  const [off, tool] = calls;
  const argOf = (c, k) => c.argv[c.argv.indexOf(k) + 1];
  assert.equal(argOf(off, '--mcp-config'), '{"mcpServers":{}}');
  assert.equal(off.toolHome, null, 'the cache-off arm gets none of the tool');
  assert.deepEqual(JSON.parse(argOf(tool, '--mcp-config')), { mcpServers: { tool: { command: 'tool-mcp', args: ['--workspace', tool.cwd] } } }, '{cwd} is the session worktree');
  assert.ok(JSON.parse(argOf(tool, '--settings')).hooks.SessionStart);
  assert.match(argOf(tool, '--append-system-prompt'), /TOOL INSTRUCTIONS/);
  assert.equal(tool.toolHome, '/tool-home');
  assert.equal(tool.index, true, 'the before step ran in the worktree before the session');
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'runs', 't', 'T1-tool-0.json'), 'utf8'));
  assert.match(rec.diff, /a\.txt/);
  assert.doesNotMatch(rec.diff, /\.tool/, 'excluded paths stay out of the graded diff');
  assert.match(rec.armSteps.before.tail, /indexed/); assert.match(rec.armSteps.after.tail, /after/);
  assert.equal(fs.existsSync(path.join(root, 'bench', 'runs', 't', 'notes-staged')), false, 'no notes are staged for arms served none');
});
