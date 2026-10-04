// Measuring what the notes do, and serving less of what they showed does nothing: the holdout
// (a share of sessions the hooks serve nothing), the session stats behind the comparison, and
// archiving notes out of serving and upkeep while review keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { rank } from '../src/rank.js';
import { createNote, orient, lookup, lateNotes, rememberTask, holdoutSession, holdoutRate, archiveNotes, archiveReason, ARCHIVE_DEFAULTS } from '../src/ops.js';
import { maintain, pickStale, DEFAULTS } from '../src/maintain.js';
import { holdoutSummary, renderHoldout, summarize, renderUsage } from '../src/usage.js';
import { parseTranscript } from '../src/transcripts.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-holdout-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n\nexport function saveRows() {\n  return 2;\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}
const logLines = store => fs.existsSync(path.join(store.dir, 'log.jsonl')) ? fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];

test('the holdout is a deterministic share of sessions, off by env or config, never for an unknown session', () => withEnv({ THINKER_HOLDOUT: undefined }, () => {
  const store = new Store(gitRepo()).init();
  assert.equal(holdoutRate(store), 0.15);
  const ids = Array.from({ length: 400 }, (_, i) => `session-${i}`);
  const held = ids.filter(id => holdoutSession(store, id));
  assert.ok(held.length > 30 && held.length < 90, `about 15% of 400: ${held.length}`);
  assert.deepEqual(ids.filter(id => holdoutSession(store, id)), held, 'the same sessions every time');
  assert.equal(holdoutSession(store, 'unknown'), false);
  assert.equal(holdoutSession(store, undefined), false);
  process.env.THINKER_HOLDOUT = 'off'; assert.equal(holdoutRate(store), 0); assert.equal(holdoutSession(store, held[0]), false);
  process.env.THINKER_HOLDOUT = '1'; assert.equal(holdoutSession(store, 'anything'), true);
  delete process.env.THINKER_HOLDOUT;
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ holdout: false }));
  assert.equal(holdoutRate(new Store(store.repo)), 0);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ holdout: 0.5 }));
  assert.equal(holdoutRate(new Store(store.repo)), 0.5);
}));

test('a held-out orient serves nothing, marks nothing served, and logs what it withheld', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'callpath', answers: ['how are rows fetched', 'where does fetchRows read from'], body: 'src/a.js:fetchRows reads the rows table and returns them', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const task = 'where does fetchRows read the rows from';
  const held = await orient(store, { task, session: 's1', client: 'claude', holdout: true });
  assert.equal(held.text, ''); assert.equal(held.included.length, 0); assert.equal(held.holdout, true);
  assert.equal(held.withheld.length, 1, 'what would have been served is known');
  const n = store.list()[0];
  assert.equal(n.uses || 0, 0, 'not counted as served'); assert.deepEqual(n.servedIn || [], []);
  const line = logLines(store).find(l => l.op === 'orient');
  assert.equal(line.holdout, true); assert.deepEqual(line.served, []); assert.deepEqual(line.withheld, [n.id]);
  // the same request in a served session gets the note
  const served = await orient(store, { task, session: 's2', client: 'claude' });
  assert.equal(served.included.length, 1);
}));

test('the hooks of a held-out session serve nothing and log the session stats at stop', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: '1', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1' }, async () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'gotcha', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table; saveRows must run after it', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const env = { ...process.env };
  const prompt = execFileSync('node', [CLI, 'hook', 'prompt', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', prompt: 'where does fetchRows read the rows from' }), encoding: 'utf8', env });
  assert.equal(prompt.trim(), '', 'nothing injected');
  const tool = execFileSync('node', [CLI, 'hook', 'tool', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } }), encoding: 'utf8', env });
  assert.equal(tool.trim(), '', 'no late notes either');
  const transcript = path.join(dir, 'h1.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'where does fetchRows read the rows from' } },
    { type: 'assistant', message: { model: 'claude-test-1', usage: { input_tokens: 100, cache_read_input_tokens: 900 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function fetchRows' }] } },
    { type: 'assistant', message: { model: 'claude-test-1', usage: { input_tokens: 50, cache_read_input_tokens: 1950 }, content: [{ type: 'text', text: 'it reads the rows table' }] } },
  ].map(j => JSON.stringify(j)).join('\n') + '\n');
  execFileSync('node', [CLI, 'hook', 'stop', '--no-distill', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', transcript_path: transcript }), encoding: 'utf8', env });
  const lines = logLines(store);
  const o = lines.find(l => l.op === 'orient'); assert.equal(o.holdout, true); assert.equal(o.withheld.length, 1);
  const s = lines.find(l => l.op === 'session');
  assert.ok(s, 'a session line'); assert.equal(s.holdout, true); assert.equal(s.model, 'claude-test-1');
  assert.equal(s.toolCalls, 1); assert.equal(s.turns, 2); assert.equal(s.inputTokens, 3000, 'input, cache reads and cache writes of every turn');
  const stats = parseTranscript(transcript).stats;
  assert.deepEqual(stats, { toolCalls: 1, turns: 2, inputTokens: 3000 });
}));

test('usage compares served and held-out sessions by their own transcripts, and says when there are too few', () => {
  const lines = new Map(), served = new Map();
  for (let i = 0; i < 12; i++) {
    const k = `o|s${i}`, holdout = i % 3 === 0;
    lines.set(k, { op: 'session', session: `s${i}`, model: 'm', holdout, toolCalls: holdout ? 20 + i : 10 + i, inputTokens: holdout ? 2_000_000 : 1_000_000, turns: 5 });
    served.set(k, { served: holdout ? 0 : 2, withheld: holdout ? 2 : 0, holdout });
  }
  served.set('o|none', { served: 0, withheld: 0, holdout: true }); lines.set('o|none', { toolCalls: 99 });
  served.set('o|lost', { served: 1, withheld: 0, holdout: false });
  const h = holdoutSummary(lines, served);
  assert.equal(h.served.sessions, 8); assert.equal(h.heldOut.sessions, 4);
  assert.equal(h.noNotes, 1, 'nothing to serve: on neither side'); assert.equal(h.unmeasured, 1, 'no session line');
  assert.equal(h.enough, false);
  assert.equal(h.deltaPct.inputTokens, -50);
  const text = renderHoldout(h).join('\n');
  assert.match(text, /too few to compare yet/); assert.match(text, /8 served notes, 4 held out/);
  // one more held-out session and both sides have five
  lines.set('o|s12', { model: 'm', holdout: true, toolCalls: 30, inputTokens: 2_000_000, turns: 5 }); served.set('o|s12', { served: 0, withheld: 1, holdout: true });
  const h2 = holdoutSummary(lines, served);
  assert.equal(h2.enough, true);
  const t2 = renderHoldout(h2).join('\n');
  assert.match(t2, /tool calls\s+median 1\d\.?\d? served vs 2\d held out \(-\d+% with notes\)/);
  assert.match(t2, /input tokens\s+median 1M served vs 2M held out \(-50% with notes\)/);
  assert.match(t2, /^  m\s+8 vs 5 sessions/m);
});

test('usage reads session and holdout lines from the log into the summary', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'callpath', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  await orient(store, { task: 'how are rows fetched by fetchRows', session: 'a', client: 'claude' });
  await orient(store, { task: 'how are rows fetched by fetchRows', session: 'b', client: 'claude', holdout: true });
  store.log({ op: 'session', session: 'a', model: 'm', toolCalls: 3, inputTokens: 1000, turns: 2 });
  store.log({ op: 'session', session: 'b', model: 'm', holdout: true, toolCalls: 6, inputTokens: 3000, turns: 4 });
  const u = summarize(store, {});
  assert.equal(u.holdout.served.sessions, 1); assert.equal(u.holdout.heldOut.sessions, 1);
  assert.equal(u.holdout.served.toolCalls, 3); assert.equal(u.holdout.heldOut.toolCalls, 6);
  assert.match(renderUsage(u, {}), /Holdout/);
  assert.equal(u.servings.prompt, 1, 'a withheld note is not a serving');
}));

test('archiving: kinds the sessions never acted on, and notes unserved for a month; rank, lookup, late notes and verification skip them; review keeps them', () => withEnv({ THINKER_LOG: 'local', THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  const loc = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows defined'], body: 'src/a.js:fetchRows is the reader', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  const rule = createNote(store, { title: 'saveRows must run after fetchRows', kind: 'gotcha', answers: ['order of saveRows and fetchRows'], body: 'src/a.js:saveRows after src/a.js:fetchRows, or rows are lost', deps: [{ path: 'src/a.js', symbol: 'saveRows' }] }).note;
  const old = createNote(store, { title: 'fetchRows returns one', kind: 'callpath', answers: ['what fetchRows returns'], body: 'src/a.js:fetchRows returns 1', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  const oldUsed = createNote(store, { title: 'saveRows returns two', kind: 'callpath', answers: ['what saveRows returns'], body: 'src/a.js:saveRows returns 2', deps: [{ path: 'src/a.js', symbol: 'saveRows' }] }).note;
  const month = 31 * 86400_000;
  for (const n of [old, oldUsed]) { n.created = new Date(Date.now() - month).toISOString(); store.put(n); }
  oldUsed.uses = 1; store.put(oldUsed);
  assert.deepEqual(ARCHIVE_DEFAULTS.kinds, []); // since the kinds were collapsed to four, no kind is archived by default
  const byKind = { ...ARCHIVE_DEFAULTS, kinds: ['map'] };
  assert.equal(archiveReason(loc, byKind), 'kind map');
  assert.equal(archiveReason(store.get(rule.id), byKind), null, 'a rule stays in serving');
  assert.equal(archiveReason(store.get(old.id), ARCHIVE_DEFAULTS), 'not served in 30 days');
  assert.equal(archiveReason(store.get(oldUsed.id), ARCHIVE_DEFAULTS), null, 'served once: kept');
  const dry = archiveNotes(store, { dry: true });
  assert.deepEqual(dry.map(d => d.id), [old.id]);
  assert.ok(!store.get(old.id).archived, 'dry run writes nothing');
  const done = archiveNotes(store, {});
  assert.equal(done.length, 1);
  assert.equal(store.get(old.id).archived.reason, 'not served in 30 days');
  archiveNotes(store, { ids: [loc.id] }); // by request, for the checks below
  assert.equal(archiveNotes(store, {}).length, 0, 'idempotent');
  assert.equal(logLines(store).filter(l => l.op === 'archive').length, 2); // the rules once, the request once
  // out of ranking and orientation
  const ranked = rank(store.list(), { query: 'where is fetchRows defined', mode: 'orient' });
  assert.ok(!ranked.some(r => r.note.id === loc.id), 'archived note is not ranked');
  const o = await orient(store, { task: 'where is fetchRows defined', session: 's', client: 'claude' });
  assert.ok(!o.included.some(n => n.id === loc.id) && !o.more.some(n => n.id === loc.id));
  // lookup by its id still answers; lookup by words does not find it
  assert.equal(lookup(store, { query: loc.id }).included[0]?.id, loc.id);
  assert.ok(!lookup(store, { query: 'where is fetchRows defined' }).included.some(n => n.id === loc.id));
  // the edit hook does not serve an archived rule note
  const cc = createNote(store, { title: 'rows go with their index', kind: 'rule', answers: ['what changes with src/a.js'], body: 'src/a.js changes with its index through the generator', deps: [{ path: 'src/a.js' }] }).note;
  archiveNotes(store, { ids: [cc.id] });
  rememberTask(store, 'e1', 'change saveRows and what changes with src/a.js');
  const late = lateNotes(store, { session: 'e1', client: 'claude', files: ['src/a.js'], edited: true });
  assert.ok(!late.included.some(n => n.id === cc.id), 'archived rule note not served on edit');
  // maintenance does not re-verify or phrase it
  for (const id of [loc.id, rule.id]) { const n = store.get(id); n.status = 'stale'; n.stale = { changed: [] }; n.uses = 1; n.lastUsed = new Date().toISOString(); store.put(n); }
  const { stale } = pickStale(store.list(), DEFAULTS);
  assert.deepEqual(stale.map(n => n.id), [rule.id]);
  // review's view: store.list() still carries it (review.js filters only `invalid`)
  assert.ok(store.list().some(n => n.id === loc.id && n.archived));
  // restore
  const back = archiveNotes(store, { restore: true, ids: [loc.id] });
  assert.deepEqual(back.map(d => d.id), [loc.id]); assert.ok(!store.get(loc.id).archived);
  // by request, any kind; archive: false in the config stops the rules but not an explicit id
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: false }));
  const s2 = new Store(store.repo);
  assert.equal(archiveNotes(s2, {}).length, 0);
  assert.equal(archiveNotes(s2, { ids: [rule.id] })[0].reason, 'by request');
}));

test('archived is this checkout\'s state: a shared note keeps its committed file and the state lives in the overlay', () => withEnv({ THINKER_LOG: 'off' }, () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const n = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  // make it a shared (committed) note
  fs.mkdirSync(path.join(store.dir, 'notes'), { recursive: true });
  const shared = JSON.parse(fs.readFileSync(path.join(store.localNotesDir, n.id + '.json'), 'utf8'));
  for (const k of ['status', 'stale', 'uses', 'servedIn']) delete shared[k];
  fs.writeFileSync(path.join(store.dir, 'notes', n.id + '.json'), JSON.stringify(shared, null, 2) + '\n');
  fs.rmSync(path.join(store.localNotesDir, n.id + '.json'));
  git(dir, 'add', '.thinker/notes'); git(dir, 'commit', '-q', '-m', 'share');
  const s2 = new Store(dir);
  assert.ok(s2.isShared(n.id));
  archiveNotes(s2, { kinds: ['map'] });
  assert.ok(s2.get(n.id).archived);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(s2.dir, 'notes', n.id + '.json'), 'utf8')).archived, 'the committed file is untouched');
  assert.equal(git(dir, 'status', '--porcelain', '--', '.thinker/notes'), '', 'nothing to commit');
}));

test('maintenance archives by the rules, counts it, and tells the user once', () => withEnv({ THINKER_LOG: 'off' }, async () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: { kinds: ['map'] } }));
  const r = await maintain(store, dir, { fns: { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async () => ({ done: [], cost: 0 }), } });
  assert.equal(r.archived, 1);
  const { maintenanceNotice, renderMaintain } = await import('../src/maintain.js');
  assert.match(renderMaintain(r), /1 archived/);
  assert.match(maintenanceNotice(store), /1 note archived: kept for review/);
  assert.equal(maintenanceNotice(store), '', 'said once');
  const r2 = await maintain(store, dir, { fns: { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async () => ({ done: [], cost: 0 }), } });
  assert.equal(r2.archived, 0);
}));

test('the archive command lists, archives, dry-runs and restores', () => withEnv({ THINKER_LOG: 'off', THINKER_NO_LEARN: '1' }, () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const n = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: { kinds: ['map'] } }));
  const run = (...a) => execFileSync('node', [CLI, 'archive', ...a, '--repo', dir], { encoding: 'utf8', env: process.env });
  assert.match(run('--dry'), /would archive  .*\[map\]/); assert.ok(!store.get(n.id).archived);
  assert.match(run(), /1 note archived/); assert.ok(new Store(dir).get(n.id).archived);
  assert.match(run('--list'), /map\s+\S+\s+\d{4}-\d\d-\d\d\s+kind map/);
  assert.match(execFileSync('node', [CLI, 'list', '--repo', dir], { encoding: 'utf8', env: process.env }), /archived\s+map/);
  assert.match(run('--restore', n.id), /1 note restored/); assert.ok(!new Store(dir).get(n.id).archived);
}));
