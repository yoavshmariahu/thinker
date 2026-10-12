#!/usr/bin/env node
// npx @zerotimedev/thinker: runs the installer this package carries (install.sh), with the
// arguments passed through. Nothing of thinker runs from
// the npx cache, which npm may clear: the installer puts the tool in THINKER_HOME (~/.thinker),
// where the hooks and `thinker update` find it. scripts/pack.sh copies install.sh in beside this
// file and sets the version; the package is not meant to be installed as a dependency.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.sh');
const die = (msg) => { process.stderr.write(`thinker: ${msg}\n`); process.exit(1); };
if (!fs.existsSync(script)) die(`the installer is missing from this package (${script})`);

const r = spawnSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error?.code === 'ENOENT') {
  die(process.platform === 'win32'
    ? 'the installer is a bash script: run this from WSL or Git Bash'
    : 'bash is required to run the installer');
}
if (r.error) die(r.error.message);
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
