import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { explicitIdents, phraseCandidates, anchoringGuard } from '../src/guard.js';
import { Store } from '../src/store.js';
import { createNote, outcome, looksLikeCorrection } from '../src/ops.js';

test('explicit identifiers and phrase permutations', () => {
  const ids = explicitIdents('Rename the XSRF cookie to `_mitmproxy_xsrf`; see tools/web/app.py and view_order_reversed and --set flag and getUserById.');
  for (const x of ['_mitmproxy_xsrf', 'app.py', 'view_order_reversed', '--set', 'getUserById']) assert.ok(ids.includes(x), x);
  const ph = phraseCandidates('when the reverse view order option is enabled');
  assert.ok(ph.includes('view_order_reverse'));
});

test('anchoring guard names uncovered identifiers that exist in the repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.py'), 'view_order_reversed = True\ndef insert_view_item():\n    pass\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  const g = anchoringGuard(dir, 'honor the reverse view order option in insert_view_item', [{ title: 'x', body: 'a.py:insert_view_item appends', deps: [{ path: 'a.py', symbol: 'insert_view_item' }] }]);
  assert.ok(g.uncovered.some(u => u.ident.startsWith('view_order')));
  assert.ok(!g.uncovered.some(u => u.ident === 'insert_view_item'));
});

test('outcome signal hits notes served in the session; correction detection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-out-'));
  fs.writeFileSync(path.join(dir, 'a.py'), 'def f():\n    pass\n');
  const store = new Store(dir).init();
  const { note } = createNote(store, { title: 'F', kind: 'location', answers: ['f'], body: 'a.py:f', deps: [{ path: 'a.py', symbol: 'f' }], confidence: 0.7 });
  note.servedIn = ['s1']; store.put(note);
  outcome(store, { session: 's1', positive: false, reason: 'test' });
  assert.equal(store.get(note.id).confidence, 0.6);
  assert.equal(outcome(store, { session: 's2', positive: false }).length, 0);
  assert.ok(looksLikeCorrection("No, that's not it, the option lives elsewhere"));
  assert.ok(looksLikeCorrection('still broken after your change'));
  assert.ok(!looksLikeCorrection('now add a test for it'));
});
