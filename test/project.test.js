import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_FILE, validateProject, readProject, writeProject, projectFromFlags, includesPath, projectRecordKey } from '../src/project.js';
import { chooseProject } from '../src/setup/project.js';
import { discoverAreas, planAreas } from '../src/topology.js';
import { estimateCacheBuild } from '../src/setup/estimate.js';
import { stepBuildCache } from '../src/setup/steps.js';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { minedPrs } from '../src/prs.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = (repo, args, env = {}) => execFileSync(process.execPath, [CLI, ...args, '--repo', repo], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_AST: 'off', THINKER_QUIET: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
});
function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-project-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q');
  for (const dir of ['apps/web', 'apps/web-old', 'packages/ui', 'services/api/auth', 'space dir']) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(path.join(repo, dir, 'core.js'), 'export function run() {\n  return 1;\n}\n');
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  return repo;
}
const project = directories => ({ version: 1, name: 'Checkout', directories });

test('project files normalize and deduplicate directories, rejecting missing paths and escapes', t => {
  const repo = fixture(t);
  assert.deepEqual(validateProject(repo, project(['./apps/web/', 'apps/web', 'apps/web/nested/..', 'packages/ui'])).directories, ['apps/web', 'packages/ui']);
  assert.deepEqual(validateProject(repo, project(['.', 'apps/web'])).directories, ['.']);
  for (const directories of [[], [''], ['missing'], ['apps/web/core.js'], ['../'], ['/tmp']]) {
    assert.throws(() => validateProject(repo, project(directories)));
  }
  fs.symlinkSync(os.tmpdir(), path.join(repo, 'outside'));
  assert.throws(() => validateProject(repo, project(['outside'])), /symlink/);
  assert.throws(() => validateProject(repo, { ...project(['apps']), version: 2 }), /version/);
  assert.equal(includesPath(['apps/web'], 'apps/web-old/core.js'), false);
  assert.equal(includesPath(['apps/web'], 'apps/web/core.js'), true);
});

test('CLI creates and shows a reusable project without initializing a cache or overwriting a file', t => {
  const repo = fixture(t);
  cli(repo, ['project', 'init', 'apps/web', 'space dir', '--name', 'My project']);
  assert.deepEqual(JSON.parse(cli(repo, ['project'])), { version: 1, name: 'My project', directories: ['apps/web', 'space dir'] });
  assert.equal(fs.existsSync(path.join(repo, '.thinker')), false);
  assert.throws(() => cli(repo, ['project', 'init', 'packages/ui']));
  assert.deepEqual(readProject(repo).directories, ['apps/web', 'space dir']);
});

test('default and explicit projects scope previews while full-repo restores all areas', t => {
  const repo = fixture(t);
  writeProject(repo, project(['apps/web']));
  const preview = cli(repo, ['seed', '--dry']);
  assert.match(preview, /apps\/web\/core.js/);
  assert.doesNotMatch(preview, /web-old|packages\/ui|services\/api/);
  assert.match(cli(repo, ['seed', '--dry', '--full-repo']), /packages\/ui/);
  writeProject(repo, project(['packages/ui']), 'ui.project.json');
  const alternate = cli(repo, ['seed', '--dry', '--project', 'ui.project.json']);
  assert.match(alternate, /packages\/ui/);
  assert.doesNotMatch(alternate, /apps\/web/);
  assert.throws(() => cli(repo, ['seed', '--dry', '--project', 'absent.json']));
  assert.throws(() => projectFromFlags(repo, { project: true }));
  assert.throws(() => projectFromFlags(repo, { 'full-repo': true, project: 'ui.project.json' }));
  writeProject(repo, project(['.']), PROJECT_FILE, { overwrite: true });
  assert.match(cli(repo, ['seed', '--dry']), /packages\/ui/);
  fs.writeFileSync(path.join(repo, PROJECT_FILE), 'broken JSON');
  assert.throws(() => cli(repo, ['seed', '--dry']));
  assert.match(cli(repo, ['seed', '--dry', '--full-repo']), /apps\/web/);
});

test('discovery keeps deep selections inside their roots and estimates only selected files', t => {
  const repo = fixture(t);
  for (let i = 0; i < 95; i++) {
    const file = path.join(repo, 'services/api/auth', i < 50 ? 'tokens' : 'sessions', `f${i}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'export const x = 1;\n');
  }
  git(repo, 'add', '.');
  const directories = ['services/api/auth'];
  const areas = discoverAreas(repo, { limit: 12, directories });
  assert.ok(areas.length >= 2);
  assert.ok(areas.every(a => includesPath(directories, a.dir)));
  assert.equal(discoverAreas(repo, { limit: 1, directories }).length, 1);
  assert.deepEqual(discoverAreas(repo, { limit: 0, directories }), []);
  const estimates = estimateCacheBuild(repo, { agent: 'claude', directories: ['apps/web'], noPrs: true });
  assert.equal(estimates.fileCount, 1);
  assert.equal(estimates.candidateAreasCount, 1);
  assert.equal(estimates.tokenEstimate, 400_000);
});

test('discovery treats directory names literally and can explore an index-only package', t => {
  const repo = fixture(t);
  for (const dir of ['packages/[ui]', 'packages/u']) {
    fs.mkdirSync(path.join(repo, dir));
    fs.writeFileSync(path.join(repo, dir, 'index.js'), 'export function run() { return 1; }');
  }
  git(repo, 'add', '.');
  assert.deepEqual(discoverAreas(repo, { directories: ['packages/[ui]'] }).map(a => a.dir), ['packages/[ui]/index.js']);
});

test('onboarding offers the two choices, retries invalid directories, saves and reuses the selection', async t => {
  const repo = fixture(t);
  const lines = [], answers = ['Checkout', 'missing', 'Checkout', 'apps/web, packages/ui'];
  let closed = false;
  const selected = await chooseProject({ repo, interactive: true, out: s => lines.push(s),
    selectFn: async options => {
      assert.deepEqual(options.items.map(x => x.label), ['Full repo', 'Specify project directories']);
      return options.items[1];
    }, readlineFn: () => ({ question: async () => answers.shift(), close: () => { closed = true; } }),
  });
  assert.equal(closed, true);
  assert.ok(lines.some(line => /does not exist/.test(line)));
  assert.deepEqual(selected.directories, ['apps/web', 'packages/ui']);
  assert.deepEqual(readProject(repo), selected);
  assert.deepEqual(await chooseProject({ repo, interactive: false, out: () => {}, selectFn: () => { throw new Error('must not prompt'); } }), selected);
  assert.deepEqual(await chooseProject({ repo, interactive: true, flags: { yes: true }, out: () => {}, selectFn: () => { throw new Error('must not prompt'); } }), selected);
  assert.equal(await chooseProject({ repo, interactive: true, out: () => {}, selectFn: async opts => opts.items[0] }), null);
  assert.deepEqual(readProject(repo).directories, ['.'], 'switching to full repo persists for later builds');
});

test('setup threads the selection into both build stages and retrieval still reads outside it', async t => {
  const repo = fixture(t), store = new Store(repo).init();
  const directories = ['apps/web'];
  writeProject(repo, project(directories));
  const note = createNote(store, { kind: 'rule', title: 'UI rule outside the project', body: 'packages/ui/core.js:run returns one.', deps: [{ path: 'packages/ui/core.js', symbol: 'run' }] }).note;
  assert.ok(note);
  assert.match(cli(repo, ['show', note.id]), /UI rule outside the project/);
  const estimates = estimateCacheBuild(repo, { agent: 'claude', directories });
  estimates.canMine = estimates.canSeed = true;
  let explored, mined;
  await stepBuildCache({ repo, store, directories, estimates, noPhrase: true, agent: 'claude', out: () => {},
    seedFn: async options => { explored = options; return { ok: 1, total: 1, saved: 0 }; },
    minePrsFn: async (slug, options) => { mined = options; return { saved: 0, processed: 1 }; },
    proposeFn: async () => ({ proposals: [], sources: 0 }),
  });
  assert.deepEqual(explored.directories, directories);
  assert.deepEqual(mined.directories, directories);
});

test('project mining skips unrelated changes without hiding them from later full-repo builds', t => {
  const repo = fixture(t);
  for (const dir of ['apps/web', 'packages/ui']) {
    fs.appendFileSync(path.join(repo, dir, 'core.js'), '\nexport function fix() {\n  return 2;\n}\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', `fix regression in ${dir}`);
  }
  const uiHash = git(repo, 'rev-parse', 'HEAD').slice(0, 8);
  const webHash = git(repo, 'rev-parse', 'HEAD~1').slice(0, 8);
  const model = path.join(repo, 'fake-model.cjs');
  const calls = path.join(repo, 'calls.txt');
  fs.writeFileSync(model, `process.stdin.resume(); process.stdin.on('end', () => { require('fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n'); console.log('{"notes":[]}'); });`);
  const env = { THINKER_LLM_CMD: `${process.execPath} "${model}"`, THINKER_LLM: '', ANTHROPIC_API_KEY: '' };
  writeProject(repo, project(['apps/web']));
  cli(repo, ['mine-prs', '--git', '--fixes'], env);
  const store = new Store(repo);
  assert.equal(minedPrs(store, 'local').mined.has(webHash), true);
  assert.equal(minedPrs(store, 'local').mined.has(uiHash), false);
  const before = fs.readFileSync(calls, 'utf8');
  cli(repo, ['mine-prs', '--git', '--fixes'], env);
  assert.equal(fs.readFileSync(calls, 'utf8'), before, 'the same project does not mine a change twice');
  cli(repo, ['mine-prs', '--git', '--fixes', '--full-repo'], env);
  assert.equal(minedPrs(store, 'local').mined.has(uiHash), true);
  assert.notEqual(fs.readFileSync(calls, 'utf8'), before);
  assert.equal(projectRecordKey('local', ['apps/web', 'packages/ui']), projectRecordKey('local', ['packages/ui', 'apps/web']));
});

test('GitHub project scans keep unrelated and deferred PRs available to another project', t => {
  const repo = fixture(t);
  const bins = path.join(repo, 'bin'); fs.mkdirSync(bins);
  const prs = [
    { number: 3, title: 'fix web regression', files: [{ path: 'apps/web/core.js' }], additions: 4, mergedAt: '2026-09-03T12:00:00Z' },
    { number: 2, title: 'fix unrelated regression', files: [{ path: 'apps/web-old/core.js' }], additions: 4, mergedAt: '2026-09-02T12:00:00Z' },
    { number: 1, title: 'fix web issue', files: [{ path: 'apps/web/core.js' }], additions: 4, mergedAt: '2026-09-01T12:00:00Z' },
  ];
  fs.writeFileSync(path.join(bins, 'gh'), `#!/usr/bin/env node\nconst args = process.argv.slice(2); console.log(args[0] === 'pr' && args[1] === 'list' ? ${JSON.stringify(JSON.stringify(prs))} : args[0] === 'api' ? '[]' : 'diff');\n`, { mode: 0o755 });
  const model = path.join(repo, 'fake-model.cjs');
  fs.writeFileSync(model, `process.stdin.resume(); process.stdin.on('end', () => console.log('{"notes":[]}'));`);
  const env = { PATH: `${bins}${path.delimiter}${process.env.PATH}`, THINKER_LLM_CMD: `${process.execPath} "${model}"`, THINKER_LLM: '', ANTHROPIC_API_KEY: '' };
  writeProject(repo, project(['apps/web']));
  cli(repo, ['mine-prs', 'owner/repo', '--limit', '1'], env);
  const store = new Store(repo), scoped = minedPrs(store, projectRecordKey('owner/repo', ['apps/web']));
  assert.deepEqual([...minedPrs(store, 'owner/repo').mined], [3]);
  assert.equal(scoped.mined.has(2), true, 'unrelated PR only advances this project scan');
  assert.equal(scoped.mined.has(1), false, 'deferred PR remains eligible');
  writeProject(repo, project(['apps/web-old']), PROJECT_FILE, { overwrite: true });
  cli(repo, ['mine-prs', 'owner/repo', '--limit', '1'], env);
  assert.deepEqual([...minedPrs(store, 'owner/repo').mined], [2, 3]);
  cli(repo, ['mine-prs', 'owner/repo', '--full-repo'], env);
  assert.deepEqual([...minedPrs(store, 'owner/repo').mined], [1, 2, 3]);
});

test('adaptive planning is shared by CLI preview, estimates and setup, with explicit caps', async t => {
  const repo = fixture(t);
  for (let i = 0; i < 15; i++) {
    const dir = path.join(repo, `packages/large${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'core.js'), '// source\n'.repeat(9000));
  }
  git(repo, 'add', '.');
  writeProject(repo, project(['packages']));
  const directories = ['packages'];
  const plan = planAreas(repo, { directories });
  assert.ok(plan.areas.length > 12);
  const estimates = estimateCacheBuild(repo, { directories, agent: 'claude', noPrs: true });
  assert.equal(estimates.candidateAreasCount, plan.areas.length);
  assert.equal(estimates.tokenEstimate, plan.areas.length * 400_000);
  const preview = cli(repo, ['seed', '--dry']);
  for (const area of plan.areas) for (const file of area.files) assert.ok(preview.includes(JSON.stringify(file)));
  // Exercise real seed dispatch with a local agent double; an empty trace makes
  // distillation a no-op, so this checks session boundaries without model calls.
  const bin = path.join(repo, 'bin'), captured = path.join(repo, 'prompts.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nlet prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => { require('fs').appendFileSync(${JSON.stringify(captured)}, JSON.stringify(prompt) + '\\n'); });\n`, { mode: 0o755 });
  cli(repo, ['seed', '--agent', 'codex', '--yes'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const prompts = fs.readFileSync(captured, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(prompts.length, plan.areas.length, 'actual seed runs every planned session');
  for (const [i, prompt] of prompts.entries()) {
    const inventory = prompt.split('Source files assigned to this session:\n')[1].split('\nFocus on these files;')[0];
    assert.deepEqual(inventory.split('\n').map(JSON.parse), plan.areas[i].files);
  }
  const limited = estimateCacheBuild(repo, { directories, areas: 2, agent: 'claude', noPrs: true });
  assert.equal(limited.tokenEstimate, 800_000);
  assert.equal(limited.omittedAreas.length, plan.areas.length - 2);
  assert.match(cli(repo, ['seed', '--dry', '--areas', '2']), /Exploring 2 of \d+ areas.*omitted:/);
  assert.match(cli(repo, ['seed', '--areas', '0']), /Exploration skipped/);
  for (const value of ['invalid', '1.5', '-1']) assert.throws(() => cli(repo, ['seed', '--dry', '--areas', value]));
  const output = [];
  let options;
  await stepBuildCache({ repo, store: new Store(repo).init(), directories, estimates, noPrs: true,
    noPhrase: true, agent: 'claude', out: line => output.push(line),
    seedFn: async opts => { options = opts; return { ok: plan.areas.length, total: plan.areas.length, saved: 0 }; },
    proposeFn: async () => ({ proposals: [], sources: 0 }),
  });
  assert.equal(options.areas, undefined, 'setup does not insert a default cap');
  assert.equal(discoverAreas(repo, { directories: options.directories, limit: options.areas }).length, estimates.candidateAreasCount);
  assert.ok(output.some(line => line.includes(`${plan.areas.length} sessions`)));
});
