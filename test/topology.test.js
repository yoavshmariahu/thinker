import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAreas, subsystemForFile } from '../src/topology.js';
import { stratifyPrs } from '../src/prs.js';
import { Store } from '../src/store.js';
import { createNote, attest } from '../src/ops.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-topo-'));
  return dir;
}

test('subsystemForFile maps paths to canonical subsystems', () => {
  assert.equal(subsystemForFile('/repo', 'pkg/services/auth/service.go'), 'pkg/services/auth');
  assert.equal(subsystemForFile('/repo', 'packages/grafana-ui/src/button.tsx'), 'packages/grafana-ui');
  assert.equal(subsystemForFile('/repo', 'src/click/core.py'), 'src/click');
  assert.equal(subsystemForFile('/repo', 'mitmproxy/proxy/server.py'), 'mitmproxy/proxy');
  assert.equal(subsystemForFile('/repo', 'main.go'), '.');
});

test('stratifyPrs groups candidate PRs and ensures subsystem diversity', () => {
  const candidates = [
    { number: 1, title: 'fix ui button styling', files: [{ path: 'frontend/button.tsx' }], mergedAt: '2026-09-01T10:00:00Z', body: 'fixes bug' },
    { number: 2, title: 'fix ui dropdown menu', files: [{ path: 'frontend/menu.tsx' }], mergedAt: '2026-09-02T10:00:00Z', body: 'fixes menu' },
    { number: 3, title: 'fix ui modal backdrop', files: [{ path: 'frontend/modal.tsx' }], mergedAt: '2026-09-03T10:00:00Z', body: 'fixes modal' },
    { number: 4, title: 'fix auth token validation issue', files: [{ path: 'backend/auth.go' }], mergedAt: '2026-08-01T10:00:00Z', body: 'fixes auth bug in tokens' },
    { number: 5, title: 'fix db connection leak crash', files: [{ path: 'storage/db.go' }], mergedAt: '2026-08-02T10:00:00Z', body: 'resolves connection pool crash' },
  ];

  // Requesting limit=3 without stratification would take only numbers 3, 2, 1 (the 3 newest from frontend)
  // With stratification, it takes one from frontend, one from backend, and one from storage!
  const stratified = stratifyPrs(candidates, 3);
  assert.equal(stratified.length, 3);
  const subs = stratified.map(p => p.files[0].path.split('/')[0]);
  assert.ok(subs.includes('frontend'), 'includes frontend');
  assert.ok(subs.includes('backend'), 'includes backend');
  assert.ok(subs.includes('storage'), 'includes storage');
});

test('kind-aware attestation: invariants and gotchas do not decay on unused, but locations do', () => {
  const repoDir = tmpRepo();
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'core.py'), 'def auth(): pass\ndef run(): pass\n');

  const store = new Store(repoDir).init();
  const inv = createNote(store, { title: 'Auth rule', kind: 'invariant', answers: ['auth'], body: 'src/core.py:auth', deps: [{ path: 'src/core.py', symbol: 'auth' }], confidence: 0.85 }).note;
  const loc = createNote(store, { title: 'Run location', kind: 'location', answers: ['run'], body: 'src/core.py:run', deps: [{ path: 'src/core.py', symbol: 'run' }], confidence: 0.85 }).note;

  // 6 unused attestations
  for (let i = 0; i < 6; i++) {
    attest(store, [
      { id: inv.id, verdict: 'unused' },
      { id: loc.id, verdict: 'unused' }
    ]);
  }

  // Invariant confidence must stay 0.85 (immune to unused decay)
  assert.equal(store.get(inv.id).confidence, 0.85);

  // Location confidence must have decayed
  assert.ok(store.get(loc.id).confidence < 0.85, 'location confidence decayed');
  fs.rmSync(repoDir, { recursive: true, force: true });
});
