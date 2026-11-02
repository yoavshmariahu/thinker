import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudHooks, mergeCloudHooks, blueprintStep, cloudRepoDir, writeDevinCloud, CLOUD_BLUEPRINT } from '../src/devin-cloud.js';

const repo = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cloud-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const read = (d, ...p) => JSON.parse(fs.readFileSync(path.join(d, '.devin', ...p), 'utf8'));

// The two rules the cloud box imposes: the hook runs where this machine's paths mean nothing, and the
// checkout it must serve is its own working directory, not one baked in here.
test('a cloud hook command carries no path from this machine and no --repo', () => {
  const h = cloudHooks();
  const commands = Object.values(h).flat().flatMap(g => g.hooks.map(x => x.command));
  assert.equal(commands.length, 4);
  for (const c of commands) {
    assert.match(c, /^thinker hook (prompt|tool|stop) --client devin/);
    assert.doesNotMatch(c, /--repo/, c);
    assert.doesNotMatch(c, /\//, `a path would not exist on the box: ${c}`);
    assert.doesNotMatch(c, /node /, c);
  }
  assert.deepEqual(Object.keys(h), ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  // the same four events the machine-wide Devin wiring uses, so the two doors cannot drift apart
  assert.deepEqual(Object.keys(cloudHooks({ learn: false })).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.match(cloudHooks({ learn: false }).Stop[0].hooks[0].command, /--no-distill/);
  assert.equal(cloudHooks({ late: false, learn: false }).PostToolUse, undefined);
});

test("another project's hooks in the same file are kept, and thinker's own are replaced", () => {
  const theirs = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'their-linter --check', timeout: 5 }] },
                       { hooks: [{ type: 'command', command: 'thinker hook prompt --client devin --record', timeout: 15 }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'their-guard', timeout: 5 }] }],
  };
  const merged = mergeCloudHooks(theirs, cloudHooks());
  const prompt = merged.UserPromptSubmit.map(g => g.hooks[0].command);
  assert.deepEqual(prompt, ['their-linter --check', 'thinker hook prompt --client devin --record'], 'one of ours, theirs first');
  assert.equal(merged.PreToolUse[0].hooks[0].command, 'their-guard', 'an event we do not use is untouched');
  // rerunning does not stack
  assert.equal(mergeCloudHooks(merged, cloudHooks()).UserPromptSubmit.length, 2);
});

test('the snapshot step installs thinker, and restores a cache only when one is named', () => {
  assert.match(blueprintStep(), /- name: thinker/);
  assert.match(blueprintStep(), /npx -y @zerotimedev\/thinker/);
  assert.doesNotMatch(blueprintStep(), /import/);
  const withCache = blueprintStep({ cacheUrl: 'https://example.com/c.tgz', repoDir: '~/repos/thinker' });
  assert.match(withCache, /cd ~\/repos\/thinker/);
  assert.match(withCache, /thinker import "https:\/\/example\.com\/c\.tgz"/);
  assert.equal(cloudRepoDir('https://github.com/acme/widget.git'), '~/repos/widget');
  assert.equal(cloudRepoDir('git@github.com:acme/widget.git'), '~/repos/widget');
  assert.equal(cloudRepoDir(''), '');
});

test('writing into a repository: both files, and a blueprint of someone else is never edited', t => {
  const d = repo(t);
  const first = writeDevinCloud(d, { origin: 'https://github.com/acme/widget.git' });
  assert.deepEqual(first.files, ['.devin/hooks.v1.json', '.devin/blueprint.yaml']);
  assert.equal(first.blueprint, 'written');
  assert.equal(first.snippet, '');
  assert.equal(read(d, 'hooks.v1.json').UserPromptSubmit[0].hooks[0].command, 'thinker hook prompt --client devin --record');
  assert.match(fs.readFileSync(path.join(d, '.devin', CLOUD_BLUEPRINT), 'utf8'), /^initialize:\n  - name: thinker/);

  // rerun with a cache url: our step is replaced, not duplicated
  const again = writeDevinCloud(d, { origin: 'https://github.com/acme/widget.git', cacheUrl: 'https://example.com/c.tgz' });
  const bp = fs.readFileSync(path.join(d, '.devin', CLOUD_BLUEPRINT), 'utf8');
  assert.equal(again.blueprint, 'updated');
  assert.equal(bp.match(/- name: thinker/g).length, 1);
  assert.match(bp, /thinker import/);

  // a blueprint we did not write stays exactly as it is, and the step comes back to be pasted
  const e = repo(t);
  const theirs = 'initialize:\n  - name: deps\n    run: |\n      make bootstrap\n';
  fs.mkdirSync(path.join(e, '.devin'), { recursive: true });
  fs.writeFileSync(path.join(e, '.devin', CLOUD_BLUEPRINT), theirs);
  const r = writeDevinCloud(e, {});
  assert.equal(fs.readFileSync(path.join(e, '.devin', CLOUD_BLUEPRINT), 'utf8'), theirs, 'untouched');
  assert.equal(r.blueprint, 'left alone');
  assert.match(r.snippet, /- name: thinker/);
  assert.deepEqual(r.files, ['.devin/hooks.v1.json'], 'only what we actually wrote is listed');
});
