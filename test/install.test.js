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

for (const [shell, rc] of Object.entries(rcFor)) {
  test(`installer puts thinker on PATH once for ${shell}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `thinker-path-${shell}-`));
    fs.writeFileSync(path.join(home, '.zshrc'), '# existing\n');
    const file = path.join(home, rc);
    assert.equal(addToPath(shell, home), file);
    assert.equal(addToPath(shell, home), file);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split('/opt/thinker/bin').length - 1, 1);
    assert.match(text, shell === 'fish' ? /fish_add_path "\/opt\/thinker\/bin"/ : /export PATH="\/opt\/thinker\/bin:\$PATH"/);
    if (shell === 'zsh') assert.match(text, /^# existing\n/);
  });
}

test('installer leaves unknown shells alone and reports nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-tcsh-'));
  assert.equal(addToPath('tcsh', home), '');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('the zsh line makes thinker resolvable in a new shell', { skip: !fs.existsSync('/bin/zsh') }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-path-new-'));
  const bin = path.join(home, '.thinker/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'thinker'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  addToPath('zsh', home, bin);
  assert.equal(execFileSync('/bin/zsh', ['-c', 'source ~/.zshrc; thinker'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } }).trim(), 'ok');
});
