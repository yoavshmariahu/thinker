import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The launcher beside a stand-in installer, so nothing is downloaded or installed.
const launcher = (installer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-npx-'));
  fs.copyFileSync(path.join(ROOT, 'npm/install.mjs'), path.join(dir, 'install.mjs'));
  if (installer != null) fs.writeFileSync(path.join(dir, 'install.sh'), installer);
  return path.join(dir, 'install.mjs');
};

test('the npx launcher runs the installer it carries with its arguments', () => {
  const r = spawnSync('node', [launcher('printf "%s\\n" "$@"\n'), '--clients', 'claude codex', '--no-learn'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), ['--clients', 'claude codex', '--no-learn']);
});

test('the npx launcher exits with the installer\'s status', () => {
  assert.equal(spawnSync('node', [launcher('exit 2\n')], { encoding: 'utf8' }).status, 2);
});

test('the npx launcher says so when the package has no installer', () => {
  const r = spawnSync('node', [launcher(null)], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /installer is missing/);
});

test('pack.sh builds the npm package with the installer at the release version', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-npx-dist-'));
  execFileSync('bash', ['scripts/pack.sh'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, THINKER_DIST_DIR: dist } });
  const pkg = JSON.parse(fs.readFileSync(path.join(dist, 'npm/package.json'), 'utf8'));
  assert.equal(pkg.name, '@zerotime/thinker');
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.deepEqual(fs.readFileSync(path.join(dist, 'npm/install.sh')), fs.readFileSync(path.join(dist, 'install.sh')));
  // npm 11 drops a bin written as ./install.mjs when it publishes, and npx then has nothing to run
  for (const f of Object.values(pkg.bin)) assert.ok(!f.startsWith('./'), f);
  for (const f of Object.values(pkg.bin).concat(pkg.files)) assert.ok(fs.existsSync(path.join(dist, 'npm', f)), f);
});
