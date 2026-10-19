import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { dedupeOn, duplicateCandidates, dedupeNotes, judgePair, embedText } from '../src/dedupe.js';
import { maintain, maintenanceNotice, DEFAULTS } from '../src/maintain.js';

const env = { THINKER_LOG: 'off', THINKER_TELEMETRY: 'off', THINKER_DEDUPE: '' };
function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; if (v === '') delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

// four notes: A and B the same fact about wire.mjs in other words, C about another file with A's words,
// D about wire.mjs but something else
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-dedupe-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/wire.mjs'), 'export function mcpEntry(env) {\n  return { command: "node", env };\n}\n');
  fs.writeFileSync(path.join(dir, 'src/other.mjs'), 'export function other() {\n  return 1;\n}\n');
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']); git(['commit', '-q', '-m', 'one']);
  const store = new Store(dir).init();
  const mk = (title, answers, body, file, created) => { const n = createNote(store, { title, kind: 'rule', answers, body, deps: [{ path: file }] }).note; n.created = created; store.put(n); return n; };
  const a = mk('MCP servers through Codex need an isolation environment', ['env not inherited'], 'src/wire.mjs:mcpEntry passes the isolation variables.', 'src/wire.mjs', '2026-10-08T20:00:00Z');
  const b = mk('Codex MCP processes require explicit environment isolation', ['why zero servings under Codex'], 'Declare the variables in the MCP entry (src/wire.mjs).', 'src/wire.mjs', '2026-10-08T21:00:00Z');
  const c = mk('Other module returns one', ['what other returns'], 'src/other.mjs:other returns 1.', 'src/other.mjs', '2026-10-08T22:00:00Z');
  const d = mk('MCP entry command is node', ['which command runs the server'], 'src/wire.mjs:mcpEntry runs node.', 'src/wire.mjs', '2026-10-08T23:00:00Z');
  return { dir, store, a, b, c, d };
}
// vectors by note: A and B nearly the same, C the same as A but on another file, D far from both
const vec = { a: [1, 0, 0], b: [0.95, 0.31, 0], c: [1, 0, 0], d: [0, 0, 1] };
function fakeEmbed(notes, calls) {
  const byText = new Map(Object.entries(notes).map(([k, n]) => [embedText(n), vec[k]]));
  return async texts => { calls.push(texts.length); return texts.map(t => byText.get(t) || [0, 1, 0]); };
}

test('the pass is on by default; the config or THINKER_DEDUPE turns it off, and the variable wins', () => {
  assert.equal(DEFAULTS.dedupe, true);
  assert.equal(dedupeOn({ ...DEFAULTS }, {}), true);
  assert.equal(dedupeOn({ dedupe: false }, {}), false);
  assert.equal(dedupeOn({ dedupe: false }, { THINKER_DEDUPE: 'on' }), true);
  assert.equal(dedupeOn({ dedupe: true }, { THINKER_DEDUPE: 'off' }), false);
});

test('candidates rest on a file in common and clear the cosine', () => withEnv(async () => {
  const { dir, store, a, b, c, d } = repo();
  const calls = [];
  const embedFn = fakeEmbed({ a, b, c, d }, calls);
  const pairs = await duplicateCandidates(store, { embedFn });
  assert.deepEqual(pairs.map(p => [p.a.id, p.b.id].sort()), [[a.id, b.id].sort()], 'C shares no file with A; D is far from both');
  assert.deepEqual(calls, [4]);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('a same-claim pair is merged into the older note and the newer one archived as its duplicate', () => withEnv(async () => {
  const { dir, store, a, b, c, d } = repo();
  const judged = [];
  const judgeFn = async (s, x, y) => { judged.push([x.id, y.id]); return { verdict: 'same', reason: 'one fact', title: 'MCP servers through Codex need explicit isolation env', body: 'src/wire.mjs:mcpEntry must carry the isolation variables; without them the server reports 0 servings.', tokens: 900 }; };
  const r = await dedupeNotes(store, { embedFn: fakeEmbed({ a, b, c, d }, []), judgeFn });
  assert.equal(judged.length, 1);
  assert.deepEqual(r.merged, [{ keep: a.id, drop: b.id, verdict: 'same' }]);
  assert.equal(r.tokens, 900);
  const kept = store.get(a.id), gone = store.get(b.id);
  assert.match(kept.body, /0 servings/);
  assert.equal(kept.title, 'MCP servers through Codex need explicit isolation env');
  assert.deepEqual(kept.answers.sort(), ['env not inherited', 'why zero servings under Codex'].sort());
  assert.match(kept.history.at(-1).reason, new RegExp(`merged ${b.id}`));
  assert.equal(kept.history.at(-1).prevBody, a.body);
  assert.equal(kept.search, undefined, 'phrased again for the new text');
  assert.equal(gone.archived.reason, `duplicate of ${a.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('a pair judged distinct is not asked again until one of its notes changes', () => withEnv(async () => {
  const { dir, store, a, b, c, d } = repo();
  let asked = 0;
  const judgeFn = async () => { asked++; return { verdict: 'distinct', reason: 'different claims', tokens: 100 }; };
  const calls = [];
  const embedFn = fakeEmbed({ a, b, c, d }, calls);
  assert.equal((await dedupeNotes(store, { embedFn, judgeFn })).distinct, 1);
  await dedupeNotes(store, { embedFn, judgeFn });
  assert.equal(asked, 1, 'remembered');
  assert.deepEqual(calls, [4], 'unchanged notes are not embedded again');
  const changed = { ...store.get(b.id), body: 'Declare every isolation variable in the MCP entry (src/wire.mjs).' };
  store.put(changed);
  await dedupeNotes(store, { embedFn: fakeEmbed({ a, b: changed, c, d }, calls), judgeFn });
  assert.equal(asked, 2, 'asked again for the new text');
  assert.deepEqual(calls, [4, 1], 'only the changed note is embedded');
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('a dry run lists candidates and calls no model; the cap stops the judging', () => withEnv(async () => {
  const { dir, store, a, b, c, d } = repo();
  const judgeFn = async () => { throw new Error('no model call'); };
  const dry = await dedupeNotes(store, { embedFn: fakeEmbed({ a, b, c, d }, []), judgeFn, dry: true });
  assert.equal(dry.candidates, 1); assert.equal(dry.judged, 1); assert.equal(dry.errors, 0);
  const capped = await dedupeNotes(store, { embedFn: fakeEmbed({ a, b, c, d }, []), judgeFn, afford: () => false });
  assert.equal(capped.capped, true); assert.equal(capped.judged, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('the judge is shown both notes and the current code of the file they share', () => withEnv(async () => {
  const { dir, store, a, b } = repo();
  let seen;
  const completeFn = async o => { seen = o; return { json: { verdict: 'distinct', reason: 'x' } }; };
  await judgePair(store, a, b, { completeFn, model: 'haiku' });
  assert.match(seen.prompt, /NOTE A .*\n.*mcpEntry passes/);
  assert.match(seen.prompt, /NOTE B/);
  assert.match(seen.prompt, /--- src\/wire\.mjs ---\nexport function mcpEntry/);
  assert.equal(seen.accounting.purpose, 'dedupe');
  assert.deepEqual(seen.schema.properties.verdict.enum, ['same', 'conflict', 'distinct']);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('maintenance runs the pass unless it is turned off, and the notice names the merges', () => withEnv(async () => {
  const { dir, store } = repo();
  let ran = 0;
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async notes => ({ done: [], tokens: 0 }), minePrs: async () => ({}), dedupe: async () => { ran++; return { merged: [{ keep: 'x', drop: 'y' }], tokens: 500, errors: 0 }; } };
  const r = await maintain(store, dir, { fns });
  assert.equal(ran, 1, 'on by default'); assert.equal(r.merged, 1);
  assert.match(maintenanceNotice(store), /1 duplicate note merged/);
  fs.rmSync(path.join(store.dir, 'state', 'maintain.json'), { force: true });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), maintain: { dedupe: false } }));
  await maintain(store, dir, { fns });
  assert.equal(ran, 1, 'off in the config');
  fs.rmSync(dir, { recursive: true, force: true });
}));
