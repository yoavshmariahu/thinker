import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEP_DEFAULT, keepMatcher, namedIn, copyOf, keptCalls, keepPatterns, writeKeep, keepFile, sourcePattern } from '../src/keep.js';
import { cutCandidates, keptOf, transformRequest, proxyConfig } from '../src/proxy.js';
import { responsesCandidates, responsesKept } from '../src/proxy-responses.js';
import { chatCandidates, chatKept } from '../src/proxy-chat.js';
import { delegateTool, DELEGATE_DEFAULTS } from '../src/delegate.js';
import { tidyObservation, extractObservations, keepSources, syncKeep, appendObservations } from '../src/profile.js';
import { Store } from '../src/store.js';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-keep-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const big = (n = 4000, ch = 'x') => ch.repeat(n);

test('a pattern without a slash matches the name, one with a slash the end of the path, and case is ignored', () => {
  const m = keepMatcher(['*.md', 'docs/plan.txt', 'data/**/stats.csv']);
  assert.equal(m('/repo/notes/LEARNINGS.MD'), true);
  assert.equal(m('learnings.md'), true);
  assert.equal(m('notes.mdx'), false, 'an extension that only starts with md is another file');
  assert.equal(m('/repo/docs/plan.txt'), true);
  assert.equal(m('/repo/olddocs/plan.txt'), false, 'a path pattern matches whole segments');
  assert.equal(m('data/2026/11/stats.csv'), true);
  assert.equal(m('data/stats.csv'), true);
  assert.equal(m('src/proxy.js'), false);
  assert.deepEqual(KEEP_DEFAULT, ['*.md']);
});

test('a file is named when its name stands in the person\'s own words, never in what the harness injected', () => {
  const said = namedIn(['read stats.csv. Then look at src/keep.js please', '<system-reminder>Contents of rules.txt: see other.py</system-reminder>']);
  assert.equal(said('/work/stats.csv'), true, 'a full stop after the name is the sentence ending');
  assert.equal(said('/repo/src/keep.js'), true);
  assert.equal(said('other.py'), false, 'a reminder is not the person speaking');
  assert.equal(said('rules.txt'), false);
  assert.equal(said('eep.js'), false, 'part of a name is not the name');
  assert.equal(said('stats.csvx'), false);
  assert.equal(namedIn(['look at the notes'])('notes'), false, 'a bare word names nothing');
});

test('copyOf reads a call by its shape: a read, a ranged read, a write, a shell line that prints a file', () => {
  assert.deepEqual(copyOf('Read', { file_path: '/r/a.md' }), { files: ['/r/a.md'], whole: true });
  assert.deepEqual(copyOf('read', { path: 'a.md', offset: 10, limit: 5 }), { files: ['a.md'], whole: false });
  assert.deepEqual(copyOf('Write', { file_path: '/r/a.md', content: 'x' }), { files: ['/r/a.md'], whole: true });
  assert.equal(copyOf('Edit', { file_path: '/r/a.md', old_string: 'a', new_string: 'b' }), null, 'an edit holds a piece, not the file');
  assert.deepEqual(copyOf('Bash', { command: 'cd /r && cat notes/a.md' }), { files: ['/r/notes/a.md'], whole: true });
  assert.deepEqual(copyOf('Bash', { command: "sed -n '1,40p' a.md" }), { files: ['a.md'], whole: false });
  assert.equal(copyOf('Bash', { command: 'cat a.md | grep x' }), null, 'a trimmed read is the model trimming for itself');
  // Codex: the command is an argv, and a function call's arguments arrive as a JSON string
  assert.deepEqual(copyOf('shell', { command: ['bash', '-lc', 'cat a.md'] }), { files: ['a.md'], whole: true });
  assert.deepEqual(copyOf('exec_command', '{"cmd":"cat a.md"}'), { files: ['a.md'], whole: true });
  assert.equal(copyOf('exec_command', 'not json'), null);
  assert.equal(copyOf('Grep', { pattern: 'x', path: 'src' }), null);
});

test('the newest copy of a kept file stays: by pattern, by the person naming it, by a read after a cut', () => {
  const calls = [
    { id: '1', name: 'Read', input: { file_path: '/r/learn.md' } },
    { id: '2', name: 'Read', input: { file_path: '/r/a.py' } },
    { id: '3', name: 'Read', input: { file_path: '/r/learn.md', offset: 1, limit: 5 } },
    { id: '4', name: 'Bash', input: { command: 'cd /r && cat a.py' } },
    { id: '5', name: 'Read', input: { file_path: '/r/stats.csv' } },
    { id: '6', name: 'Read', input: { file_path: '/r/b.py' } },
  ];
  const k = keptCalls(calls, { prompts: ['what does stats.csv say'], cut: ['2'] });
  assert.deepEqual([...k.ids], ['1', '4', '5']);
  assert.deepEqual(k.files, [
    { file: '/r/learn.md', why: 'pattern', id: '1' },   // the ranged read (3) does not displace the whole one
    { file: '/r/a.py', why: 'reread', id: '4' },        // read again after its copy was cut: kept from then on
    { file: '/r/stats.csv', why: 'named', id: '5' },
  ]);
  // an older copy is not kept once a newer whole one exists: one copy of a file, not ten
  const twice = keptCalls([...calls, { id: '7', name: 'Read', input: { file_path: '/r/learn.md' } }], {});
  assert.deepEqual([...twice.ids], ['7']);
  // a kept copy that was itself cut (before the file was named, say) is gone, and nothing stands in for it
  assert.deepEqual([...keptCalls(calls.slice(0, 1), { cut: ['1'] }).ids], []);
});

test('the clearing mod\'s copy of the rule gives the same answers as keep.js', () => {
  const src = fs.readFileSync(new URL('../src/integrations/claude-clear/hooks/register.tsx', import.meta.url), 'utf8');
  const a = src.indexOf('// keep:begin'), b = src.indexOf('// keep:end');
  assert.ok(a > 0 && b > a, 'the mod marks its copy of the rule');
  const block = src.slice(a, b).replace(/: any/g, '').replace(/^export /gm, '');
  const mod = new Function(`${block}; return { keptCalls, copyOf, keepMatcher, namedIn, KEEP_DEFAULT };`)();
  assert.deepEqual(mod.KEEP_DEFAULT, KEEP_DEFAULT);
  const calls = [
    { id: '1', name: 'Read', input: { file_path: '/r/learn.md' } }, { id: '2', name: 'Read', input: { file_path: '/r/a.py' } },
    { id: '3', name: 'Read', input: { file_path: '/r/learn.md', offset: 1, limit: 5 } }, { id: '4', name: 'Bash', input: { command: 'cd /r && cat a.py' } },
    { id: '5', name: 'shell', input: { command: ['bash', '-lc', 'cat stats.csv'] } }, { id: '6', name: 'Write', input: { file_path: 'out/Plan.MD', content: 'x' } },
    { id: '7', name: 'Bash', input: { command: "sed -n '1,9p' docs/plan.txt" } }, { id: '8', name: 'Bash', input: { command: 'cat a.py | head -3' } },
    { id: '9', name: 'exec_command', input: '{"cmd":"cat \\"my notes.md\\" other.txt"}' }, { id: '10', name: 'Grep', input: { pattern: 'x' } },
  ];
  for (const opts of [
    {}, { cut: ['2'] }, { cut: ['1', '2', '5'] }, { prompts: ['read stats.csv and other.txt'] },
    { patterns: ['*.md', 'docs/plan.txt', '**/a.py'], prompts: ['<system-reminder>stats.csv</system-reminder> go'] },
  ]) {
    const ours = keptCalls(calls, opts), theirs = mod.keptCalls(calls, opts);
    assert.deepEqual([...theirs.ids], [...ours.ids], JSON.stringify(opts));
    assert.deepEqual(theirs.files, ours.files, JSON.stringify(opts));
  }
  for (const c of calls) assert.deepEqual(mod.copyOf(c.name, c.input), copyOf(c.name, c.input), c.id);
  // and the mod hands the set to both of its walks
  assert.match(src, /clearLadder\(messages, \{ keepMin: p\.keepMin, keep: ctx\.keep \?\? null \}\)/);
  assert.match(src, /clearOld\(e\.messages, \{ \.\.\.policy, depth: chosen \?\? Infinity, keep: keptOf\(e\.messages, keepPatterns\) \}\)/);
});

// ---- the three doors ----
const use = (id, name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const res = (id, text = big()) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
const say = text => ({ role: 'user', content: [{ type: 'text', text }] });

test('Messages: a kept result is no candidate, and the row says what the list held back', () => {
  const messages = [
    say('track the posts'), use('a', 'Read', { file_path: '/w/learnings.md' }), res('a'), use('b', 'Read', { file_path: '/w/data.json' }), res('b', big(80000)),
    use('c', 'Bash', { command: 'ls' }), res('c', big(80000)),
    say('next'), use('d', 'Bash', { command: 'ls' }), res('d', 'ok'),
  ];
  const keep = keptOf(messages, [], KEEP_DEFAULT).ids;
  assert.deepEqual([...keep], ['a']);
  const without = cutCandidates(messages, { keepMin: 0 }), withKeep = cutCandidates(messages, { keepMin: 0, keep });
  assert.deepEqual(without.ids, ['c', 'b', 'a']);
  assert.deepEqual(withKeep.ids, ['c', 'b']);
  assert.equal(withKeep.kept.results, 1);
  assert.equal(without.tokens - withKeep.tokens, withKeep.kept.tokens, 'what is kept is exactly what the boundary no longer takes');
  assert.equal(without.kept, undefined);
  // through the door: the notes file survives the cut, the other read does not, and the row carries `kept`
  const cfg = { ...proxyConfig({}, {}), trigger: 1, clearAtLeast: 1, keepMin: 0, cutBreakpoint: false, keepPatterns: KEEP_DEFAULT };
  const out = transformRequest('POST', '/v1/messages', { 'x-claude-code-session-id': 's-keep' }, Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages })), cfg);
  assert.equal(out.injected, true, out.reason);
  assert.equal(out.kept.results, 1);
  const sent = JSON.parse(out.body).messages;
  assert.equal(sent[2].content[0].content, big(), 'learnings.md is still in the prompt');
  assert.match(JSON.stringify(sent[4].content), /removed by thinker after use/);
  assert.match(out.policy, /^r10-/);
  // named in a later prompt: data.json is then kept too
  const named = [...messages.slice(0, 7), say('what was in data.json again?'), ...messages.slice(8)];
  assert.deepEqual([...keptOf(named, [], KEEP_DEFAULT).ids].sort(), ['a', 'b']);
});

test('Responses and Chat: the same rule read off their wire formats', () => {
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'function_call', call_id: 'a', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat learnings.md'] }) },
    { type: 'function_call_output', call_id: 'a', output: big() },
    { type: 'function_call', call_id: 'b', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat data.json'] }) },
    { type: 'function_call_output', call_id: 'b', output: big() },
    { role: 'user', content: 'next' },
  ];
  const rk = responsesKept(input, [], KEEP_DEFAULT).ids;
  assert.deepEqual([...rk], ['a']);
  const rc = responsesCandidates(input, { keepMin: 0, keep: rk });
  assert.deepEqual(rc.ids, ['b']);
  assert.equal(rc.kept.results, 1);
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"learnings.md"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: big() },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read', arguments: '{"path":"data.json"}' } }] },
    { role: 'tool', tool_call_id: 'b', content: big() },
    { role: 'user', content: 'next' },
  ];
  const ck = chatKept(messages, [], KEEP_DEFAULT).ids;
  assert.deepEqual([...ck], ['a']);
  const cc = chatCandidates(messages, { keepMin: 0, keep: ck });
  assert.deepEqual(cc.ids, ['b']);
  assert.equal(cc.kept.results, 1);
});

test('delegation leaves a kept file to the model: a .md, or a file the prompt names, whatever its size', async t => {
  const d = tmp(t);
  const lines = Array.from({ length: 3000 }, (_, i) => `- post ${i}: what worked and what did not\n`).join('');
  const md = path.join(d, 'learnings.md'), csv = path.join(d, 'stats.csv'), py = path.join(d, 'core.py');
  for (const f of [md, csv, py]) fs.writeFileSync(f, lines);
  const cfg = { ...DELEGATE_DEFAULTS, holdout: 0, handoff: false, fallback: true, keepPatterns: KEEP_DEFAULT };
  const st = {}; const state = { update: fn => fn(st) }; const rows = []; let runs = 0;
  const run = async () => { runs++; return { report: 'r', usage: {}, cost: 0, model: 'm', ms: 1 }; };
  const go = (file, prompt) => delegateTool({ ev: { tool_name: 'Read', tool_input: { file_path: file }, prompt_id: 'p1' }, state, session: 's', cwd: d, cfg, log: r => rows.push(r), run, lastPrompt: () => ({ prompt }) });
  assert.equal(await go(md, 'carry on'), null, 'the notes file is read by the model');
  assert.deepEqual([rows.at(-1).declined, rows.at(-1).kept, rows.at(-1).fired], ['kept', 'pattern', false]);
  assert.equal(await go(csv, 'read stats.csv and tell me what changed'), null);
  assert.deepEqual([rows.at(-1).declined, rows.at(-1).kept], ['kept', 'named']);
  assert.equal(runs, 0);
  assert.ok(await go(py, 'carry on'), 'a file nobody pointed at is delegated as before');
  assert.equal(runs, 1);
  // a pattern the profile learned does the same
  assert.equal(await delegateTool({ ev: { tool_name: 'Read', tool_input: { file_path: csv }, prompt_id: 'p2' }, state, session: 's', cwd: d, cfg: { ...cfg, keepPatterns: ['*.md', 'stats.csv'] }, log: r => rows.push(r), run, lastPrompt: () => ({ prompt: 'carry on' }) }), null);
  assert.equal(rows.at(-1).kept, 'pattern');
});

// ---- what the profile learned ----
test('the keep file holds each repository\'s list, and every door reads them together with the defaults', t => {
  const dir = tmp(t);
  assert.deepEqual(keepPatterns({ dir }), KEEP_DEFAULT);
  assert.equal(writeKeep('/repo/a', ['stats.csv', 'notes/plan.txt', 'stats.csv'], { dir }), true);
  assert.equal(writeKeep('/repo/b', ['queue.json'], { dir }), true);
  assert.deepEqual(keepPatterns({ dir }), ['*.md', 'notes/plan.txt', 'stats.csv', 'queue.json']);
  assert.equal(writeKeep('/repo/a', ['notes/plan.txt', 'stats.csv'], { dir }), false, 'the same list is not written again');
  assert.equal(writeKeep('/repo/a', [], { dir }), true, 'an empty list takes the repository out');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(keepFile(dir), 'utf8')).repos), ['/repo/b']);
  assert.deepEqual(keepPatterns({ dir }), ['*.md', 'queue.json']);
  // under THINKER_TEST with no home of its own, a run neither reads nor writes the person's file
  const had = process.env.THINKER_HOME; delete process.env.THINKER_HOME;
  try { assert.equal(keepFile(), null); assert.equal(writeKeep('/repo/x', ['a.txt']), false); assert.deepEqual(keepPatterns(), KEEP_DEFAULT); }
  finally { if (had !== undefined) process.env.THINKER_HOME = had; }
});

test('a source is learned only as the person wrote it, and only where it looks like a file', () => {
  const prompts = ['read learnings.txt motherfucker', 'also check data/ig/stats.csv'];
  assert.equal(sourcePattern('learnings.txt', prompts), 'learnings.txt');
  assert.equal(sourcePattern('`data/ig/stats.csv`.', prompts), 'data/ig/stats.csv');
  assert.equal(sourcePattern('secrets.env', prompts), null, 'not in the person\'s words');
  assert.equal(sourcePattern('the learnings file', prompts), null, 'not a file name');
  assert.equal(sourcePattern('*.txt', ['read *.txt']), null, 'a model does not get to widen the list');
  assert.deepEqual(tidyObservation({ request: 'r', sources: ['a.txt', 'a.txt', ''] }).sources, ['a.txt']);
  assert.equal('sources' in tidyObservation({ request: 'r' }), false);
});

test('the session reader\'s sources reach the ledger checked, and the ledger\'s reach the keep file', async t => {
  const events = [
    { t: 'prompt', text: 'track the IG posts' }, { t: 'say', text: 'Here are three ideas.' },
    { t: 'prompt', text: 'read learnings.txt first, you keep forgetting what worked' }, { t: 'say', text: 'Read it; here is the plan.' },
  ];
  const completeFn = async () => ({ model: 'fake-opus', json: { observations: [{ turn: 1, request: 'track the IG posts', approach: 'suggested ideas', outcome: 'corrected', reaction: 'read learnings.txt first', lesson: 'Read learnings.txt before suggesting', prefs: [], topics: ['ig'], sources: ['learnings.txt', 'invented.txt'] }] } });
  const r = await extractObservations(events, { completeFn, have: ['claude'] });
  assert.deepEqual(r.observations[0].sources, ['learnings.txt'], 'a source the person never wrote is dropped');
  assert.deepEqual(keepSources([{ sources: ['b.txt', 'a.txt'] }, { sources: ['a.txt'] }, {}]), ['a.txt', 'b.txt']);
  const repo = tmp(t), home = tmp(t);
  fs.mkdirSync(path.join(repo, '.git'));
  const store = new Store(repo); store.init?.();
  appendObservations(store, r.observations, { session: 's1', client: 'claude' });
  assert.equal(syncKeep(store, { dir: home }), true);
  assert.deepEqual(keepPatterns({ dir: home }), ['*.md', 'learnings.txt']);
});
