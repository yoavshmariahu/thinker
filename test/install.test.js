import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '../install.sh');
// Only the add_to_path function, so nothing is downloaded or installed.
const fn = fs.readFileSync(INSTALL, 'utf8').match(/^add_to_path\(\) \{[\s\S]*?^\}$/m)[0];

const addToPath = (shell, home, dir = '/opt/thinker/bin') => execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\nadd_to_path "$1"`, 'add_to_path', dir], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, SHELL: `/bin/${shell}` },
});

const rcFor = { zsh: '.zshrc', bash: process.platform === 'darwin' ? '.bash_profile' : '.bashrc', fish: '.config/fish/conf.d/thinker.fish' };
// bash's files are written whatever the login shell: agents may run their commands in bash
const bashFiles = process.platform === 'darwin' ? ['.bash_profile', '.bashrc'] : ['.bashrc'];

for (const [shell, rc] of Object.entries(rcFor)) {
  test(`installer puts thinker on PATH once for ${shell}, and for bash`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `thinker-path-${shell}-`));
    fs.writeFileSync(path.join(home, '.zshrc'), '# existing\n');
    const file = path.join(home, rc);
    assert.equal(addToPath(shell, home), file);
    assert.equal(addToPath(shell, home), file);
    for (const f of new Set([rc, ...bashFiles])) {
      const text = fs.readFileSync(path.join(home, f), 'utf8');
      assert.equal(text.split('/opt/thinker/bin').length - 1, 1, f);
      assert.match(text, f.endsWith('.fish') ? /fish_add_path "\/opt\/thinker\/bin"/ : /export PATH="\/opt\/thinker\/bin:\$PATH"/);
    }
    if (shell === 'zsh') assert.match(fs.readFileSync(file, 'utf8'), /^# existing\n/);
  });
}

test('installer reports no file for an unknown shell, and still puts thinker on PATH for bash', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-tcsh-'));
  assert.equal(addToPath('tcsh', home), '');
  assert.deepEqual(fs.readdirSync(home).sort(), [...bashFiles].sort());
});

test('on macOS an existing .profile gets the line, and no .bash_profile is made to hide it', { skip: process.platform !== 'darwin' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-profile-'));
  fs.writeFileSync(path.join(home, '.profile'), '# mine\n');
  addToPath('zsh', home);
  assert.ok(!fs.existsSync(path.join(home, '.bash_profile')));
  assert.match(fs.readFileSync(path.join(home, '.profile'), 'utf8'), /^# mine\n[\s\S]*\/opt\/thinker\/bin/);
});

test('a bash agent finds thinker on a zsh machine', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-agent-')));
  const bin = path.join(home, '.thinker/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'thinker'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  addToPath('zsh', home, bin);
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  assert.equal(execFileSync('bash', ['-ic', 'thinker'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'ok', 'interactive bash: .bashrc');
  assert.equal(execFileSync('bash', ['-lc', 'thinker'], { encoding: 'utf8', env }).trim(), 'ok', 'login bash');
});

test('on Linux the installer writes an existing .profile, which a login bash reads past the .bashrc guard', { skip: process.platform === 'darwin' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-linux-'));
  fs.writeFileSync(path.join(home, '.profile'), '# mine\n');
  addToPath('bash', home);
  assert.match(fs.readFileSync(path.join(home, '.profile'), 'utf8'), /\/opt\/thinker\/bin/);
});

test('the zsh line makes thinker resolvable in a new shell', { skip: !fs.existsSync('/bin/zsh') }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-new-'));
  const bin = path.join(home, '.thinker/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'thinker'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  addToPath('zsh', home, bin);
  assert.equal(execFileSync('/bin/zsh', ['-c', 'source ~/.zshrc; thinker'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } }).trim(), 'ok');
});

// macOS ships bash 3.2, which in a UTF-8 locale reads "$label…" as the variable "label…" and, under
// set -u, dies with "unbound variable". A name that meets a non-ASCII character needs its braces.
test('no variable in the installer runs into a non-ASCII character', () => {
  const hits = fs.readFileSync(INSTALL, 'utf8').split('\n')
    .map((line, i) => [i + 1, line]).filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
  assert.deepEqual(hits, []);
});

// The installer's `spin` runs its command in this shell when there is no terminal, which is how the piped
// install runs, so a bare `cd` in `install_deps` left the installer sitting in ~/.thinker/app -- a directory the
// script replaces and an update deletes. Everything after it then ran with no working directory.
test('install_deps keeps its cd inside a subshell, so the installer never moves', () => {
  const body = fs.readFileSync(INSTALL, 'utf8').match(/^\s*install_deps\(\).*$/m)[0];
  assert.match(body, /\(\s*cd "\$home\/app"/, body);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-'));
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  const probe = execFileSync('bash', ['-c', `set -eu\nhome=$1\n${body.trim().replace('npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent', 'true')}\ninstall_deps\npwd`, 'probe', home], { encoding: 'utf8' });
  assert.equal(probe.trim(), process.cwd(), 'the shell is where it started, not in $home/app');
});

// A thinker command must run from a directory that no longer exists: a worktree removed under it, a build
// directory swept, or the installer's shell while an update replaces what it is standing in. `process.cwd()`
// throws ENOENT (uv_cwd) at import time there, so every invocation died with a stack trace.
test('a command still runs when the working directory has been deleted under it', () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-gone-'));
  const out = execFileSync('sh', ['-c', `cd "$1" && rmdir "$1" && exec "$2" "$3" version`, 'probe', gone, process.execPath, cli], {
    encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1' },
  });
  assert.match(out, /^thinker \d+\.\d+\.\d+/, out);
});
