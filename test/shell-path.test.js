import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureShellPath, pathFiles, addToPath } from '../src/shell-path.js';

// An install from before bash got thinker's PATH line gets it once, after the update, from the prompt hook;
// only where the installer had changed PATH already (not after --no-modify-path).
function machine({ zshrc } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-shell-path-')));
  const thinker = path.join(home, '.thinker'), bin = path.join(thinker, 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'thinker'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  if (zshrc !== undefined) fs.writeFileSync(path.join(home, '.zshrc'), zshrc);
  return { home, thinker, bin, opts: { home, shell: 'zsh', platform: 'darwin', env: {}, thinker } };
}
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

test('an upgraded zsh install gets the line for bash, once', () => {
  const { home, bin, opts } = machine();
  fs.writeFileSync(path.join(home, '.zshrc'), `# mine\n\n# thinker\nexport PATH="${bin}:$PATH"\n`);
  assert.deepEqual(ensureShellPath(opts), [path.join(home, '.bash_profile'), path.join(home, '.bashrc')]);
  assert.match(read(path.join(home, '.bashrc')), new RegExp(`export PATH="${bin}:\\$PATH"`));
  assert.equal(read(path.join(home, '.zshrc')).split(bin).length - 1, 1, 'the zsh line is not repeated');
  fs.rmSync(path.join(home, '.bashrc'));
  assert.equal(ensureShellPath(opts), null, 'once per machine: a line the person removed stays removed');
  assert.ok(!fs.existsSync(path.join(home, '.bashrc')));
});

test('a line the person wrote with $HOME counts as thinker on PATH', () => {
  const { home, opts } = machine({ zshrc: 'export PATH="$HOME/.thinker/bin:$PATH"\n' });
  assert.equal(ensureShellPath(opts).length, 2);
  assert.ok(read(path.join(home, '.bashrc')).includes('.thinker/bin'));
});

test('an install made with --no-modify-path is left alone', () => {
  const { home, opts } = machine({ zshrc: '# mine\n' });
  assert.deepEqual(ensureShellPath(opts), []);
  assert.deepEqual(fs.readdirSync(home).sort(), ['.thinker', '.zshrc']);
  assert.equal(read(path.join(home, '.zshrc')), '# mine\n');
});

test('the files: the login shell\'s first, bash\'s on Linux only .bashrc', () => {
  const home = '/h';
  assert.deepEqual(pathFiles('/h/.thinker/bin', { home, shell: 'zsh', platform: 'linux', env: {} }).map(f => f.rc), ['/h/.zshrc', '/h/.bashrc']);
  assert.deepEqual(pathFiles('/h/.thinker/bin', { home, shell: 'bash', platform: 'linux', env: {} }).map(f => f.rc), ['/h/.bashrc']);
});

test('on Linux an existing login file gets the line too: a distribution .bashrc returns early when not interactive', () => {
  const { home, bin } = machine();
  fs.writeFileSync(path.join(home, '.profile'), '# mine\n');
  fs.writeFileSync(path.join(home, '.bashrc'), 'case $- in\n    *i*) ;;\n      *) return;;\nesac\n');
  addToPath(bin, { home, shell: '', platform: 'linux', env: {} });
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  assert.equal(execFileSync('bash', ['-lc', 'thinker'], { encoding: 'utf8', env }).trim(), 'ok', 'login bash, as Codex runs commands');
  assert.equal(execFileSync('bash', ['-ic', 'thinker'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'ok', 'interactive bash');
});

test('a machine that ran the date-stamped version still gets a file the list gained (Linux .profile), and only that', () => {
  const { home, bin, thinker } = machine();
  const opts = { home, shell: '', platform: 'linux', env: {}, thinker };
  fs.writeFileSync(path.join(home, '.bashrc'), `# thinker\nexport PATH="${bin}:$PATH"\n`);
  fs.writeFileSync(path.join(home, '.profile'), '# mine\n');
  fs.mkdirSync(path.join(thinker, 'state'), { recursive: true });
  fs.writeFileSync(path.join(thinker, 'state', 'shell-path'), '2026-10-15T09:31:12.124Z\n');
  assert.deepEqual(ensureShellPath(opts), [path.join(home, '.profile')]);
  assert.equal(execFileSync('bash', ['-lc', 'thinker'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } }).trim(), 'ok');
  // seen now: taken out again, it stays out
  fs.writeFileSync(path.join(home, '.profile'), '# mine\n');
  assert.equal(ensureShellPath(opts), null);
  assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), '# mine\n');
});
