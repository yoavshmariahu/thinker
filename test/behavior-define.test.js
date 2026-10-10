import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { behaviorSessionPrompt } from '../src/setup/define.js';

// The prompt sets the repository up when it is not, reads the design documents first, builds the cache in
// the background (after the documents) when it is empty, and leaves both setup and build out once done.
test('behavior prompt: setup step only where the repository is not set up or not built', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-define-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const general = behaviorSessionPrompt(null);
  assert.match(general, /thinker setup --yes --no-build --no-behaviors/);
  assert.match(general, /thinker setup --build --yes --no-behaviors` as a background command/);
  assert.doesNotMatch(general, /\(\d+ now\)/);

  const store = new Store(repo); store.init();
  const empty = behaviorSessionPrompt(store);
  assert.doesNotMatch(empty, /--no-build/);
  assert.doesNotMatch(empty, /^0\./m);
  assert.match(empty, /1\. Start from the design documents[^\n]*thinker system docs[^\n]*Then, since the cache has no notes yet, start `thinker setup --build/);

  store.put({ id: 'a-note', kind: 'rule', title: 'A rule', body: 'Body.', deps: [] });
  const built = behaviorSessionPrompt(store);
  assert.doesNotMatch(built, /^0\./m);
  assert.match(built, /behaviors in force \(0 before this run\)/);
  assert.match(built, /thinker system docs/);
  assert.doesNotMatch(built, /setup --build/);
  assert.match(general, /0\. Set thinker up[^\n]*\n1\. Start from the design documents[^\n]*Then, if the cache has no notes yet, start/);
});

// After the interview the prompt offers a first review on an open pull request, without touching uncommitted work
// or posting anything.
test('behavior prompt: ends by offering thinker review on an open pull request', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-define-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const p of [behaviorSessionPrompt(null), behaviorSessionPrompt(new Store(repo).init())]) {
    assert.match(p, /gh pr list --state open/);
    assert.match(p, /thinker review --base origin\//);
    assert.match(p, /do not switch branches/);
    assert.match(p, /Post nothing to the pull request/);
  }
});
