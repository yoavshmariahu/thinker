import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { behaviorSessionPrompt } from '../src/setup/define.js';

// The prompt sets the repository up when it is not, builds the cache in the background when it is empty,
// and goes straight to the interview once the cache has notes.
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
  assert.match(empty, /0\. The cache has no notes yet: start `thinker setup --build/);

  store.put({ id: 'a-note', kind: 'rule', title: 'A rule', body: 'Body.', deps: [] });
  const built = behaviorSessionPrompt(store);
  assert.doesNotMatch(built, /^0\./m);
  assert.match(built, /behaviors already in force \(0 now\)/);
});
