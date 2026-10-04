import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The release archive is the public tool: it leaves the team server out and must still run.
test('the release archive loads without the server: no src/server, no thinker-server bin, and the CLI starts from it', t => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-dist-'));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-app-'));
  t.after(() => { fs.rmSync(dist, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true }); });
  execFileSync('bash', [path.join(root, 'scripts', 'pack.sh')], { cwd: root, env: { ...process.env, THINKER_DIST_DIR: dist }, stdio: 'ignore' });
  const listing = execFileSync('tar', ['-tzf', path.join(dist, 'thinker.tgz')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(listing.includes('src/cli.js') && listing.includes('src/review.js') && listing.includes('src/behavior.js') && listing.includes('src/sync-wire.js'));
  assert.ok(!listing.some(f => f.startsWith('src/server')), 'the server is not in the archive');
  assert.ok(!listing.some(f => f.endsWith('.test.js')), 'the tests are not in the archive');
  execFileSync('tar', ['-xzf', path.join(dist, 'thinker.tgz'), '-C', app]);
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['thinker']);
  assert.ok(!fs.readFileSync(path.join(app, 'README.md'), 'utf8').includes('thinker-server'), 'the public README does not offer the server');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules')); // the archive's dependencies, as `npm ci` would put them
  const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_AST: 'off' };
  const help = spawnSync('node', [path.join(app, 'src', 'cli.js'), 'help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /review \[paths…\]/); assert.match(help.stdout, /system add/);
  assert.ok(!/\n  sync /.test(help.stdout), 'the help lists no sync commands');
  // a review runs from the archive (dry: no model), against this repository
  const dry = spawnSync('node', [path.join(app, 'src', 'cli.js'), 'review', '--dry', '--kinds', 'behavior', '--json', '--repo', root, 'src/review.js'], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).kinds, ['behavior']);
});
