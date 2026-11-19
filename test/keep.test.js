import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEP_DEFAULT, keepMatcher, namedIn, copyOf, keptCalls, keepPatterns, writeKeep, keepFile, sourcePattern, urlKey } from '../src/keep.js';
import { cutCandidates, keptOf, transformRequest, proxyConfig } from '../src/proxy.js';
import { responsesCandidates, responsesKept } from '../src/proxy-responses.js';
import { keptOf as doorKept, clearPlan, clearLadder } from '../src/clear-door.js';
import { placeholder } from '../src/cutting.js';
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

test('a web address is kept as a file is: learned, or named by the person, and it covers what lies under it', () => {
  assert.equal(urlKey('HTTPS://www.Example.com/Insights/#top'), 'example.com/insights');
  const m = keepMatcher(['*.md', 'https://example.com/insights']);
  assert.equal(m('https://example.com/insights'), true);
  assert.equal(m('http://www.example.com/insights/?range=7d'), true, 'another spelling, and a page under it');
  assert.equal(m('https://example.com/insights/posts/42'), true);
  assert.equal(m('https://example.com/insights-old'), false, 'a parent covers whole segments only');
  assert.equal(m('https://example.com/'), false, 'and never the site above it');
  assert.equal(m('https://raw.githubusercontent.com/o/r/main/README.md?x=1'), true, 'a page named like the notes is the notes');
  const said = namedIn(['what does https://example.com/insights say now? (see https://other.io/a.)']);
  assert.equal(said('https://example.com/insights?range=30d'), true);
  assert.equal(said('https://other.io/a'), true, 'the bracket and the full stop are the sentence\'s');
  assert.equal(said('https://example.com/pricing'), false);
  // a fetch is a copy: the fetch tool's, or a curl nothing trims
  assert.deepEqual(copyOf('WebFetch', { url: 'https://example.com/insights', prompt: 'summarise' }), { files: ['https://example.com/insights'], whole: true });
  assert.deepEqual(copyOf('Bash', { command: 'curl -sL "https://example.com/insights?a=1&b=2"' }), { files: ['https://example.com/insights?a=1&b=2'], whole: true });
  assert.equal(copyOf('Bash', { command: 'curl -s https://example.com/insights | jq .data' }), null, 'a trimmed fetch is the model trimming for itself');
  assert.equal(copyOf('WebFetch', { url: 'not a url' }), null);
  // the newest fetch of a learned address stays; the older one is cut as any result is
  const calls = [
    { id: '1', name: 'WebFetch', input: { url: 'https://example.com/insights' } }, { id: '2', name: 'WebFetch', input: { url: 'https://example.com/pricing' } },
    { id: '3', name: 'WebFetch', input: { url: 'https://example.com/insights' } },
  ];
  assert.deepEqual([...keptCalls(calls, { patterns: ['https://example.com/insights'] }).ids], ['3']);
  assert.deepEqual([...keptCalls(calls, { prompts: ['look at https://example.com/pricing'] }).ids], ['2']);
  // learned only as the person wrote it
  assert.equal(sourcePattern('https://example.com/insights.', ['check https://example.com/insights. again']), 'https://example.com/insights');
  assert.equal(sourcePattern('https://example.com/other', ['check https://example.com/insights again']), null);
  assert.equal(sourcePattern('https://example.com/*', ['check https://example.com/* again']), null);
});

test('the desktop door has no copy of the rule: its decision runs keep.js itself', () => {
  // The mod carried its own copy until 2026-11-18, marked off and held to this file by a test, because a mod has no
  // import. The decision is the CLI's now (clear-door.js, asked for with `thinker hook clear`), so there is one rule.
  const src = fs.readFileSync(new URL('../src/integrations/claude-clear/hooks/register.tsx', import.meta.url), 'utf8');
  assert.ok(!src.includes('// keep:begin') && !/\b(keptCalls|keepMatcher|namedIn|copyOf)\b/.test(src), 'no copy of the keep list in the mod');
  const door = fs.readFileSync(new URL('../src/clear-door.js', import.meta.url), 'utf8');
  assert.match(door, /import \{ keptCalls, keepPatterns, KEEP_DEFAULT \} from '.\/keep.js'/);
  // the rows are the mod's (role, text, toolUses, toolResults); a result that is already a placeholder is the cut
  const call = (id, tool, input) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
  const result = (id, text = big()) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] });
  const rows = [
    { role: 'user', text: 'read stats.csv', toolUses: [] },
    call('1', 'Read', { file_path: '/r/learn.md' }), result('1'), call('2', 'Read', { file_path: '/r/a.py' }), result('2', placeholder(9000)),
    call('3', 'Read', { file_path: '/r/stats.csv' }), result('3'), call('4', 'Read', { file_path: '/r/a.py' }), result('4'),
    call('5', 'Read', { file_path: '/r/other.py' }), result('5'),
  ];
  // learn.md by the default pattern, stats.csv because the person named it, a.py because it was read again after a cut
  assert.deepEqual([...doorKept(rows)].sort(), ['1', '3', '4']);
  assert.deepEqual([...doorKept(rows, [])].sort(), ['3', '4'], 'the patterns are the ones handed in');
  // and both of the door's walks leave the set alone
  assert.deepEqual(Object.keys(clearPlan([...rows, { role: 'user', text: 'go on', toolUses: [] }], { keepMin: 0, keep: doorKept(rows) }).replace), ['5']);
  assert.equal(clearLadder([...rows, { role: 'user', text: 'go on', toolUses: [] }], { keepMin: 0, keep: doorKept(rows) }).at(-1).depth, 1);
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
  const cfg = { ...proxyConfig({}, {}), cut: true, trigger: 1, clearAtLeast: 1, keepMin: 0, cutBreakpoint: false, keepPatterns: KEEP_DEFAULT };
  const out = transformRequest('POST', '/v1/messages', { 'x-claude-code-session-id': 's-keep' }, Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages })), cfg);
  assert.equal(out.injected, true, out.reason);
  assert.equal(out.kept.results, 1);
  const sent = JSON.parse(out.body).messages;
  assert.equal(sent[2].content[0].content, big(), 'learnings.md is still in the prompt');
  assert.match(JSON.stringify(sent[4].content), /removed by thinker after use/);
  assert.match(out.policy, /^v\d+\.\d+\.\d+-/);
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

test('the re-read measure replays the list: a kept file was never cut, so reading it again is no re-read', async () => {
  const { rereadsOf } = await import('../src/rereads.js');
  const at = n => Date.parse('2026-11-17T10:00:00Z') + n * 60_000;
  const read = (file, n) => ({ t: 'tool', name: 'Read', input: { file_path: file }, result: big(4000), at: at(n) });
  const events = [
    { t: 'prompt', text: 'track the posts', at: at(0) },
    read('/w/learnings.md', 1), read('/w/a.py', 2), read('/w/x1.py', 3), read('/w/x2.py', 4), read('/w/x3.py', 5),
    { t: 'prompt', text: 'next', at: at(10) },
    read('/w/learnings.md', 12), read('/w/a.py', 13),
  ];
  const cut = [at(11)];
  const kept = rereadsOf({ events, calls: [] }, cut, { patterns: KEEP_DEFAULT });
  assert.equal(kept.reads, 1, 'a.py was cut and read again; learnings.md was kept');
  // without the list both were cut, and both reads are re-reads
  assert.equal(rereadsOf({ events, calls: [] }, cut, { patterns: [] }).reads, 2);
});

test('through the running proxy: the kept result reaches the upstream whole, and the log row says what was held back', async t => {
  const http = await import('node:http');
  const { startProxy } = await import('../src/proxy.js');
  const seen = [];
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'ok' } }], usage })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = tmp(t), logFile = path.join(dir, 'proxy.jsonl');
  const url = `http://127.0.0.1:${upstream.address().port}/api/v1`;
  const proxy = startProxy({ ...proxyConfig({ 'gateway-openrouter': true, cut: true }, {}), trigger: 1, clearAtLeast: 1, keepMin: 0, upstream: url, gateways: { openrouter: { upstream: url } }, keepPatterns: KEEP_DEFAULT },
    { logFile, clearingDir: path.join(dir, 'clearing'), compressionDir: path.join(dir, 'compression') });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); });
  const callOf = (id, file) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] });
  const messages = [
    { role: 'user', content: 'track the posts' }, callOf('a', 'learnings.md'), { role: 'tool', tool_call_id: 'a', content: big(4000, 'n') },
    callOf('b', 'data.json'), { role: 'tool', tool_call_id: 'b', content: big(60000, 'd') }, { role: 'user', content: 'next' },
  ];
  const r = await fetch(`http://127.0.0.1:${proxy.address().port}/openrouter/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer mock-only', 'x-session-id': 'keep-http' }, body: JSON.stringify({ model: 'test-model', messages, stream: true }) });
  await r.text();
  assert.equal(seen[0].messages[2].content, big(4000, 'n'), 'the notes went upstream as they were');
  assert.match(seen[0].messages[4].content, /removed by thinker after use/);
  const row = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.op === 'proxy');
  assert.deepEqual(row.kept, { results: 1, tokens: 1000 }, 'the row carries what the keep list held back');
});
