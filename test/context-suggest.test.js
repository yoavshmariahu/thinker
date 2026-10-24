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

test('applyReviewed: a section written after its diff was read is recorded with the file as it was, so Revert puts it back', async () => {
  const { allChanges, applyReviewed, revertDecision, changeHistory, currentChanges } = await import('../src/context-suggest.js');
  const store = repo(), cs = allChanges(view()), f = path.join(store.repo, 'AGENTS.md');
  fs.writeFileSync(f, '# A\n\n## Releases\n\nlong text\n\n## Ports\n\nmore\n');
  const edit = { applyEdit: (s, key) => { assert.equal(key, 'bulk'); fs.writeFileSync(f, '# A\n\n## Releases\n\nshort\n\n## Ports\n\nless\n'); return { said: 'Compressed 2 sections in AGENTS.md' }; } };
  const picked = cs.filter(c => ['section:AGENTS.md:Releases', 'section:AGENTS.md:Ports'].includes(c.key));
  const r = await applyReviewed(store, picked, 'bulk', ['AGENTS.md'], { edit });
  assert.equal(r.said, 'Compressed 2 sections in AGENTS.md');
  const [e] = changeHistory(store);
  assert.equal(e.decision, 'applied after review'); assert.equal(e.revertible, true); assert.equal(e.days, 30);
  assert.match(e.title, /^2 sections: Releases, Ports$/); assert.deepEqual(e.keys, picked.map(c => c.key));
  assert.equal(e.saving, 39_000, 'the sections\' savings together');
  assert.equal(currentChanges(store, view()).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'decided: not suggested for a month');
  assert.match((await revertDecision(store, e.id)).said, /written back as it was/);
  assert.equal(fs.readFileSync(f, 'utf8'), '# A\n\n## Releases\n\nlong text\n\n## Ports\n\nmore\n');
  // the real applyEdit refuses without a preview, and nothing is recorded then
  assert.match((await applyReviewed(store, [picked[0]], 'nope', ['AGENTS.md'])).error, /preview the change first/);
  assert.equal(changeHistory(store).length, 1);
});

test('applyReviewed with pr: the decision is a pull request, pending until merged; closed, it is rejected and suggested again; Close PR is its revert', async () => {
  const { allChanges, applyReviewed, revertDecision, changeHistory, currentChanges, refreshPrStates } = await import('../src/context-suggest.js');
  const store = repo(), cs = allChanges(view()), now = Date.parse('2026-10-24T10:00:00Z');
  const picked = cs.filter(c => ['section:AGENTS.md:Releases', 'section:AGENTS.md:Ports'].includes(c.key));
  const opened = [], closed = [];
  const prs = {
    openEditPr: async (s, key, o) => { opened.push([key, o.changes.length]); return { number: 7, url: 'https://github.com/o/r/pull/7', branch: 'thinker/context-20261024-abc', commit: 'c0ffee', base: 'main', said: 'Pull request #7 opened: https://github.com/o/r/pull/7' }; },
    prState: (r, n) => prs.state(n),
    closePr: (r, n, o) => { closed.push([n, o.branch]); return { ok: true }; },
    state: () => ({ state: 'open', at: null }),
  };
  const r = await applyReviewed(store, picked, 'bulk', ['AGENTS.md'], { now, pr: true, prs });
  assert.equal(r.said, 'Pull request #7 opened: https://github.com/o/r/pull/7');
  assert.deepEqual(opened, [['bulk', 2]]);
  let [e] = changeHistory(store);
  assert.equal(e.decision, 'pull request'); assert.equal(e.pending, true); assert.equal(e.rejected, false); assert.equal(e.revertible, true, 'Close PR');
  assert.deepEqual({ ...e.pr, checkedAt: undefined }, { number: 7, url: 'https://github.com/o/r/pull/7', branch: 'thinker/context-20261024-abc', commit: 'c0ffee', base: 'main', state: 'open', openedAt: '2026-10-24T10:00:00.000Z', checkedAt: undefined });
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'pending: not suggested');
  // still open: nothing changes, and GitHub is not asked again within a minute
  let asked = 0; prs.state = () => { asked++; return { state: 'open' }; };
  assert.equal(await refreshPrStates(store, { now: now + 61_000, prs }), 0); assert.equal(asked, 1);
  assert.equal(await refreshPrStates(store, { now: now + 90_000, prs }), 0); assert.equal(asked, 1, 'a minute apart at most');
  assert.equal(await refreshPrStates(store, { now: now + 90_000, prs, force: true }), 0); assert.equal(asked, 2);
  // GitHub cannot be asked: the state is kept
  prs.state = () => null;
  assert.equal(await refreshPrStates(store, { now: now + 200_000, prs }), 0);
  assert.equal(changeHistory(store)[0].pending, true);
  // closed without merging: rejected, suggested again, nothing left to revert
  prs.state = () => ({ state: 'closed', at: '2026-10-24T11:00:00Z' });
  assert.equal(await refreshPrStates(store, { now: now + 300_000, prs }), 1);
  [e] = changeHistory(store);
  assert.equal(e.rejected, true); assert.equal(e.pending, false); assert.equal(e.revertible, false); assert.equal(e.pr.state, 'closed'); assert.equal(e.pr.at, '2026-10-24T11:00:00Z');
  assert.match(e.result, /closed without merging: suggested again/);
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), true, 'rejected: suggested again');
  assert.match((await revertDecision(store, e.id, { prs })).error, /pull request #7 is closed/);
  assert.equal(await refreshPrStates(store, { now: now + 400_000, prs }), 0, 'no open pull request left to ask after');

  // a second pull request, merged: done, not suggested; a third, closed from History
  await applyReviewed(store, [picked[0]], 'releases', ['AGENTS.md'], { now: now + 1000, pr: true, prs });
  prs.state = () => ({ state: 'merged', at: '2026-10-24T12:00:00Z' });
  assert.equal(await refreshPrStates(store, { now: now + 100_000, prs }), 1);
  assert.equal(changeHistory(store)[0].pr.state, 'merged'); assert.equal(changeHistory(store)[0].revertible, false);
  assert.equal(currentChanges(store, view(), { now }).some(c => c.key === 'section:AGENTS.md:Releases'), false, 'merged: decided');
  await applyReviewed(store, [picked[1]], 'ports', ['AGENTS.md'], { now: now + 2000, pr: true, prs });
  const third = changeHistory(store)[0];
  assert.match((await revertDecision(store, third.id, { now: now + 3000, prs })).said, /pull request #7 closed; suggested again/);
  assert.deepEqual(closed, [[7, 'thinker/context-20261024-abc']]);
  const after = changeHistory(store)[0];
  assert.equal(after.pr.state, 'closed'); assert.equal(after.rejected, true); assert.ok(after.revertedAt);
  assert.match((await revertDecision(store, third.id, { prs })).error, /already reverted/);
  // the pull request's failure records nothing
  prs.openEditPr = async () => ({ error: 'could not push' });
  assert.equal((await applyReviewed(store, [picked[0]], 'x', ['AGENTS.md'], { pr: true, prs })).error, 'could not push');
  assert.equal(changeHistory(store).length, 3);
});
