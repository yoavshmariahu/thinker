import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function machine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(home, '.thinker'), CODEX_HOME: path.join(home, '.codex'), THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  const snapshot = () => [...walk(home), ...walk(repo)].sort().join('\n');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: repo, encoding: 'utf8', timeout: 60_000 });
  return { home, repo, run, snapshot };
}
function walk(d) { let out = []; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.name === '.git') continue; out.push(f); if (e.isDirectory()) out = out.concat(walk(f)); } return out; }

test('--help prints the usage and runs nothing, on setup as on any command', t => {
  const { run, snapshot } = machine(t);
  const before = snapshot();
  for (const args of [['setup', '--help'], ['setup', '--build', '--help'], ['--help'], ['-h'], ['help'], ['doctor', '--help'], ['list', '--help']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /^thinker — knowledge cache for coding agents/, args.join(' '));
    assert.match(r.stdout, /\n  setup \[--clients/);
  }
  assert.equal(snapshot(), before, 'no file was written in the home or the repository');
});

test('a flag setup does not take is refused before anything runs; the flags it takes pass', t => {
  const { run, snapshot } = machine(t);
  const before = snapshot();
  const r = run('setup', '--bogus', '--no-build', '--yes');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /setup does not take --bogus/);
  assert.match(r.stderr, /nothing was run/);
  assert.equal(r.stdout, '');
  assert.equal(snapshot(), before);
  for (const [c, flag] of [['connect', '--no-such'], ['uninstall', '--purge-all'], ['doctor', '--fixx'], ['rewire', '--everywhere']]) {
    const x = run(c, flag);
    assert.equal(x.status, 2, `${c} ${flag}`);
    assert.match(x.stderr, new RegExp(`${c} does not take ${flag}`));
  }
  // every flag the setup help lists, and the ones the handler reads without listing, pass the check
  const ok = run('setup', '--no-build', '--yes', '--no-ui', '--clients', 'claude', '--no-hooks', '--no-mcp', '--no-git-hook', '--no-trust', '--no-docs', '--no-benchmark', '--no-prs', '--repo', '.');
  assert.notEqual(ok.status, 2, ok.stderr);
  assert.doesNotMatch(ok.stderr, /does not take/);
});
