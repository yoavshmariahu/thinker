import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAreas, planAreas, AREA_SOURCE_BYTES, AREA_SOURCE_FILES, subsystemForFile } from '../src/topology.js';
import { stratifyPrs } from '../src/prs.js';
import { Store } from '../src/store.js';
import { createNote, attest } from '../src/ops.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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

function sourceRepo(t, sources) {
  const repo = tmpRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const [file, size] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'x'.repeat(size));
  }
  execFileSync('git', ['add', '.'], { cwd: repo });
  return repo;
}

function assertCoverage(areas, files) {
  const assigned = areas.flatMap(area => area.files);
  assert.deepEqual(assigned.toSorted(), files.toSorted(), 'every source file assigned exactly once');
  assert.equal(new Set(areas.map(area => area.label)).size, areas.length, 'distinct session labels');
  for (const area of areas) {
    assert.equal(area.n, area.files.length);
    assert.ok(area.n <= AREA_SOURCE_FILES);
    assert.ok(area.size <= AREA_SOURCE_BYTES || area.n === 1);
  }
}

test('compact code shares one session, including entry points and private modules', t => {
  const sources = { 'src/index.js': 100, 'src/_private.js': 200, 'src/auth/token.js': 500,
    'src/auth/session.js': 500, 'src/api.js': 1000 };
  const repo = sourceRepo(t, { ...sources, 'test/api.test.js': 500, 'dist/bundle.js': 900_000 });
  const areas = discoverAreas(repo);
  assert.equal(areas.length, 1);
  assertCoverage(areas, Object.keys(sources));
});

test('session count grows with source size beyond twelve and caps report omitted coverage', t => {
  const sources = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`packages/p${i}/core.js`, 90_000]));
  const repo = sourceRepo(t, sources);
  const all = discoverAreas(repo);
  assert.equal(all.length, 15);
  assertCoverage(all, Object.keys(sources));
  const capped = planAreas(repo, { limit: 3 });
  assert.equal(capped.areas.length, 3);
  assert.equal(capped.omitted.length, 12);
  assertCoverage([...capped.areas, ...capped.omitted], Object.keys(sources));
  const zero = planAreas(repo, { limit: 0 });
  assert.equal(zero.areas.length, 0);
  assert.equal(zero.omitted.length, all.length);
  assert.deepEqual(discoverAreas(repo), all, 'planning is deterministic');
  for (const limit of [true, -1, 1.5, 'bad', Infinity]) assert.throws(() => discoverAreas(repo, { limit }), /non-negative integer/);
});

test('large flat and deep directories split without losing or duplicating files', t => {
  const sources = Object.fromEntries(Array.from({ length: 170 }, (_, i) => [`src/flat/f${i}.js`, 2000]));
  sources['src/deep/nested/large.js'] = AREA_SOURCE_BYTES * 2;
  sources['src/deep/nested/peer.js'] = 80_000;
  sources['src/deep/nested/other.js'] = 80_000;
  const repo = sourceRepo(t, sources);
  const all = discoverAreas(repo);
  assert.ok(all.length > 3);
  assertCoverage(all, Object.keys(sources));
  const selected = discoverAreas(repo, { directories: ['src/deep/nested'] });
  assertCoverage(selected, Object.keys(sources).filter(file => file.startsWith('src/deep/')));
  assert.ok(selected.every(area => area.dir.startsWith('src/deep/nested/')));
});

test('many tiny files split by inventory size and missing or generated files do not inflate it', t => {
  const sources = Object.fromEntries(Array.from({ length: 161 }, (_, i) => [`lib/f${i}.js`, 1]));
  const repo = sourceRepo(t, { ...sources, 'lib/deleted.js': 10, 'vendor/huge.js': 1_000_000 });
  fs.unlinkSync(path.join(repo, 'lib/deleted.js'));
  const areas = discoverAreas(repo);
  assert.equal(areas.length, 3);
  assertCoverage(areas, Object.keys(sources));
});

test('empty selection yields no work and test-only projects can still be explored', t => {
  const repo = sourceRepo(t, { 'test/only.test.js': 100 });
  assert.equal(discoverAreas(repo).length, 1);
  assert.deepEqual(discoverAreas(repo, { directories: ['missing'] }), []);
});
