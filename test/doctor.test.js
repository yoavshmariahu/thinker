import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { desktopLearningCheck } from '../src/commands/doctor.js';
import { enqueueJob, runSessionWork, RUN_EVERY_MS } from '../src/session-work.js';
import { queueDir, markBuild, UNCLAIMED_MS, CLAIMED_MS } from '../src/session-llm.js';

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
  return { home, repo, run, env };
}
const byName = (checks, name) => checks.find(c => c.name === name);

test('doctor finds wiring of a thinker copy that is gone, and --fix rewires it to this one', t => {
  const { home, repo, run } = machine(t);
  const setup = run('setup', '--no-build', '--yes', '--no-ui', '--clients', 'claude', '--no-git-hook');
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

test('doctor says a repository has no cache yet, as a fact and not a failure, and creates none', t => {
  const { repo, run } = machine(t);
  const r = run('doctor', '--json');
  const repoCheck = byName(JSON.parse(r.stdout), 'repository');
  assert.equal(repoCheck.status, 'ok');
  assert.match(repoCheck.detail, /no cache in .* yet.*thinker ui/);
  assert.ok(!fs.existsSync(path.join(repo, '.thinker')));
});

test('desktop doctor uses the app session even when no configured CLI provider can run', t => {
  const { run, env } = machine(t);
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  env.THINKER_NO_LEARN = '0';
  env.THINKER_LLM = 'no-such-provider'; // would fail if doctor tried the CLI/API probe
  const r = run('doctor', '--json');
  const checks = JSON.parse(r.stdout);
  assert.equal(byName(checks, 'model').status, 'ok');
  assert.match(byName(checks, 'model').detail, /Claude Desktop.*no CLI login/);
  assert.equal(byName(checks, 'desktop learning').status, 'warn');
  assert.match(byName(checks, 'desktop learning').detail, /no completed app model request/);
});

test('desktop doctor distinguishes waiting, failed retries, and a proven queue response', t => {
  const { repo } = machine(t), store = new Store(repo).init(), now = Date.now();
  const dir = queueDir(store); fs.mkdirSync(dir, { recursive: true });
  enqueueJob(store, 'distill-s1', ['distill', 'fixture']);
  let r = desktopLearningCheck(store, { now: now + RUN_EVERY_MS + 1000 });
  assert.equal(r.status, 'warn'); assert.match(r.detail, /beyond the normal/);
  runSessionWork(store, { cli: '/unused', out: () => {}, now, spawnFn: () => ({ status: 1 }) });
  r = desktopLearningCheck(store, { now });
  assert.equal(r.status, 'warn'); assert.match(r.detail, /failed job.*retained.*exited with 1.*next attempt/);
  runSessionWork(store, { cli: '/unused', out: () => {}, now: now + RUN_EVERY_MS, spawnFn: () => ({ status: 0 }) });
  r = desktopLearningCheck(store);
  assert.equal(r.status, 'warn'); // empty queue alone is not proof of successful handoff
  fs.writeFileSync(path.join(dir, 'last-answer.json'), JSON.stringify({ at: new Date(now).toISOString() }));
  r = desktopLearningCheck(store);
  assert.equal(r.status, 'ok'); assert.match(r.detail, /last app answer/);
});

test('desktop doctor detects unanswered and abandoned requests without taking or modifying them', t => {
  const { repo } = machine(t), store = new Store(repo).init(), dir = queueDir(store), now = Date.now();
  markBuild(dir, process.pid);
  const request = path.join(dir, 'example.req.json'); fs.writeFileSync(request, '{}');
  assert.match(desktopLearningCheck(store).detail, /waiting for an app subagent/);
  const old = new Date(now - UNCLAIMED_MS - 1000); fs.utimesSync(request, old, old);
  assert.equal(desktopLearningCheck(store, { now }).status, 'fail');
  const claim = path.join(dir, 'example.claimed.json'); fs.renameSync(request, claim);
  const claimed = new Date(now - CLAIMED_MS - 1000); fs.utimesSync(claim, claimed, claimed);
  assert.equal(desktopLearningCheck(store, { now }).status, 'fail');
  fs.utimesSync(claim, new Date(now), new Date(now));
  markBuild(dir, 2 ** 22 + 12345);
  assert.match(desktopLearningCheck(store, { now }).detail, /worker stopped/);
  assert.equal(fs.readFileSync(claim, 'utf8'), '{}');
});
