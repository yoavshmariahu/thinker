// Real temporary git remotes and pack.sh; gh/npm/curl are local fakes. Never contact a registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { release, parseArgs } from '../scripts/release.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const env = { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off', GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'core.hooksPath', '/dev/null'); git(repo, 'config', 'commit.gpgsign', 'false');
  git(dir, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote);
  for (const d of ['scripts', 'src', 'npm']) fs.mkdirSync(path.join(repo, d));
  fs.copyFileSync(path.join(ROOT, 'scripts/pack.sh'), path.join(repo, 'scripts/pack.sh'));
  for (const f of ['package.json', 'install.mjs', 'README.md']) fs.copyFileSync(path.join(ROOT, 'npm', f), path.join(repo, 'npm', f));
  const pkg = { name: 'thinker', version: '0.1.0', bin: { thinker: './src/cli.js', 'thinker-server': './src/server.js' } };
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
  for (const [f, s] of Object.entries({ 'src/cli.js': 'console.log("hello");', 'README.md': '# Thinker', 'LICENSE': 'MIT', 'install.sh': '#!/bin/sh\necho install\n' })) fs.writeFileSync(path.join(repo, f), s);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial'); git(repo, 'push', '-q', 'origin', 'main');
  const initial = git(repo, 'rev-parse', 'HEAD');
  // A caller on an old dirty checkout must never package these uncommitted bytes.
  fs.appendFileSync(path.join(repo, 'README.md'), '\nUSER EDIT\n');
  const state = { calls: [], pr: null, releases: {}, npm: new Set(), login: true, npmLatest: null, failPublish: false, failTests: false, failUpload: false, staleLatest: false, registryError: false };
  const ok = stdout => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout ?? ''), stderr: '' });
  const fail = stderr => ({ status: 1, stdout: '', stderr });
  const merge = () => {
    const oid = git(remote, 'rev-parse', 'refs/heads/release/v0.1.1');
    git(remote, 'update-ref', 'refs/heads/main', oid);
    state.pr = { ...state.pr, state: 'MERGED', mergeCommit: { oid } };
  };
  const run = (cmd, args, opts) => {
    state.calls.push({ cmd, args: [...args], env: opts.env });
    assert.equal(opts.env.THINKER_TEST, '1', `${cmd} inherits test isolation`);
    if (cmd === 'git' || cmd === 'tar' || cmd === 'bash') {
      const a = cmd === 'git' ? ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args] : args;
      return spawnSync(cmd, a, { ...opts, env: { ...opts.env, ...env }, encoding: 'utf8', stdio: 'pipe' });
    }
    if (cmd === 'npm') {
      if (args[0] === 'version') {
        for (const f of ['package.json', 'package-lock.json']) {
          const file = path.join(opts.cwd, f), p = JSON.parse(fs.readFileSync(file)); p.version = args[1];
          if (p.packages?.['']) p.packages[''].version = args[1]; fs.writeFileSync(file, JSON.stringify(p));
        }
        return ok();
      }
      if (args[0] === 'ci') return ok();
      if (args[0] === 'test') return state.failTests ? fail('tests failed') : ok();
      if (args[0] === 'whoami') return state.login ? ok('owner') : fail('E401 Unauthorized');
      if (args[0] === 'login') { state.login = true; return ok(); }
      if (args[0] === 'view') {
        if (state.registryError) return fail('E503 registry unavailable');
        const version = args[1].split('@')[2];
        return version ? state.npm.has(version) ? ok(JSON.stringify(version)) : fail('E404 version not found') : state.npmLatest ? ok(JSON.stringify(state.npmLatest)) : fail('E404 package not found');
      }
      if (args[0] === 'pack') {
        const p = JSON.parse(fs.readFileSync(path.join(args[1], 'package.json')));
        const destination = args[args.indexOf('--pack-destination') + 1], filename = `installer-${p.version}.tgz`;
        fs.writeFileSync(path.join(destination, filename), JSON.stringify(p));
        return ok([{ name: p.name, version: p.version, filename }]);
      }
      if (args[0] === 'publish') {
        assert.ok(state.releases['v0.1.1'] && !state.releases['v0.1.1'].isDraft, 'GitHub is live before npm');
        if (state.failPublish) return fail('EOTP browser authentication required');
        const p = JSON.parse(fs.readFileSync(args[1])); state.npm.add(p.version);
        if (args[args.indexOf('--tag') + 1] === 'latest') state.npmLatest = p.version;
        return ok();
      }
    }
    if (cmd === 'gh') {
      if (args[0] === 'auth') return ok();
      if (args[0] === 'repo') return ok('owner/thinker');
      if (args[0] === 'pr') {
        if (args[1] === 'list') return ok(state.pr ? [state.pr] : []);
        if (args[1] === 'create') {
          if (state.failPrCreate) return fail('PR creation interrupted');
          state.pr = { state: 'OPEN', url: 'https://github.test/pr/1', baseRefName: 'main', headRefOid: git(remote, 'rev-parse', 'refs/heads/release/v0.1.1') };
          return ok(state.pr.url);
        }
        if (args[1] === 'view') return ok(state.pr);
      }
      if (args[0] === 'api') {
        const published = Object.entries(state.releases).find(([, r]) => !r.isDraft);
        return published ? ok({ tag_name: published[0] }) : fail('HTTP 404');
      }
      if (args[0] === 'release') {
        const tag = args[2], r = state.releases[tag];
        if (args[1] === 'view') return r ? ok({ isDraft: r.isDraft, assets: Object.keys(r.files) }) : fail('release not found');
        if (args[1] === 'create') { state.releases[tag] = { isDraft: true, files: {} }; return ok(); }
        if (args[1] === 'upload') {
          for (const a of args.slice(3)) if (path.isAbsolute(a)) r.files[path.basename(a)] = fs.readFileSync(a);
          return state.failUpload ? fail('interrupted upload') : ok();
        }
        if (args[1] === 'edit') { r.isDraft = false; return ok(); }
        if (args[1] === 'download') {
          const dest = args[args.indexOf('--dir') + 1];
          for (const [f, bytes] of Object.entries(r.files)) fs.writeFileSync(path.join(dest, f), bytes);
          return ok();
        }
      }
    }
    if (cmd === 'curl') return state.staleLatest ? ok({ version: '0.1.0', commit: initial }) : ok(state.releases['v0.1.1'].files['version.json'].toString());
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  const options = { repo, run, env, out: () => {}, interactive: false, sleep: async () => {} };
  const invoke = (opts = {}) => release({ version: '0.1.1' }, { ...options, ...opts });
  const assertUntouched = () => {
    assert.equal(git(repo, 'rev-parse', 'HEAD'), initial);
    assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /USER EDIT/);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
  };
  return { repo, remote, state, invoke, merge, assertUntouched, run, options };
}

test('release arguments accept exact stable versions and a resumable no-argument invocation', () => {
  assert.deepEqual(parseArgs(['v0.1.44', '--no-wait']), { version: '0.1.44', noWait: true });
  assert.deepEqual(parseArgs([]), { version: undefined, noWait: false });
  for (const s of ['patch', 'HEAD', '01.2.3', '0.1.2-beta', '--merge']) assert.throws(() => parseArgs([s]));
});

test('a manual release creates a version-only PR, waits for review, and resumes from its merge', async t => {
  const f = fixture(t);
  const pending = await f.invoke();
  assert.equal(pending.pending, true);
  assert.deepEqual(git(f.repo, 'diff', '--name-only', `origin/main...${f.state.pr.headRefOid}`).split('\n'), ['package-lock.json', 'package.json']);
  assert.equal(Object.keys(f.state.releases).length, 0);
  f.assertUntouched();
  f.merge();
  const done = await release({}, f.options);
  assert.equal(done.npm, true); assert.equal(f.state.npmLatest, '0.1.1');
  assert.equal(git(f.repo, 'rev-parse', 'v0.1.1^{commit}'), f.state.pr.mergeCommit.oid);
  const before = f.state.calls.filter(c => c.cmd === 'npm' && c.args[0] === 'publish').length;
  await f.invoke();
  assert.equal(f.state.calls.filter(c => c.cmd === 'npm' && c.args[0] === 'publish').length, before, 'rerun never republishes a version');
  assert.ok(!f.state.calls.some(c => c.cmd === 'gh' && c.args.includes('merge')), 'never auto-merges');
  f.assertUntouched();
});

test('interactive release renews npm login and continues after the user merges the PR', async t => {
  const f = fixture(t); f.state.login = false;
  let confirmations = 0;
  await f.invoke({ interactive: true, confirm: async () => { confirmations++; f.merge(); } });
  assert.equal(confirmations, 1);
  const login = f.state.calls.findIndex(c => c.cmd === 'npm' && c.args[0] === 'login');
  const tag = f.state.calls.findIndex(c => c.cmd === 'git' && c.args[0] === 'tag');
  assert.ok(login >= 0 && login < tag, 'login is renewed before tagging');
  f.assertUntouched();
});

test('failed npm publishing resumes the exact tag even when main has moved ahead', async t => {
  const f = fixture(t); await f.invoke(); f.merge(); f.state.failPublish = true;
  await assert.rejects(f.invoke(), /EOTP.*\nResume safely/s);
  assert.equal(f.state.releases['v0.1.1'].isDraft, false);
  const snapshot = f.state.releases['v0.1.1'].files['version.json'].toString();
  // Advance main after the tag, while leaving the caller on its old dirty checkout.
  const tagged = f.state.pr.mergeCommit.oid;
  const next = git(f.remote, 'commit-tree', `${tagged}^{tree}`, '-p', tagged, '-m', 'Later change');
  git(f.remote, 'update-ref', 'refs/heads/main', next);
  f.state.npmLatest = '0.1.2';
  f.state.failPublish = false;
  const done = await f.invoke();
  assert.equal(done.commit, tagged);
  assert.equal(f.state.npmLatest, '0.1.2', 'resuming an older version preserves npm latest');
  assert.equal(f.state.releases['v0.1.1'].files['version.json'].toString(), snapshot, 'public assets are not overwritten');
  assert.ok(f.state.npm.has('0.1.1'));
  f.assertUntouched();
});

test('a pushed branch without a PR is reused after interrupted PR creation', async t => {
  const f = fixture(t); f.state.failPrCreate = true;
  await assert.rejects(f.invoke(), /PR creation interrupted/);
  const head = git(f.remote, 'rev-parse', 'refs/heads/release/v0.1.1');
  f.state.failPrCreate = false;
  const result = await release({ version: '0.1.1', noWait: true }, { ...f.options, interactive: true, confirm: () => assert.fail('must not wait') });
  assert.equal(result.pending, true);
  assert.equal(f.state.pr.headRefOid, head);
  f.assertUntouched();
});

test('a partial draft upload is repaired on rerun before npm publication', async t => {
  const f = fixture(t); await f.invoke(); f.merge(); f.state.failUpload = true;
  await assert.rejects(f.invoke(), /interrupted upload/);
  assert.equal(f.state.releases['v0.1.1'].isDraft, true); assert.equal(f.state.npm.size, 0);
  f.state.failUpload = false;
  await f.invoke(); assert.equal(f.state.releases['v0.1.1'].isDraft, false);
  f.assertUntouched();
});

test('failed tests, registry errors, expired auth and stale download URLs stop before publishing', async t => {
  const f = fixture(t); f.state.failTests = true;
  await assert.rejects(f.invoke(), /tests failed/);
  assert.equal(f.state.pr, null); f.assertUntouched();
  f.state.failTests = false; await f.invoke(); f.merge();
  f.state.registryError = true;
  await assert.rejects(f.invoke(), /E503/);
  f.state.registryError = false; f.state.login = false;
  await assert.rejects(f.invoke(), /npm login is required/);
  assert.equal(Object.keys(f.state.releases).length, 0);
  f.state.login = true; f.state.staleLatest = true;
  await assert.rejects(f.invoke(), /public latest-release manifest/);
  assert.equal(f.state.npm.size, 0);
  f.state.staleLatest = false; await f.invoke();
  f.assertUntouched();
});
