import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src/cli.js');

// A machine of its own: HOME, thinker's home and a ranking model that is "there" (doctor only
// checks the files), so --fix downloads nothing.
function machine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo'), models = path.join(dir, 'models');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const model = path.join(models, 'Xenova', 'ms-marco-MiniLM-L-6-v2');
  fs.mkdirSync(path.join(model, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(model, 'onnx', 'model.onnx'), '');
  fs.writeFileSync(path.join(model, 'tokenizer.json'), '{}');
  execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(home, '.thinker'), CODEX_HOME: path.join(home, '.codex'), THINKER_MODELS_DIR: models, THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { env, cwd: repo, encoding: 'utf8', timeout: 120_000 });
  return { home, repo, run };
}
const byName = (checks, name) => checks.find(c => c.name === name);

test('doctor finds wiring of a thinker copy that is gone, and --fix rewires it to this one', t => {
  const { home, repo, run } = machine(t);
  const setup = run('setup', '--no-build', '--yes', '--no-ui', '--no-behaviors', '--clients', 'claude', '--no-git-hook');
  assert.equal(setup.status, 0, setup.stderr);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').split(CLI).join('/gone/thinker/src/cli.js'));

  const before = run('doctor', '--json');
  assert.equal(before.status, 1);
  const wiring = byName(JSON.parse(before.stdout), 'wiring');
  assert.equal(wiring.status, 'fail');
  assert.match(wiring.detail, /gone/);
  assert.equal(wiring.fixable, true);

  const fixed = run('doctor', '--fix', '--json');
  const checks = JSON.parse(fixed.stdout);
  assert.match(fixed.stderr, /fixing wiring/);
  assert.deepEqual(checks.filter(c => c.status === 'fail'), []);
  assert.equal(byName(checks, 'agent claude').status, 'ok');
  assert.match(byName(checks, 'MCP server').detail, /orient/);
  const text = fs.readFileSync(settings, 'utf8');
  assert.ok(!text.includes('/gone/'));
  assert.ok(text.includes(CLI));
  assert.equal(fixed.status, 0);
});

test('doctor says a repository is not set up, without failing on it', t => {
  const { repo, run } = machine(t);
  const r = run('doctor', '--json');
  const repoCheck = byName(JSON.parse(r.stdout), 'repository');
  assert.equal(repoCheck.status, 'warn');
  assert.match(repoCheck.detail, /thinker setup/);
  assert.ok(!fs.existsSync(path.join(repo, '.thinker')));
});
