// Desired behaviors (behavior.js): a person's rule the code must uphold until a change that breaks it is merged. Verification never retires
// or rewrites one; a review reports code that stops upholding it; the repair hook, archiving and
// distillation leave it alone; lookup finds it by kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, sharedContent, LOCAL_FIELDS, KINDS } from '../src/store.js';
import { hashDep } from '../src/deps.js';
import { createNote, verifyNote, refresh, lookup, archiveReason, distillKinds, noteUnreported } from '../src/ops.js';
import { distillSpec } from '../src/distill.js';
import { listBehaviors, renderBehaviors, renderSystemMarkdown, promoteBehavior, proposeBehaviors, addBehavior, behaviorState } from '../src/behavior.js';
import { review, resolveScope, renderReview, noteFileChanged, assessHolistic, selectNotes, collectChange, makeReader } from '../src/review.js';
import { maintenanceNotice } from '../src/maintain.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
process.env.THINKER_LOG = 'local';
process.env.THINKER_TELEMETRY = 'off';
process.env.THINKER_AST = 'off';

const CORE = `import os\n\nclass Command:\n    def invoke(self, ctx):\n        validate(ctx)\n        return self.main(ctx)\n\n    def main(self, ctx):\n        return run_callback(ctx)\n\ndef validate(ctx):\n    if ctx is None:\n        raise ValueError("ctx")\n\ndef run_callback(ctx):\n    return ctx\n`;
const CLI = `from core import Command, run_callback, validate\n\ndef entry(ctx):\n    validate(ctx)\n    cmd = Command()\n    return cmd.invoke(ctx)\n`;

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-behavior-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  write('src/core.py', CORE); write('src/cli.py', CLI);
  const commit = msg => { git('add', '-A'); git('commit', '-qm', msg || 'fixture'); return git('rev-parse', 'HEAD'); };
  commit('init');
  const store = new Store(repo).init();
  const behavior = (extra = {}) => createNote(store, { id: 'ctx-validated-before-main', title: 'Every command validates its context before running', kind: 'behavior', answers: ['is ctx validated before main runs', 'where is the context checked'], body: 'core.py:Command.invoke calls core.py:validate before core.py:Command.main. main assumes a non-None ctx; no entry point may reach main without validate.', deps: [{ path: 'src/core.py', symbol: 'Command.invoke' }, { path: 'src/core.py', symbol: 'validate' }], confidence: 0.9, ...extra }, { source: { type: 'human' } }).note;
  return { repo, git, store, write, commit, behavior };
}
// A model that answers with one fixed JSON (llm.js: THINKER_LLM_CMD reads the prompt on stdin).
function fakeModel(t, repo, answer) {
  const script = path.join(repo, `model-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(answer))}));`);
  const saved = { THINKER_LLM_CMD: process.env.THINKER_LLM_CMD, THINKER_LLM: process.env.THINKER_LLM, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.THINKER_LLM_CMD = `node "${script}"`; delete process.env.THINKER_LLM; delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('a behavior is a note with a shared mutability and a checkout-local violated state; agents never distill one', t => {
  const { store, behavior } = fixture(t);
  const n = behavior();
  assert.equal(n.kind, 'behavior'); assert.equal(n.mutability, 'mutable');
  assert.equal(behavior({ id: 'fixed-one', title: 'A fixed one', mutability: 'fixed' }).mutability, 'fixed');
  assert.equal(behavior({ id: 'odd', title: 'An odd one', mutability: 'sometimes' }).mutability, 'mutable');
  assert.equal(sharedContent(n).mutability, 'mutable');
  assert.ok(LOCAL_FIELDS.includes('violated'));
  assert.ok(KINDS.includes('behavior'));
  assert.ok(!distillKinds(store).includes('behavior'));
  assert.ok(!distillSpec().schema.properties.notes.items.properties.kind.enum.includes('behavior'));
  assert.ok(!distillSpec({ kinds: KINDS }).schema.properties.notes.items.properties.kind.enum.includes('behavior'));
  assert.equal(archiveReason(n, { kinds: ['behavior'], unservedDays: 1, now: Date.now() + 10 * 86400_000 }), null);
  assert.equal(behaviorState(n), 'holds');
});

test('lookup finds behaviors by kind: all of them with no query, the matching ones with one', async t => {
  const { store, behavior } = fixture(t);
  behavior(); behavior({ id: 'second', title: 'Callbacks never see a None context', answers: ['can run_callback get None'], body: 'core.py:run_callback is only reached through core.py:Command.main.', deps: [{ path: 'src/core.py', symbol: 'run_callback' }] });
  createNote(store, { title: 'How to run the tests', kind: 'howto', answers: ['how do I run tests'], body: 'pytest from the root; see src/cli.py:entry.', deps: [{ path: 'src/cli.py' }] }, { source: { type: 'human' } });
  const all = await lookup(store, { query: '', kind: 'behavior', budget: 4000 });
  assert.deepEqual(all.included.map(n => n.id).sort(), ['ctx-validated-before-main', 'second']);
  const one = await lookup(store, { query: 'validated before main', kind: 'behavior' });
  assert.deepEqual(one.included.map(n => n.id), ['ctx-validated-before-main']);
  assert.match(one.text, /\[behavior, mutable\]/);
  const none = await lookup(store, { query: 'run the tests', kind: 'behavior' });
  assert.equal(none.included.length, 0);
});

test('verification: a behavior broken in a working tree or on a branch is violated and its text kept; broken by code merged on the default branch it is revised to match', async t => {
  const { repo, store, write, commit, behavior, git } = fixture(t);
  const n = behavior({ mutability: 'fixed' });
  // 1. uncommitted: violated, text untouched
  write('src/core.py', CORE.replace('        validate(ctx)\n', ''));
  let [stale] = refresh(store, [store.get(n.id)]);
  assert.equal(stale.status, 'stale');
  fakeModel(t, repo, { verdict: 'broken', reason: 'invoke no longer calls validate', body: 'should be ignored: not merged' });
  let r = await verifyNote(store, stale, {});
  assert.equal(r.verdict, 'broken');
  let v = store.get(n.id);
  assert.equal(v.status, 'violated'); assert.equal(v.body, n.body); assert.equal(v.violated.reason, 'invoke no longer calls validate');
  // re-baselined: it reads as violated, not stale, until the code changes again
  assert.equal(refresh(store, [store.get(n.id)])[0].status, 'violated');
  assert.equal(behaviorState(store.get(n.id)), 'violated');
  assert.match(renderBehaviors(listBehaviors(store)), /^violated\s+\[fixed, local\].*\n\s+since [0-9a-f]{10}: invoke no longer calls validate/m);
  assert.match(maintenanceNotice(store), /1 desired behavior needs review/);
  assert.equal(maintenanceNotice(store), '');
  // 2. committed on a branch: still violated
  git('checkout', '-qb', 'feature'); git('add', 'src'); git('commit', '-qm', 'drop validation on a branch'); // src only: .thinker/ state stays untracked
  v = store.get(n.id); v.status = 'stale'; v.stale = { changed: [{ path: 'src/core.py', symbol: 'Command.invoke', reason: 'symbol body changed' }] }; store.put(v);
  r = await verifyNote(store, store.get(n.id), {});
  assert.equal(r.verdict, 'broken'); assert.equal(store.get(n.id).status, 'violated'); assert.equal(store.get(n.id).body, n.body);
  // 3. merged on main: the code is the truth and the behavior is revised to match, the old text in its history
  git('checkout', '-q', 'main'); git('merge', '-q', '--ff-only', 'feature');
  v = store.get(n.id); v.status = 'stale'; v.stale = { changed: [{ path: 'src/core.py', symbol: 'Command.invoke', reason: 'symbol body changed' }] }; store.put(v);
  fakeModel(t, repo, { verdict: 'broken', reason: 'invoke no longer calls validate', body: 'core.py:Command.invoke calls core.py:Command.main directly; nothing validates ctx before main runs, so main must cope with None.' });
  r = await verifyNote(store, store.get(n.id), {});
  assert.equal(r.verdict, 'revised');
  v = store.get(n.id);
  assert.equal(v.status, 'fresh'); assert.equal(v.violated, undefined);
  assert.match(v.body, /^core.py:Command.invoke calls core.py:Command.main directly/);
  assert.equal(v.revised.commit, git('rev-parse', 'HEAD')); assert.equal(v.revised.reason, 'invoke no longer calls validate');
  assert.equal(v.history.at(-1).prevBody, n.body); assert.match(v.history.at(-1).reason, /revised to match the merged code/);
  assert.ok(v.deps.some(d => d.symbol === 'Command.main'), 'a pointer of the new text became a dep');
  assert.equal(behaviorState(v), 'holds');
  const revisedBody = v.body;
  assert.match(renderBehaviors(listBehaviors(store)), /holds\s+\[fixed, local, revised \d{4}-\d\d-\d\d to match [0-9a-f]{10}\]/);
  assert.match(maintenanceNotice(store), /1 desired behavior revised/);
  // the code is restored on main: stale again, then holds
  write('src/core.py', CORE); commit('restore validation');
  [stale] = refresh(store, [store.get(n.id)]);
  assert.equal(stale.status, 'stale');
  fakeModel(t, repo, { verdict: 'holds', reason: 'validate is called first again' });
  r = await verifyNote(store, stale, {});
  assert.equal(r.verdict, 'holds'); assert.equal(store.get(n.id).status, 'fresh'); assert.equal(store.get(n.id).violated, undefined);
  // the enforcement moved: the note follows it, its text untouched
  write('src/core.py', CORE.replace('        validate(ctx)\n        return self.main(ctx)', '        return self.main(ctx)').replace('    def main(self, ctx):\n', '    def main(self, ctx):\n        validate(ctx)\n'));
  commit('validate in main');
  [stale] = refresh(store, [store.get(n.id)]);
  fakeModel(t, repo, { verdict: 'moved', reason: 'main validates now', pointers: ['src/core.py:Command.main', 'src/core.py:validate'] });
  r = await verifyNote(store, stale, {});
  assert.equal(r.verdict, 'moved');
  const moved = store.get(n.id);
  assert.equal(moved.status, 'fresh'); assert.equal(moved.body, revisedBody); // moved never rewrites: the text is the revised one from the merge
  assert.deepEqual(moved.deps.map(d => d.symbol).sort(), ['Command.main', 'validate']);
  assert.ok(moved.history.at(-1).prevDeps.length >= 2); // the body's own pointers were deps too
});

test('a review reports code that stops upholding a behavior as a violation; a mutable one is revised only by a change that edits its note', async t => {
  const { repo, store, write, commit, behavior, git } = fixture(t);
  const fixed = behavior({ mutability: 'fixed' });
  const mutable = behavior({ id: 'entry-validates-too', title: 'The CLI entry validates before invoking', body: 'cli.py:entry calls core.py:validate before core.py:Command.invoke.', answers: ['does entry validate'], deps: [{ path: 'src/cli.py', symbol: 'entry' }] });
  store.promote(fixed); store.promote(mutable); commit('notes');
  write('src/core.py', CORE.replace('        validate(ctx)\n', ''));
  write('src/cli.py', CLI.replace('    validate(ctx)\n', ''));
  const seen = [];
  const assess = async (s, n, e, change, reader, opts) => { seen.push({ id: n.id, revisable: opts.revisable }); return { id: n.id, verdict: 'revised', reason: 'the change restates it', findings: [], noteCorrection: '', cost: 0 }; };
  // neither note is edited: "revised" is not available, so both are violations; the fixed one an error
  let r = await review(store, { scope: resolveScope(repo), strategy: { mode: 'per-note', related: false }, assess });
  assert.deepEqual(seen.map(x => x.revisable), [false, false]);
  assert.equal(r.behaviors.length, 2);
  // now the mutable note is edited in the working tree: the change may revise it
  const file = path.join(store.notesDir, `${mutable.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.body = 'cli.py:entry relies on core.py:Command.invoke to validate.'; fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  assert.equal(noteFileChanged(repo, resolveScope(repo), mutable.id), true);
  assert.equal(noteFileChanged(repo, resolveScope(repo), fixed.id), false);
  git('add', '-A');
  assert.equal(noteFileChanged(repo, resolveScope(repo, { staged: true }), mutable.id), true);
  const c = commit('revise');
  assert.equal(noteFileChanged(repo, resolveScope(repo, { ref: c }), mutable.id), true);
  assert.equal(noteFileChanged(repo, resolveScope(repo, { ref: c }), fixed.id), false);
  // the real assessBehavior with a model that always says "revised"
  fakeModel(t, repo, { verdict: 'revised', reason: 'the change restates it', findings: [], noteCorrection: '' });
  r = await review(store, { scope: resolveScope(repo, { ref: c }), strategy: { mode: 'per-note', related: false } });
  const by = Object.fromEntries(r.behaviors.map(b => [b.id, b]));
  assert.equal(by[mutable.id].outcome, 'revised');
  assert.equal(by[fixed.id].outcome, 'violated');
  assert.equal(r.verdicts.find(v => v.id === fixed.id).verdict, 'violation');
  const f = r.findings.find(x => x.note === fixed.id || x.notes?.includes(fixed.id));
  assert.equal(f.severity, 'error'); assert.equal(f.file, 'src/core.py'); assert.match(f.message, /fixed behavior "Every command validates/);
  assert.equal(r.notes.outdated.length, 0);
  const text = renderReview(r);
  assert.match(text, /Desired behaviors \(2 in play/);
  assert.match(text, /violated\s+\[fixed\] Every command validates/);
  assert.match(text, /revised\s+\[mutable\] The CLI entry validates.*edits the behavior note/);
  // dry: the behaviors are listed as consulted, with the revised one marked
  const dry = await review(store, { scope: resolveScope(repo, { ref: c }), dry: true, strategy: { mode: 'per-note', related: false } });
  assert.deepEqual(dry.behaviors.map(b => b.outcome).sort(), ['consulted', 'revised']);
});

test('the holistic call turns a behavior it calls outdated into a finding, and never into an outdated note', async t => {
  const { repo, store, write, behavior } = fixture(t);
  const n = behavior({ mutability: 'fixed' });
  write('src/core.py', CORE.replace('        validate(ctx)\n', ''));
  const scope = resolveScope(repo), reader = makeReader(repo, scope), change = collectChange(repo, scope);
  const { exposures } = selectNotes(store.list(), change, reader);
  fakeModel(t, repo, { findings: [], outdated: [{ id: n.id, reason: 'invoke does not validate any more' }], summary: 'x' });
  const r = await assessHolistic(store, [store.get(n.id)], exposures, change, reader, { model: 'x' });
  assert.equal(r.outdated.length, 0);
  assert.equal(r.findings.length, 1); assert.equal(r.findings[0].severity, 'error'); assert.equal(r.findings[0].note, n.id);
  assert.match(r.findings[0].message, /no longer upheld: invoke does not validate any more/);
});

test('promote makes a rule note a behavior, propose lists the candidates, and the markdown is written', t => {
  const { repo, store } = fixture(t);
  const inv = createNote(store, { title: 'invoke validates first', kind: 'invariant', answers: ['why validate first'], body: 'core.py:Command.invoke calls core.py:validate first.', deps: [{ path: 'src/core.py', symbol: 'Command.invoke' }], confidence: 0.6 }, { source: { type: 'agent', ref: 's1' } }).note;
  createNote(store, { title: 'where tests live', kind: 'location', answers: ['where are tests'], body: 'src/cli.py:entry', deps: [{ path: 'src/cli.py' }] }, { source: { type: 'agent' } });
  assert.deepEqual(proposeBehaviors(store).map(c => c.id), [inv.id]);
  const p = promoteBehavior(store, inv.id, { mutability: 'fixed' });
  assert.equal(p.note.kind, 'behavior'); assert.equal(p.note.mutability, 'fixed'); assert.equal(p.note.source.type, 'human'); assert.equal(p.note.source.promoted, 'rule');
  assert.ok(p.note.confidence >= 0.8);
  assert.equal(promoteBehavior(store, inv.id, { mutability: 'fixed' }).unchanged, true);
  assert.equal(promoteBehavior(store, 'nope').error, 'no such note');
  // an agent's behavior is a proposal until accepted
  const prop = createNote(store, { title: 'Callbacks never see None', kind: 'behavior', answers: ['can callbacks get None'], body: 'core.py:run_callback is reached through core.py:Command.main only.', deps: [{ path: 'src/core.py', symbol: 'run_callback' }] }, { source: { type: 'agent', ref: 'mcp' } }).note;
  assert.ok(listBehaviors(store).find(r => r.id === prop.id).proposed);
  assert.match(renderBehaviors(listBehaviors(store)), /1 proposed by agents/);
  promoteBehavior(store, prop.id, { mutability: 'mutable' });
  assert.ok(!listBehaviors(store).find(r => r.id === prop.id).proposed);
  const a = addBehavior(store, { title: 'Nothing', body: 'x', deps: [] }, { mutability: 'often' });
  assert.match(a.error, /mutability must be/);
  const md = renderSystemMarkdown(listBehaviors(store), { repoName: 'demo' });
  assert.match(md, /^# Desired behaviors of demo/); assert.match(md, /## Fixed\n\n### invoke validates first/); assert.match(md, /## Mutable/); assert.match(md, /`src\/core.py:Command.invoke`/);
  assert.ok(!fs.existsSync(path.join(store.dir, 'SYSTEM.md')));
  const env = { ...process.env };
  const out = spawnSync('node', [cli, 'system', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /holds\s+\[fixed, local\] invoke validates first/);
  assert.match(out.stdout, /2 desired behaviors/);
  const mdOut = spawnSync('node', [cli, 'system', 'md', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(mdOut.status, 0, mdOut.stderr);
  assert.ok(fs.existsSync(path.join(store.dir, 'SYSTEM.md')));
  const look = spawnSync('node', [cli, 'lookup', '--kind', 'behavior', '--repo', repo], { encoding: 'utf8', env });
  assert.match(look.stdout, /\[behavior, fixed\] invoke validates first/);
  const prom = spawnSync('node', [cli, 'system', 'promote', 'nope', '--repo', repo], { encoding: 'utf8', env });
  assert.match(prom.stdout, /nope: no such note/);
});

test('noteUnreported keeps the last ten and replaces an entry by id', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 12; i++) noteUnreported(store, 'violated', { id: `b${i}`, title: `t${i}`, reason: '' });
  noteUnreported(store, 'violated', { id: 'b11', title: 'again', reason: '' });
  const u = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'maintain.json'), 'utf8')).unreported.violated;
  assert.equal(u.length, 10); assert.equal(u.at(-1).title, 'again'); assert.equal(u.filter(x => x.id === 'b11').length, 1);
});
