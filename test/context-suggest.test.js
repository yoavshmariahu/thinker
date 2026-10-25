// The Context view's five highest-leverage changes, put to the person in a session (context-suggest.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { topChanges, scheduleContextSuggestion, contextSuggestOffer, contextSuggestPending, ensureUi, uiFile, SUGGEST } from '../src/context-suggest.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function repo() {
  const r = tmp('thinker-csugg-');
  execFileSync('git', ['init', '-q'], { cwd: r });
  const s = new Store(r); s.init();
  return s;
}
const section = (id, wasted, waste = 'high') => ({ id, file: 'AGENTS.md', title: id, tokens: 2000, wasted, waste, usedShare: 0.1 });
const view = (over = {}) => ({
  days: 30, sessions: 40,
  instructions: { sessions: 40, sections: [section('Releases', 30_000), section('Ports', 9_000, 'medium'), section('Tests', 50_000, 'low'), section('Unknown', null, 'unknown')] },
  skills: [{ name: 'deploy', client: 'claude', key: 'skill:deploy', label: 'deploy skill', used: 1, loaded: 40, wasted: 12_000, waste: 'high' }, { name: 'off-one', client: 'claude', key: 'skill:x', used: 0, loaded: 40, wasted: 99_000, waste: 'high', off: true }],
  tools: [{ name: 'Workflow', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Workflow', label: 'Workflow tool', used: 0, loaded: 40, tokens: 3000, wasted: 20_000, waste: 'high' }],
  outputs: { sessions: 40, tools: [{ name: 'Bash:pytest', compressible: true, compression: null, saveModerate: 25_000, saveHigh: 40_000, perSession: 100_000, perCall: 9000 }, { name: 'Read', compressible: true, compression: 'moderate', saveModerate: 80_000 }, { name: 'mcp:x', compressible: false, saveModerate: 70_000 }] },
  ...over,
});

test('topChanges: the flagged parts by what they save, five at most, nothing off, low, unknown or already compressed', () => {
  const c = topChanges(view());
  assert.deepEqual(c.map(x => x.title), ['AGENTS.md · Releases', 'Bash:pytest output'.replace('Bash:', ''), 'Workflow tool', 'deploy skill', 'AGENTS.md · Ports']);
  assert.deepEqual(c.map(x => x.view), ['instructions', 'outputs', 'builtin', 'custom', 'instructions']);
  assert.equal(topChanges(view(), { max: 2 }).length, 2);
  assert.equal(topChanges(view({ instructions: { sections: [section('Tiny', 100)] }, skills: [], tools: [], outputs: { tools: [] } })).length, 0, 'a saving under minSaving is not worth a line');
});

test('scheduleContextSuggestion: kept for the next prompt, at most weekly, after enough sessions; off by config', async () => {
  const store = repo(), now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(await scheduleContextSuggestion(store, { now, view: view({ sessions: 3 }) }), null, 'too few sessions');
  assert.equal(contextSuggestPending(store), false);
  // looked at daily until there is enough
  assert.equal(await scheduleContextSuggestion(store, { now: now + 3600_000, view: view() }), null, 'not again the same day');
  const c = await scheduleContextSuggestion(store, { now: now + 86400_000, view: view() });
  assert.equal(c.length, 5); assert.equal(contextSuggestPending(store), true);
  const said = contextSuggestOffer(store, { now: now + 86400_000, env: {}, ui: () => 'http://127.0.0.1:4848/', repoId: 'github.com/o/r' });
  assert.match(said, /^<thinker-context-suggestions>/);
  assert.match(said, /http:\/\/127\.0\.0\.1:4848\/#tab=save&view=all&repo=github\.com%2Fo%2Fr/);
  assert.match(said, /1\. AGENTS\.md · Releases: ~1\.2M input tokens over the last 30 days; .*Suggested: Compress \(or: remove\)/);
  assert.match(said, /Do not make any of these changes yourself/);
  assert.equal(contextSuggestOffer(store, { env: {}, ui: () => 'x' }), '', 'said once');
  assert.equal(await scheduleContextSuggestion(store, { now: now + 3 * 86400_000, view: view() }), null, 'weekly');
  assert.equal((await scheduleContextSuggestion(store, { now: now + 9 * 86400_000, view: view() })).length, 5);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { contextSuggest: false } }));
  assert.equal(contextSuggestOffer(store, { env: {}, ui: () => 'x' }), '', 'off by config');
  assert.equal(await scheduleContextSuggestion(store, { now: now + 30 * 86400_000, view: view() }), null);
});

test('contextSuggestOffer: no person at an SDK session; without the page, it names thinker ui', async () => {
  const store = repo();
  await scheduleContextSuggestion(store, { view: view(), force: true });
  assert.equal(contextSuggestOffer(store, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, ui: () => 'x' }), '');
  const said = contextSuggestOffer(store, { env: {}, ui: () => null });
  assert.match(said, /by running `thinker ui`/);
});

test('ensureUi: reuses a running page, else starts one and waits for its address', () => {
  const store = repo(), home = tmp('thinker-csugg-home-'), f = uiFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1/' }));
  let spawned = 0;
  assert.equal(ensureUi(store, { home, spawnFn: () => { spawned++; return {}; } }), 'http://127.0.0.1:1/');
  assert.equal(spawned, 0);
  fs.writeFileSync(f, JSON.stringify({ pid: 999_999_9, url: 'http://127.0.0.1:1/' }));
  const url = ensureUi(store, { home, waitMs: 1000, spawnFn: (bin, args, opts) => { spawned++; assert.deepEqual(args.slice(1), ['ui', '--background']); fs.writeFileSync(f, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:2/' })); return {}; } });
  assert.equal(url, 'http://127.0.0.1:2/'); assert.equal(spawned, 1);
  fs.rmSync(f);
  assert.equal(ensureUi(store, { home, waitMs: 200, spawnFn: () => ({}) }), null, 'nothing came up');
  assert.equal(SUGGEST.max, 5);
});

test('approveChanges: each approved change gets its suggested action; pickChanges reads numbers, keys or all', async () => {
  const { approveChanges, pickChanges } = await import('../src/context-suggest.js');
  const changes = topChanges(view());
  assert.deepEqual(changes.map(c => c.default?.act), ['compress', 'compress', 'off', 'off', 'compress']);
  assert.deepEqual(pickChanges(changes, '1, 3').map(c => c.title), [changes[0].title, changes[2].title]);
  assert.equal(pickChanges(changes, 'all').length, 5);
  assert.deepEqual(pickChanges(changes, changes[1].key), [changes[1]]);
  assert.equal(pickChanges(changes, '').length, 0);
  const store = repo(), calls = [];
  const edit = { previewEdit: async (s, id, action, o) => { calls.push(['preview', id, action]); return { key: id, file: 'AGENTS.md', tokensBefore: 2000, tokensAfter: 700 }; }, applyEdit: (s, key) => { calls.push(['apply', key]); return { said: 'ok' }; } };
  const said = await approveChanges(store, [changes[0], changes[1]], { edit });
  assert.deepEqual(calls, [['preview', 'Releases', 'compress'], ['apply', 'Releases']]);
  assert.match(said[0], /Compressed: ~2k → ~700 tokens in AGENTS\.md, uncommitted/);
  assert.match(said[1], /Compressed from the next tool call/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8')).diet?.tools, { 'Bash:pytest': 'moderate' });
});

test('decisions: approved and dismissed changes are kept as the history and not suggested again for a month', async () => {
  const { approveChanges, dismissChanges, recordReviewed, currentChanges, changeHistory } = await import('../src/context-suggest.js');
  const store = repo(), now = Date.now();
  const v = { ...view(), suggestions: topChanges(view(), { max: 20 }) };
  const top = currentChanges(store, v, { now });
  assert.equal(top.length, 5);
  dismissChanges(store, [top[2]], { now });
  const edit = { previewEdit: async () => ({ key: 'Releases', file: 'AGENTS.md', tokensBefore: 2000, tokensAfter: 700 }), applyEdit: () => ({ said: 'ok' }) };
  await approveChanges(store, [top[0]], { edit });
  recordReviewed(store, top[4], 'Compressed it in AGENTS.md', { now });
  const h = changeHistory(store);
  assert.deepEqual(h.map(e => e.decision), ['applied after review', 'approved', 'dismissed']);
  assert.match(h[1].result, /^Compressed: ~2k → ~700 tokens/);
  assert.deepEqual(currentChanges(store, v, { now }).map(c => c.key).filter(k => [top[0], top[2], top[4]].some(t => t.key === k)), [], 'decided ones are left out');
  assert.equal(currentChanges(store, v, { now: now + 31 * 86400_000 }).length, 5, 'and come back after a month if still flagged');
});

test('the action picked instead of the suggestion: options, totals over the window, and n:act choices', async () => {
  const { approveChanges, pickChanges } = await import('../src/context-suggest.js');
  const cs = topChanges(view());
  assert.deepEqual(cs.map(c => c.options.map(o => o.act)), [['compress', 'remove'], ['compress'], ['off'], ['off'], ['compress', 'remove']]);
  assert.equal(cs[0].total, 30_000 * 40); assert.equal(cs[0].days, 30);
  assert.deepEqual(pickChanges(cs, '1:remove, 2').map(c => c.chosen ?? null), ['remove', null]);
  assert.equal(pickChanges(cs, '3:remove')[0].chosen, undefined, 'an action the change does not have is ignored');
  assert.equal(pickChanges(cs, cs[0].key, { [cs[0].key]: 'remove' })[0].chosen, 'remove');
  const store = repo(), calls = [];
  const edit = { previewEdit: async (s, id, action) => { calls.push(action); return { key: id, file: 'AGENTS.md', tokensBefore: 2000, tokensAfter: 0 }; }, applyEdit: () => ({ said: 'ok' }) };
  const said = await approveChanges(store, pickChanges(cs, '1:remove,2'), { edit });
  assert.deepEqual(calls, ['remove']);
  assert.match(said[0], /Removed/); assert.match(said[1], /Compressed from the next tool call/);
});

test('compress: a rewrite over a third of the section is sent back once with the limit', async () => {
  const { proposeSection, COMPRESS_SYSTEM } = await import('../src/instruction-edit.js');
  const store = repo(), text = `# T\n\n## Big\n\n${'word '.repeat(400)}\n`;
  const asked = [];
  const completeFn = async ({ system, prompt }) => { asked.push({ system, prompt }); return { text: asked.length === 1 ? `## Big\n\n${'word '.repeat(250)}` : `## Big\n\n${'word '.repeat(110)}` }; };
  const p = await proposeSection(store, text, 'big', 'compress', { completeFn });
  assert.equal(asked.length, 2); assert.equal(asked[0].system, COMPRESS_SYSTEM);
  assert.match(asked[1].prompt, /must be at most ~15[01]\./);
  assert.ok(p.next.length < 700);
  asked.length = 0;
  await proposeSection(store, text, 'big', 'compress', { completeFn: async ({ system }) => { asked.push(system); return { text: `## Big\n\n${'word '.repeat(100)}` }; } });
  assert.equal(asked.length, 1, 'no second call once within the limit');
});

test('an output change has one action, and its card says how much smaller compressing makes that tool\'s results here', () => {
  const o = topChanges(view()).find(c => c.kind === 'output');
  assert.deepEqual(o.options.map(x => x.text), ['Compress']);
  assert.match(o.why, /compressed, ~25% smaller$/);
});

test('revert: an output\'s compression goes back off, a section\'s file is written back unless edited since, a dismissal is withdrawn', async () => {
  const { approveChanges, dismissChanges, revertDecision, changeHistory, currentChanges } = await import('../src/context-suggest.js');
  const store = repo(), cs = topChanges(view());
  fs.writeFileSync(path.join(store.repo, 'AGENTS.md'), '# A\n\n## Releases\n\nlong text\n');
  const edit = { previewEdit: async () => ({ key: 'k', file: 'AGENTS.md', files: ['AGENTS.md'], tokensBefore: 2000, tokensAfter: 700 }), applyEdit: () => { fs.writeFileSync(path.join(store.repo, 'AGENTS.md'), '# A\n\n## Releases\n\nshort\n'); return { said: 'ok' }; } };
  const said = await approveChanges(store, [cs[0], cs[1]], { edit });
  assert.deepEqual(said, ['AGENTS.md · Releases: Compressed: ~2k → ~700 tokens in AGENTS.md, uncommitted', 'pytest output: Compressed from the next tool call']);
  dismissChanges(store, [cs[2]]);
  let h = changeHistory(store);
  assert.ok(h.every(e => e.id && e.revertible));
  const cfg = () => JSON.parse(fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8')).diet?.tools || {};
  assert.equal(cfg()['Bash:pytest'], 'moderate');
  assert.match((await revertDecision(store, h.find(e => e.kind === 'output').id)).said, /compression off/);
  assert.equal(cfg()['Bash:pytest'], undefined);
  const sec = h.find(e => e.kind === 'section').id;
  fs.appendFileSync(path.join(store.repo, 'AGENTS.md'), 'my own edit\n');
  assert.match((await revertDecision(store, sec)).error, /changed since/);
  fs.writeFileSync(path.join(store.repo, 'AGENTS.md'), '# A\n\n## Releases\n\nshort\n');
  await revertDecision(store, sec);
  assert.equal(fs.readFileSync(path.join(store.repo, 'AGENTS.md'), 'utf8'), '# A\n\n## Releases\n\nlong text\n');
  assert.equal(currentChanges(store, view()).some(c => c.key === cs[2].key), false);
  await revertDecision(store, h.find(e => e.decision === 'dismissed').id);
  assert.equal(currentChanges(store, view()).some(c => c.key === cs[2].key), true, 'suggested again');
  h = changeHistory(store);
  assert.ok(h.every(e => e.revertedAt && !e.revertible));
  assert.match((await revertDecision(store, h[0].id)).error, /already reverted/);
});

test('history written before ids gets them, and an old switch-off can still be reverted by its key', async () => {
  const { changeHistory } = await import('../src/context-suggest.js');
  const store = repo(), f = path.join(store.dir, 'state', 'context-suggest.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ history: [{ at: new Date().toISOString(), key: 'claude:builtin:Artifact', kind: 'tool', title: 'Artifact tool', decision: 'approved', result: 'Switched off' }] }));
  const [e] = changeHistory(store);
  assert.ok(e.id); assert.equal(e.revertible, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history[0].id, e.id, 'kept');
});

test('allChanges: every part as a row with its actions, whatever its waste; off ones turn back on, outputs take a level', async () => {
  const { allChanges, pickChanges } = await import('../src/context-suggest.js');
  const cs = allChanges(view());
  assert.deepEqual(cs.map(c => c.key).sort(), ['claude:builtin:Workflow', 'claude:skill:deploy', 'claude:skill:x', 'output:Bash:pytest', 'output:Read', 'section:AGENTS.md:Ports', 'section:AGENTS.md:Releases', 'section:AGENTS.md:Tests', 'section:AGENTS.md:Unknown'].sort());
  const by = k => cs.find(c => c.key === k);
  assert.deepEqual(by('section:AGENTS.md:Unknown').options.map(o => o.act), ['compress', 'remove']); assert.equal(by('section:AGENTS.md:Unknown').saving, 0);
  assert.deepEqual(by('claude:skill:x').options.map(o => o.act), ['on'], 'switched off: back on');
  // one level of compression (moderate): Compress, or No compression once compressed at any level; never High (the owner's
  // call of 2026-10-22: a person cannot pick between two levels nothing has measured against each other)
  assert.deepEqual(by('output:Bash:pytest').options.map(o => o.act), ['compress']);
  assert.deepEqual(by('output:Read').options.map(o => o.act), ['uncompress'], 'already moderate');
  assert.deepEqual(allChanges(view({ outputs: { sessions: 40, tools: [{ name: 'Read', compressible: true, compression: 'high', saveModerate: 1 }] } })).find(c => c.key === 'output:Read').options.map(o => o.act), ['uncompress'], 'set high from the command line: still one way back');
  assert.equal(cs.some(c => c.options.some(o => o.act === 'high')), false);
  assert.equal(cs.some(c => c.key === 'output:mcp:x'), false, 'nothing thinker can compress is not a change');
  // a built-in tool is switched off from its row like any tool (the page asks first), and is marked as built-in
  assert.deepEqual(by('claude:builtin:Workflow').options.map(o => o.act), ['off']); assert.equal(by('claude:builtin:Workflow').builtin, true);
  // an MCP server: the same two states
  const mcp = allChanges(view({ outputs: { sessions: 40, tools: [{ name: 'mcp:y', compressible: true, compression: null, saveModerate: 1000, perSession: 5000 }, { name: 'mcp:z', compressible: true, compression: 'moderate', saveModerate: 1000, perSession: 5000 }] } }));
  assert.deepEqual(mcp.filter(c => c.kind === 'output').map(c => [c.key, c.options.map(o => o.act)]), [['output:mcp:y', ['compress']], ['output:mcp:z', ['uncompress']]]);
  // the page names a row by its key, as a list: `output:Read` is a key, not a choice with an action after its colon
  assert.deepEqual(pickChanges(cs, ['output:Read'], { 'output:Read': 'uncompress' }).map(c => [c.key, c.chosen]), [['output:Read', 'uncompress']]);
  assert.equal(pickChanges(cs, 'output:Read').length, 0, 'the string form reads it as output + Read');
});

test('approve from a row: turn back on, a compression level, and each reverted to what it was', async () => {
  const { allChanges, approveChanges, revertDecision, changeHistory } = await import('../src/context-suggest.js');
  const store = repo(), cs = allChanges(view()), by = k => cs.find(c => c.key === k);
  const cfg = () => JSON.parse(fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8')).diet?.tools || {};
  // pytest off: compressed (moderate), then reverted to off; Read moderate: compression off, reverted to moderate
  const { setOutputCompression } = await import('../src/context-view.js');
  setOutputCompression(store, ['Read'], 'moderate');
  let said = await approveChanges(store, [{ ...by('output:Bash:pytest'), chosen: 'compress' }, { ...by('output:Read'), chosen: 'uncompress' }]);
  assert.deepEqual(said, ['pytest output: Compressed from the next tool call', 'Read output: Compression off from the next tool call']);
  assert.deepEqual(cfg(), { 'Bash:pytest': 'moderate' });
  const h = changeHistory(store);
  assert.match((await revertDecision(store, h.find(e => e.key === 'output:Read').id)).said, /moderate compression again/);
  assert.match((await revertDecision(store, h.find(e => e.key === 'output:Bash:pytest').id)).said, /compression off/);
  assert.deepEqual(cfg(), { Read: 'moderate' });
  // a level the command line set (high) is kept by Revert as it was
  setOutputCompression(store, ['Bash:pytest'], 'high');
  const hi = allChanges(view({ outputs: { sessions: 40, tools: [{ name: 'Bash:pytest', compressible: true, compression: 'high', saveModerate: 1, perSession: 10 }] } })).find(c => c.key === 'output:Bash:pytest');
  assert.deepEqual(hi.options.map(o => o.act), ['uncompress']);
  await approveChanges(store, [hi]);
  assert.deepEqual(cfg(), { Read: 'moderate' });
  assert.match((await revertDecision(store, changeHistory(store)[0].id)).said, /high compression again/);
  assert.deepEqual(cfg(), { Read: 'moderate', 'Bash:pytest': 'high' });
  setOutputCompression(store, ['Bash:pytest'], null);
  said = await approveChanges(store, [{ ...by('output:Read'), chosen: 'uncompress' }]);
  assert.match(said[0], /Compression off from the next tool call/); assert.deepEqual(cfg(), {});
  // nothing switched off here to turn back on: the harness says so, nothing is recorded
  said = await approveChanges(store, [by('claude:skill:x')]);
  assert.equal(said.length, 1); assert.equal(changeHistory(store).filter(e => e.key === 'claude:skill:x').length, 0);
});

test('a section job without a pull request: recorded running at once, the command started detached, the file written with its undo; a Revert on one row puts it back for all; a dead or failed job is failed, retried by the same command', async () => {
  const { allChanges, startSectionJob, runSectionJob, retryJob, revertDecision, changeHistory, currentChanges } = await import('../src/context-suggest.js');
  const store = repo(), cs = allChanges(view()), f = path.join(store.repo, 'AGENTS.md'), now = Date.parse('2026-10-24T10:00:00Z');
  fs.writeFileSync(f, '# A\n\n## Releases\n\nlong text\n\n## Ports\n\nmore\n');
  const picked = cs.filter(c => ['section:AGENTS.md:Releases', 'section:AGENTS.md:Ports'].includes(c.key));
  // Apply: the entries are recorded running and `thinker instructions --compress Releases,Ports --apply --job <group>` is started detached
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: process.pid, on() {}, unref() {} }; };
  const r = startSectionJob(store, picked, 'compress', { pr: false, now, spawnFn, cliPath: '/x/cli.js' });
  assert.match(r.said, /^Compressing 2 sections in the background: the file in your working tree is rewritten when the model is done\. Follow it under Recent activity\.$/);
  assert.equal(spawned.length, 1); assert.equal(spawned[0].cmd, process.execPath);
  assert.deepEqual(spawned[0].args, ['/x/cli.js', 'instructions', '--compress', 'Releases,Ports', '--apply', '--job', r.group]);
  assert.equal(spawned[0].opts.cwd, store.repo); assert.equal(spawned[0].opts.detached, true);
  // one line item a section, never "2 sections: …": each with its own title and saving, sharing the job
  let hs = changeHistory(store, { now });
  assert.equal(hs.length, 2);
  assert.deepEqual(hs.map(e => e.key), picked.map(c => c.key)); assert.deepEqual(hs.map(e => e.section), ['Releases', 'Ports']); assert.deepEqual(hs.map(e => e.saving), picked.map(c => c.saving));
  for (const e of hs) { assert.equal(e.running, true); assert.equal(e.attention, 'running'); assert.equal(e.revertible, false); assert.equal(e.retryable, false); assert.equal(e.group, r.group); assert.equal(e.job.pid, process.pid); assert.equal(e.decision, 'applied'); assert.equal(e.act, 'compress'); assert.equal(e.action, 'Compress'); assert.doesNotMatch(e.title, /sections:/); }
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'under way: not suggested');
  // the command's side (`--job`): the preview, the file written, the entries finished with the file as it was for Revert
  const edit = { previewEdit: async (s, ids, action) => { assert.deepEqual(ids, ['Releases', 'Ports']); assert.equal(action, 'compress'); return { key: 'bulk', files: ['AGENTS.md'], file: 'AGENTS.md', modelTokens: 1234 }; }, applyEdit: (s, key) => { assert.equal(key, 'bulk'); fs.writeFileSync(f, '# A\n\n## Releases\n\nshort\n\n## Ports\n\nless\n'); return { said: 'Compressed 2 sections in AGENTS.md' }; } };
  const done = await runSectionJob(store, { group: r.group, ids: ['Releases', 'Ports'], action: 'compress', pr: false }, { now: now + 9000, edit });
  assert.equal(done.said, 'Compressed 2 sections in AGENTS.md');
  hs = changeHistory(store, { now });
  for (const e of hs) { assert.equal(e.running, false); assert.equal(e.failed, false); assert.equal(e.attention, null); assert.equal(e.revertible, true); assert.equal(e.job.state, 'done'); assert.equal(e.job.tokens, 1234); assert.equal(e.job.finishedAt, '2026-10-24T10:00:09.000Z'); assert.equal(e.result, 'Compressed 2 sections in AGENTS.md'); assert.equal(e.days, 30); }
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Ports'), false, 'decided: not suggested for a month');
  // reverting either row writes the file back, which takes the other section with it: both are marked reverted
  const r2 = await revertDecision(store, hs[1].id);
  assert.match(r2.said, /written back as it was, with the other section of the same change \(/);
  assert.equal(fs.readFileSync(f, 'utf8'), '# A\n\n## Releases\n\nlong text\n\n## Ports\n\nmore\n');
  for (const e of changeHistory(store)) { assert.ok(e.revertedAt); assert.equal(e.revertible, false); }
  assert.match((await revertDecision(store, hs[0].id)).error, /already reverted/);
  // a group the page never recorded: no job
  assert.match((await runSectionJob(store, { group: 'nope', ids: ['Releases'], action: 'compress' })).error, /no job nope/);
  // a job whose process is gone before it finished is failed, once it is read, and the section is suggested again (in a
  // repository where nothing was decided on it before: a reverted edit still counts as decided for a month)
  const store2 = repo(), f2 = path.join(store2.repo, 'AGENTS.md'); fs.writeFileSync(f2, 'x\n');
  const dead = startSectionJob(store2, [picked[0]], 'compress', { pr: false, now, spawnFn: () => ({ pid: 2 ** 22 - 1, on() {}, unref() {} }), cliPath: '/x/cli.js' });
  const [d] = changeHistory(store2, { now });
  assert.equal(d.failed, true); assert.equal(d.retryable, true); assert.equal(d.attention, 'failed'); assert.equal(d.revertible, false); assert.match(d.job.error, /process ended before it finished/);
  assert.equal(currentChanges(store2, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), true, 'failed: suggested again');
  // one that never recorded a process is failed after a while
  const unborn = startSectionJob(store2, [picked[1]], 'remove', { pr: false, now, spawnFn: () => ({ on() {}, unref() {} }), cliPath: '/x/cli.js' });
  assert.equal(changeHistory(store2, { now: now + 60_000 }).find(e => e.group === unborn.group).running, true);
  assert.match(changeHistory(store2, { now: now + 3 * 60_000 }).find(e => e.group === unborn.group).job.error, /did not start/);
  // Retry runs the same command again, over every section of the change
  const again = [];
  const rr = retryJob(store2, d.id, { now: now + 1000, spawnFn: (c, args) => { again.push(args); return { pid: process.pid, on() {}, unref() {} }; }, cliPath: '/x/cli.js' });
  assert.match(rr.said, /compressing again in the background$/);
  assert.deepEqual(again, [['/x/cli.js', 'instructions', '--compress', 'Releases', '--apply', '--job', dead.group]]);
  const d2 = changeHistory(store2, { now }).find(e => e.group === dead.group);
  assert.equal(d2.running, true); assert.equal(d2.job.tries, 2);
  assert.match(retryJob(store2, d2.id, { now }).error, /still running/);
  assert.match(retryJob(store, hs[0].id, { now }).error, /nothing to retry/);
  // the command fails (the model returned nothing): recorded as failed with the reason, nothing written
  const bad = await runSectionJob(store2, { group: dead.group, ids: ['Releases'], action: 'compress' }, { now, edit: { previewEdit: async () => ({ error: 'the model returned nothing' }), applyEdit: () => ({}) } });
  assert.equal(bad.error, 'the model returned nothing');
  const d3 = changeHistory(store2, { now }).find(e => e.group === dead.group);
  assert.equal(d3.failed, true); assert.equal(d3.job.error, 'the model returned nothing'); assert.equal(fs.readFileSync(f2, 'utf8'), 'x\n');
  // nothing to change: refused before anything is recorded or started
  assert.match(startSectionJob(store2, [], 'compress', { spawnFn }).error, /no section/);
  assert.match(startSectionJob(store2, picked, 'off', { spawnFn }).error, /no section/);
  assert.equal(changeHistory(store2).length, 2);
});

test('an output measured under an earlier setting is a comparison, not a change; the current row counts its own sessions', async () => {
  const { allChanges } = await import('../src/context-suggest.js');
  const v = view({ outputs: { sessions: 40, tools: [
    { name: 'Bash:sed', level: null, past: true, sessions: 30, compressible: true, compression: 'moderate', saveModerate: 50_000, perSession: 900_000, perCall: 1000 },
    { name: 'Bash:sed', level: 'moderate', past: false, sessions: 10, compressible: true, compression: 'moderate', saveModerate: 1000, perSession: 400_000, perCall: 600 },
  ] } });
  const all = allChanges(v).filter(c => c.kind === 'output');
  assert.deepEqual(all.map(c => [c.key, c.sessions, c.total, c.options.map(o => o.act)]), [['output:Bash:sed', 10, 10_000, ['uncompress']]]);
  assert.equal(topChanges(v).some(c => c.kind === 'output'), false, 'nothing to compress: the past row is not offered, the current one is compressed');
});

test('a section job with a pull request: the decision is pending until merged; closed, it is rejected and suggested again; Close PR is its revert; a failed pull request is retried', async () => {
  const { allChanges, startSectionJob, runSectionJob, revertDecision, changeHistory, currentChanges, refreshPrStates } = await import('../src/context-suggest.js');
  const store = repo(), cs = allChanges(view()), now = Date.parse('2026-10-24T10:00:00Z');
  const picked = cs.filter(c => ['section:AGENTS.md:Releases', 'section:AGENTS.md:Ports'].includes(c.key));
  const opened = [], closed = [];
  const prs = {
    openEditPr: async (s, key, o) => { opened.push([key, o.changes.length]); return { number: 7, url: 'https://github.com/o/r/pull/7', branch: 'thinker/context-20261024-abc', commit: 'c0ffee', base: 'main', said: 'Pull request #7 opened: https://github.com/o/r/pull/7' }; },
    prState: (r, n) => prs.state(n),
    closePr: (r, n, o) => { closed.push([n, o.branch]); return { ok: true }; },
    state: () => ({ state: 'open', at: null }),
  };
  const spawnFn = () => ({ pid: process.pid, on() {}, unref() {} });
  const edit = { previewEdit: async (s, ids) => ({ key: ids.join('+'), files: ['AGENTS.md'], file: 'AGENTS.md' }), applyEdit: () => ({ error: 'not this way' }) };
  // Apply, then the command it started: one pull request for both sections, a row each
  const job = (changes, t) => { const s = startSectionJob(store, changes, 'compress', { pr: true, now: t, spawnFn, cliPath: '/x/cli.js' }); return runSectionJob(store, { group: s.group, ids: changes.map(c => c.id), action: 'compress', pr: true }, { now: t, edit, prs }); };
  const r = await job(picked, now);
  assert.equal(r.said, 'Pull request #7 opened: https://github.com/o/r/pull/7');
  assert.deepEqual(opened, [['Releases+Ports', 2]]);
  // the two sections are a row each, both pending on the one pull request
  let hs = changeHistory(store);
  assert.equal(hs.length, 2); assert.deepEqual(hs.map(e => e.key), picked.map(c => c.key)); assert.deepEqual(hs.map(e => e.saving), picked.map(c => c.saving));
  for (const e of hs) {
    assert.equal(e.decision, 'pull request'); assert.equal(e.pending, true); assert.equal(e.attention, 'pr'); assert.equal(e.running, false); assert.equal(e.rejected, false); assert.equal(e.revertible, true, 'Close PR'); assert.doesNotMatch(e.title, /sections:/);
    assert.deepEqual({ ...e.pr, checkedAt: undefined }, { number: 7, url: 'https://github.com/o/r/pull/7', branch: 'thinker/context-20261024-abc', commit: 'c0ffee', base: 'main', state: 'open', openedAt: '2026-10-24T10:00:00.000Z', checkedAt: undefined });
  }
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'pending: not suggested');
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Ports'), false, 'pending: not suggested');
  // still open: nothing changes, GitHub is asked once for the pull request however many rows it has, and not again within a minute
  let asked = 0; prs.state = () => { asked++; return { state: 'open' }; };
  assert.equal(await refreshPrStates(store, { now: now + 61_000, prs }), 0); assert.equal(asked, 1);
  assert.equal(await refreshPrStates(store, { now: now + 90_000, prs }), 0); assert.equal(asked, 1, 'a minute apart at most');
  assert.equal(await refreshPrStates(store, { now: now + 90_000, prs, force: true }), 0); assert.equal(asked, 2);
  // GitHub cannot be asked: the state is kept
  prs.state = () => null;
  assert.equal(await refreshPrStates(store, { now: now + 200_000, prs }), 0);
  assert.equal(changeHistory(store)[0].pending, true);
  // closed without merging: both rows rejected, both sections suggested again, nothing left to revert
  prs.state = () => ({ state: 'closed', at: '2026-10-24T11:00:00Z' });
  assert.equal(await refreshPrStates(store, { now: now + 300_000, prs }), 2);
  hs = changeHistory(store);
  for (const e of hs) { assert.equal(e.rejected, true); assert.equal(e.pending, false); assert.equal(e.revertible, false); assert.equal(e.pr.state, 'closed'); assert.equal(e.pr.at, '2026-10-24T11:00:00Z'); assert.match(e.result, /closed without merging: suggested again/); }
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), true, 'rejected: suggested again');
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Ports'), true, 'rejected: suggested again');
  assert.match((await revertDecision(store, hs[0].id, { prs })).error, /pull request #7 is closed/);
  assert.equal(await refreshPrStates(store, { now: now + 400_000, prs }), 0, 'no open pull request left to ask after');

  // a second pull request, merged: done, not suggested; a third, closed from History
  await job([picked[0]], now + 1000);
  prs.state = () => ({ state: 'merged', at: '2026-10-24T12:00:00Z', commit: 'm1' });
  assert.equal(await refreshPrStates(store, { now: now + 100_000, prs }), 1);
  assert.equal(changeHistory(store)[0].pr.state, 'merged'); assert.equal(changeHistory(store)[0].revertible, false);
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'merged: decided');
  // the merge commit GitHub named is kept; a checkout without it says so (`unpulled`): the section is still in the file
  // there, and its row says Merged instead of coming back as a suggestion
  assert.equal(changeHistory(store)[0].pr.mergeCommit, 'm1');
  const gitCalls = [];
  let m = changeHistory(store, { now, git: (r, c) => { gitCalls.push([r, c]); return false; } })[0];
  assert.equal(m.unpulled, true); assert.equal(m.pullFrom, 'main', "the pull request's base"); assert.deepEqual(gitCalls, [[store.repo, 'm1']]);
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'merged, unpulled: decided');
  // git cannot answer: not marked; pulled once: kept, and git is not asked again
  assert.equal(changeHistory(store, { now, git: () => null })[0].unpulled, undefined);
  m = changeHistory(store, { now, git: () => true })[0]; assert.equal(m.unpulled, undefined); assert.ok(m.pr.pulledAt);
  assert.equal(changeHistory(store, { now, git: () => { throw new Error('not asked again'); } })[0].unpulled, undefined);
  await job([picked[1]], now + 2000);
  const third = changeHistory(store)[0];
  assert.ok(third.group, 'a job is a group, one section or several');
  assert.match((await revertDecision(store, third.id, { now: now + 3000, prs })).said, /pull request #7 closed; suggested again$/);
  assert.deepEqual(closed, [[7, 'thinker/context-20261024-abc']]);
  const after = changeHistory(store)[0];
  assert.equal(after.pr.state, 'closed'); assert.equal(after.rejected, true); assert.ok(after.revertedAt);
  assert.match((await revertDecision(store, third.id, { prs })).error, /already reverted/);
  // a fourth over both sections, closed from History on one row: the pull request is one, so the other row is closed too
  prs.openEditPr = async () => ({ number: 8, url: 'https://github.com/o/r/pull/8', branch: 'thinker/context-8', commit: 'c1', base: 'main', said: 'Pull request #8 opened' });
  await job(picked, now + 4000);
  const [r1, r2] = changeHistory(store);
  assert.equal(r1.pr.number, 8); assert.equal(r2.pr.number, 8); assert.equal(r1.group, r2.group);
  assert.match((await revertDecision(store, r2.id, { now: now + 5000, prs })).said, /pull request #8 closed; suggested again, with the other section of the same change \(Releases\)/);
  assert.deepEqual(closed[1], [8, 'thinker/context-8']);
  for (const e of changeHistory(store).slice(0, 2)) { assert.equal(e.pr.state, 'closed'); assert.equal(e.rejected, true); assert.ok(e.revertedAt); assert.equal(e.revertible, false); }
  // the pull request's failure: the job is failed with the reason, Retry offered, no pull request on it
  prs.openEditPr = async () => ({ error: 'could not push' });
  assert.equal((await job([picked[0]], now + 6000)).error, 'could not push');
  const [failed] = changeHistory(store, { now });
  assert.equal(failed.failed, true); assert.equal(failed.job.error, 'could not push'); assert.equal(failed.retryable, true); assert.equal(failed.pr, undefined); assert.equal(failed.attention, 'failed');
  assert.equal(changeHistory(store).length, 7);
});

test('describePart: a built-in tool is told from a custom one, and the thing a decision changed gets one line of what it does', async () => {
  const { describePart } = await import('../src/part-describe.js');
  const { allChanges, approveChanges, changeHistory } = await import('../src/context-suggest.js');
  assert.deepEqual(describePart({ kind: 'tool', name: 'Grep', builtin: true }), { what: 'Built-in tool', about: 'text search over files' });
  assert.deepEqual(describePart({ kind: 'tool', name: 'x', toolKind: 'mcp', text: 'Browser automation for Chrome. Clicks and reads pages.' }), { what: 'Custom tool · MCP server', about: 'Browser automation for Chrome.' });
  assert.deepEqual(describePart({ kind: 'tool', name: 'p', toolKind: 'plugin' }), { what: 'Custom tool · plugin', about: '' });
  assert.deepEqual(describePart({ kind: 'output', name: 'Bash:grep -rn foo src' }), { what: 'Shell command output', about: 'text search over files' });
  assert.deepEqual(describePart({ kind: 'output', name: 'Bash:FOO=1 ./node_modules/.bin/pytest -q' }), { what: 'Shell command output', about: 'runs the Python tests' });
  assert.deepEqual(describePart({ kind: 'output', name: 'Read' }), { what: 'Built-in tool output', about: 'reads a file' });
  assert.deepEqual(describePart({ kind: 'output', name: 'mcp:x', text: 'Artemis: benchmark experiments. More.' }), { what: 'Custom tool output · MCP server', about: 'Artemis: benchmark experiments.' });
  assert.deepEqual(describePart({ kind: 'skill', text: '---\nname: deploy\ndescription: Deploys the site to S3\n---\n# Deploy\nSteps.' }), { what: 'Custom tool · skill', about: 'Deploys the site to S3' });
  assert.deepEqual(describePart({ kind: 'section', text: '## Ports\nAlways reserve a port first. Never hardcode.' }), { what: 'Instruction section', about: 'Always reserve a port first.' });
  assert.equal(describePart({ kind: 'tool', name: 'Unknown', builtin: true, text: 'Does a thing <b>well</b>. And more.' }).about, 'Does a thing well.', 'a tool the table does not know: the first sentence of its definition');
  assert.match(describePart({ kind: 'section', text: 'x'.repeat(50) + ' ' + 'y'.repeat(100) + ' z. More.' }).about, /…$/, 'a long first sentence is cut');
  // the rows carry them, the decision keeps them
  const cs = allChanges(view()), by = k => cs.find(c => c.key === k);
  assert.deepEqual([by('claude:builtin:Workflow').what, by('claude:builtin:Workflow').about], ['Built-in tool', 'orchestrates subagents by a script']);
  assert.deepEqual([by('output:Bash:pytest').what, by('output:Bash:pytest').about], ['Shell command output', 'runs the Python tests']);
  assert.deepEqual([by('output:Read').what, by('output:Read').about], ['Built-in tool output', 'reads a file']);
  assert.equal(by('claude:skill:deploy').what, 'Custom tool · skill');
  assert.equal(by('section:AGENTS.md:Releases').what, 'Instruction section');
  const store = repo();
  await approveChanges(store, [by('output:Bash:pytest')]);
  const [e] = changeHistory(store);
  assert.deepEqual([e.what, e.about], ['Shell command output', 'runs the Python tests']);
  assert.deepEqual([JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'context-suggest.json'), 'utf8')).history[0].what], ['Shell command output'], 'kept on the entry');
  // an entry written before `what` and `about` were kept is described from its kind and key
  const f = path.join(store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.history.push({ at: new Date().toISOString(), key: 'claude:builtin:Artifact', kind: 'tool', title: 'Artifact tool', decision: 'approved', result: 'Switched off' }, { at: new Date().toISOString(), key: 'claude:mcp:artemis', kind: 'tool', title: 'artemis MCP server', decision: 'approved', result: 'Switched off' }, { at: new Date().toISOString(), key: 'output:mcp:chrome', kind: 'output', title: 'chrome output', decision: 'approved' });
  fs.writeFileSync(f, JSON.stringify(st));
  const hs = changeHistory(store);
  assert.deepEqual(hs.map(x => [x.what, x.about]), [['Shell command output', 'runs the Python tests'], ['Built-in tool', 'drafts a document or page'], ['Custom tool · MCP server', ''], ['Custom tool output · MCP server', '']]);
});

test('a merged pull request from before the merge commit was kept: GitHub is asked for it once; a removal is unpulled while its section is still in the file', async () => {
  const { changeHistory, refreshPrStates } = await import('../src/context-suggest.js');
  const store = repo(), now = Date.parse('2026-10-25T10:00:00Z');
  const entry = (id, key, act, pr = {}) => ({ id, at: '2026-10-25T03:59:27Z', key, kind: 'section', title: key, file: 'AGENTS.md', act, decision: 'pull request', pr: { number: 475, state: 'merged', at: '2026-10-25T04:00:16Z', ...pr } });
  // no base on the entry: the branch to pull is the repository's default branch, master here
  execFileSync('git', ['-C', store.repo, 'checkout', '-q', '-b', 'master'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(store.repo, 'README.md'), 'x'); execFileSync('git', ['-C', store.repo, 'add', 'README.md']); execFileSync('git', ['-C', store.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [entry('a', 'section:AGENTS.md:serving', 'remove'), entry('b', 'section:AGENTS.md:context-view', 'compress'), entry('c', 'section:AGENTS.md:old', 'remove', { at: '2026-08-01T00:00:00Z' })] }));
  fs.writeFileSync(path.join(store.repo, 'AGENTS.md'), '# x\n\n## Serving\n\nnotes\n\n## Context view\n\nreport\n');
  // without the commit: a removal is unpulled while its section is in the file; a compression cannot be told; a month-old one is left
  let hs = changeHistory(store, { now, git: () => { throw new Error('no commit to ask by'); } });
  assert.equal(hs[0].unpulled, true); assert.equal(hs[0].pullFrom, 'master', 'the default branch, whatever it is called'); assert.equal(hs[1].unpulled, undefined); assert.equal(hs[2].unpulled, undefined);
  fs.writeFileSync(path.join(store.repo, 'AGENTS.md'), '# x\n\n## Context view\n\nreport\n');
  hs = changeHistory(store, { now }); assert.equal(hs[0].unpulled, undefined); assert.ok(hs[0].pr.pulledAt, 'the section is gone from the file here: pulled, and kept so');
  // GitHub is asked once for the merge commit of the entries that lack it (not the old one), and not again once it answered
  let asked = 0; const prs = { prState: () => { asked++; return asked === 1 ? null : { state: 'merged', at: '2026-10-25T04:00:16Z', commit: 'abc' }; } };
  assert.equal(await refreshPrStates(store, { now, prs }), 0); assert.equal(asked, 1, 'one pull request, asked once');
  assert.equal(changeHistory(store, { now, git: () => false })[1].pr.mergeCommit, undefined, 'no answer: asked again later');
  assert.equal(await refreshPrStates(store, { now: now + 61_000, prs }), 0); assert.equal(asked, 2);
  hs = changeHistory(store, { now, git: () => false });
  assert.equal(hs[0].pr.mergeCommit, 'abc'); assert.equal(hs[1].pr.mergeCommit, 'abc'); assert.equal(hs[2].pr.mergeCommit, undefined);
  assert.equal(hs[1].unpulled, true, 'the compression is told by the commit now');
  assert.equal(await refreshPrStates(store, { now: now + 200_000, prs }), 0); assert.equal(asked, 2, 'not asked again');
});
