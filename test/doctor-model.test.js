import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installGitHooks } from '../src/git-hooks.js';
import { Store } from '../src/store.js';
import { markAppSession } from '../src/session-work.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src/cli.js');

function machine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-doctor-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo'), models = path.join(dir, 'models');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const model = path.join(models, 'Xenova', 'ms-marco-MiniLM-L-6-v2');
  fs.mkdirSync(path.join(model, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(model, 'onnx', 'model.onnx'), '');
  fs.writeFileSync(path.join(model, 'tokenizer.json'), '{}');
  execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(home, '.thinker'), CODEX_HOME: path.join(home, '.codex'), THINKER_MODELS_DIR: models, THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1' };
  // This fixture is a terminal, even when the test runner itself belongs to the Codex app.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  env.PATH = bin + path.delimiter + env.PATH;
  delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CURSOR_AGENT;
  delete env.CLAUDE_CONFIG_DIR;
  for (const k of ['THINKER_LLM', 'THINKER_LLM_CMD', 'THINKER_LLM_MODEL', 'THINKER_LLM_BASE_URL', 'ANTHROPIC_API_KEY']) delete env[k];
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { env: { ...env, ...extra }, cwd: repo, encoding: 'utf8', timeout: 120_000 });
  return { home, repo, run };
}
const byName = (checks, name) => checks.find(c => c.name === name);
const node = JSON.stringify(process.execPath);

test('doctor probes the model that answers thinker\'s calls, and says when it does not answer', t => {
  const { run } = machine(t);
  const ok = run(['doctor', '--json'], { THINKER_LLM: 'command', THINKER_LLM_CMD: `${node} -e "process.stdout.write('ok')"` });
  const m = byName(JSON.parse(ok.stdout), 'model');
  assert.equal(m.status, 'ok', m.detail);
  assert.match(m.detail, /^command answers \(/);

  const bad = run(['doctor', '--json'], { THINKER_LLM: 'command', THINKER_LLM_CMD: `${node} -e "console.error('401 Unauthorized from the gateway'); process.exit(1)"` });
  assert.equal(bad.status, 1);
  const f = byName(JSON.parse(bad.stdout), 'model');
  assert.equal(f.status, 'fail');
  assert.match(f.detail, /command does not answer: .*401 Unauthorized/);

  // the gateway provider without a model name fails with what to set, before any request
  const named = run(['doctor', '--json'], { THINKER_LLM: 'openai', THINKER_LLM_BASE_URL: 'http://127.0.0.1:9/v1' });
  const n = byName(JSON.parse(named.stdout), 'model');
  assert.equal(n.status, 'fail');
  assert.match(n.detail, /THINKER_LLM_MODEL/);

  // under test, with no provider pinned, the winner is named without a call
  const quiet = run(['doctor', '--json']);
  const q = byName(JSON.parse(quiet.stdout), 'model');
  assert.match(q.detail, /not probed under test|^none:/);
});

test('doctor says when the git hook is someone else\'s, with the path and the line to add, instead of sending to setup', t => {
  const { repo, run } = machine(t);
  const setup = run(['setup', '--no-build', '--yes', '--no-ui', '--clients', 'claude', '--no-git-hook']);
  assert.equal(setup.status, 0, setup.stderr);
  const hooks = path.join(repo, '.githooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\ngit lfs post-commit "$@"\n', { mode: 0o755 });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo });

  const r = run(['doctor', '--json']);
  const h = byName(JSON.parse(r.stdout), 'git hooks');
  assert.equal(h.status, 'warn');
  assert.match(h.detail, /post-commit hook at .*\.githooks\/post-commit is not thinker's \(core\.hooksPath=\.githooks\)/);
  assert.match(h.detail, /add this line to the post-commit hook: nohup node .* --quiet --repo "\$repo" >\/dev\/null 2>&1 &$/);
  assert.doesNotMatch(h.detail, /thinker setup/);

  // setup's hook install leaves that hook alone and says where it is
  const said = [];
  installGitHooks(repo, CLI, true, l => said.push(l));
  assert.match(said.join('\n'), /skipped git post-commit hook: the existing hook at .*post-commit is not ours/);
  assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /git lfs/);
});

test('a terminal doctor recognizes queued learning from a recent Codex app session', t => {
  const { repo, run } = machine(t);
  markAppSession(new Store(repo).init(), 'the Codex app');
  const r = run(['doctor', '--json'], { THINKER_LLM: 'no-such-provider', THINKER_NO_LEARN: '0' });
  const checks = JSON.parse(r.stdout);
  assert.match(byName(checks, 'model').detail, /the Codex app.*no CLI login/);
  assert.equal(byName(checks, 'desktop learning').status, 'warn');
  assert.match(byName(checks, 'desktop learning').detail, /no completed app model request/);
});
