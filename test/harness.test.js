// What Claude Code loads into every session against what the sessions use (harness.js), read from
// the transcripts' own records of what was loaded, and the advice on what to switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import http from 'node:http';
import { createUiServer } from '../src/ui/server.js';
import { sessionHarness, harnessUsage, harnessAdvice, harnessSavings, harnessView, skillCosts, serverKey, scheduleHarnessSuggestion, harnessOffer, harnessPending, answerHarness, undoHarness, readHarnessState, harnessNever, SIGNATURE } from '../src/harness.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const long = n => 'x'.repeat(n);
// a plugin's skill is listed as "- <plugin>:<file> (<plugin>:<name>): …"
const SKILLS = `- gtm:start-here (gtm:begin): ${long(800)}\n- gtm:pricing: ${long(800)}\n- mine: ${long(2000)}\n- code-review: ${long(600)}\n`;
const loadedLines = () => [
  { type: 'attachment', cwd: '/r', attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor', ...Array.from({ length: 60 }, (_, i) => `mcp__rea__tool_number_${i}`), 'mcp__artemis__get_experiment', 'mcp__claude_ai_Gmail__authenticate'], surfacedDefinitions: [{ name: 'mcp__claude_ai_Claude_Docs__batch', definition: { name: 'mcp__claude_ai_Claude_Docs__batch', description: long(800) } }] } },
  { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['rea', 'artemis', 'claude.ai Claude Docs'], addedBlocks: [`## rea\n${long(1200)}`, `## artemis\n${long(1200)}`, `## docs\n${long(400)}`] } },
  { type: 'attachment', attachment: { type: 'skill_listing', content: SKILLS, names: ['gtm:start-here', 'gtm:pricing', 'mine', 'code-review'] } },
];
const call = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
function session(dir, id, extra = [], sub = []) {
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [...loadedLines(), ...extra].map(j => JSON.stringify(j)).join('\n') + '\n');
  if (sub.length) {
    fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a.jsonl'), sub.map(j => JSON.stringify(j)).join('\n') + '\n');
  }
  return { client: 'claude', file: path.join(dir, `${id}.jsonl`), session: id, mtime: Date.now() };
}
function home(t) {
  const h = tmp('thinker-harness-home-');
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { rea: { command: 'rea', env: { KEY: 'secret-value' } }, artemis: { command: 'artemis' } } }));
  fs.mkdirSync(path.join(h, '.claude', 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gtm@market': true } }));
  return h;
}

test('a server is one key whether its tools or its instructions name it', () => {
  assert.equal(serverKey('claude_ai_Claude_Docs'), serverKey('claude.ai Claude Docs'));
  assert.equal(serverKey('claude-in-chrome'), 'claude_in_chrome');
});

test('each skill costs its own line of the listing', () => {
  const c = skillCosts(SKILLS, ['mine', 'gtm:start-here', 'absent']);
  assert.ok(c.get('gtm:start-here') > 200 && c.get('gtm:start-here') < 260, 'the first skill ends where the next begins');
  assert.equal(c.has('absent'), false);
});

test('a session records what it loaded, with tokens, and what it and its subagents called', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = session(dir, 'a', [call('mcp__artemis__get_experiment'), { type: 'user', message: { content: '<command-name>/gtm:pricing</command-name>' } }], [call('Skill', { skill: 'mine' })]);
  const h = sessionHarness(s.file);
  assert.equal(h.cwd, '/r');
  assert.ok(h.loaded.get('mcp:rea') > 600, 'sixty tool names and the instructions');
  assert.ok(h.loaded.get('mcp:claude_ai_claude_docs') > 300, 'a surfaced definition counts whole, beside the instructions');
  assert.deepEqual([...h.used].sort(), ['mcp:artemis', 'skill:gtm:pricing', 'skill:mine']);
});

test('advice names what is loaded and never used, where it is switched on, and keeps what is used', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = tmp('thinker-harness-repo-'); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sessions = [0, 1, 2, 3].map(i => session(dir, `s${i}`, [call('mcp__artemis__get_experiment')]));
  const usage = harnessUsage(repo, { home: home(t), sessions });
  assert.equal(usage.sessions, 4);
  const by = Object.fromEntries(usage.sources.map(s => [s.name, s]));
  assert.equal(by.gtm.kind, 'plugin', 'a plugin\'s skills are one source');
  assert.equal(by.gtm.scope, 'user');
  assert.equal(by.artemis.used, 4);
  const advice = harnessAdvice(usage);
  const names = advice.map(a => a.name).sort();
  assert.deepEqual(names, ['code-review', 'gtm', 'mine', 'rea'], 'a connector has no setting thinker can write; a skill Claude Code builds in has skillOverrides');
  const rea = advice.find(a => a.name === 'rea');
  assert.match(rea.action, /"disabledMcpServers": \["rea"\] in this repository's entry of ~\/.claude.json/);
  assert.doesNotMatch(JSON.stringify(advice), /secret-value/, 'an entry\'s env is never printed');
  assert.match(advice.find(a => a.name === 'gtm').action, /"gtm@market": false/);
  assert.match(advice.find(a => a.name === 'code-review').action, /"code-review": "user-invocable-only"/);
});

test('sessions written before Claude Code recorded what it loaded are not counted', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'old.jsonl'), JSON.stringify(call('Read', { file_path: 'a' })) + '\n');
  const usage = harnessUsage(dir, { home: home(t), sessions: [{ client: 'claude', file: path.join(dir, 'old.jsonl'), session: 'old', mtime: Date.now() }] });
  assert.equal(usage.sessions, 0);
  assert.deepEqual(harnessAdvice(usage), []);
});

test('a source switched off since those sessions ran is not advised again', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = tmp('thinker-harness-repo-'); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const h = home(t);
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { rea: { command: 'rea' } }, projects: { [repo]: { disabledMcpServers: ['rea'] } } }));
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'gtm@market': false }, skillOverrides: { mine: 'user-invocable-only' } }));
  const sessions = [0, 1, 2].map(i => session(dir, `s${i}`));
  const usage = harnessUsage(repo, { home: h, sessions });
  assert.deepEqual(harnessAdvice(usage).map(a => a.name), ['code-review']);
  const gtm = usage.sources.find(s => s.name === 'gtm');
  assert.equal(gtm.off, true);
  assert.equal(gtm.scope, 'user', 'the scope kept is where it is switched on');
});

// --- the suggestion, its answer and its undo ---------------------------------------------------------
const T0 = Date.parse('2026-10-18T12:00:00Z');
function checkout(t) {
  const dir = tmp('thinker-harness-store-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '-b', 'main'], { cwd: dir });
  return new Store(dir).init();
}
function suggested(t, extraSkills = '') {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = checkout(t), h = home(t), thinkerHome = tmp('thinker-harness-th-');
  t.after(() => fs.rmSync(thinkerHome, { recursive: true, force: true }));
  const sessions = [0, 1, 2, 3].map(i => session(dir, `s${i}`, [call('mcp__artemis__get_experiment')]));
  const usage = harnessUsage(store.repo, { home: h, sessions });
  const picks = scheduleHarnessSuggestion(store, { now: T0, home: thinkerHome, usage });
  return { store, h, thinkerHome, picks };
}

test('the suggestion is one question with every source as an option, signed as thinker, put once and to Claude Code alone', t => {
  const { store, thinkerHome, picks } = suggested(t);
  assert.deepEqual(picks.map(p => p.name).sort(), ['code-review', 'gtm', 'mine', 'rea'], 'one small skill is its own option');
  assert.equal(harnessPending(store, { home: thinkerHome }), true);
  assert.equal(harnessOffer(store, { client: 'codex', home: thinkerHome, now: T0 }), '', 'only Claude Code records what it loaded');
  const ask = harnessOffer(store, { client: 'claude', home: thinkerHome, now: T0 });
  assert.match(ask, /^<thinker-harness-suggestion>/);
  assert.match(ask, /AskUserQuestion/);
  assert.match(ask, /multiSelect true/);
  assert.match(ask, /header "🧠 Thinker"/);
  assert.ok(ask.includes(`"${SIGNATURE}: switch these off in this repository?`), 'the question opens with the signature');
  for (const p of picks) assert.ok(ask.includes(`"${p.name}"`), `${p.name} is an option`);
  assert.equal(harnessOffer(store, { client: 'claude', home: thinkerHome, now: T0 }), '', 'once');
});

test('skills too small to ask about one by one are one option together', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = checkout(t), h = home(t), th = tmp('thinker-harness-th-'); t.after(() => fs.rmSync(th, { recursive: true, force: true }));
  const small = Array.from({ length: 3 }, (_, i) => `tiny${i}`);
  const listing = small.map(n => `- ${n}: ${long(900)}`).join('\n');
  const lines = () => [{ type: 'attachment', cwd: '/r', attachment: { type: 'skill_listing', content: listing, names: small } }];
  const sessions = [0, 1, 2].map(i => { const f = path.join(dir, `t${i}.jsonl`); fs.writeFileSync(f, lines().map(j => JSON.stringify(j)).join('\n') + '\n'); return { client: 'claude', file: f, session: `t${i}`, mtime: Date.now() }; });
  const picks = scheduleHarnessSuggestion(store, { now: T0, home: th, usage: harnessUsage(store.repo, { home: h, sessions }) });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].name, '3 rarely used skills');
  assert.deepEqual(picks[0].skills, small);
  answerHarness(store, '3 rarely used skills', { home: th, userHome: h, now: T0 });
  const local = JSON.parse(fs.readFileSync(path.join(store.repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.skillOverrides, { tiny0: 'user-invocable-only', tiny1: 'user-invocable-only', tiny2: 'user-invocable-only' });
});

test('the answer switches the chosen sources off for this repository alone, with a backup, and --undo turns them back on', t => {
  const { store, h, thinkerHome } = suggested(t);
  const claudeJson = path.join(h, '.claude.json'), before = fs.readFileSync(claudeJson, 'utf8');
  harnessOffer(store, { client: 'claude', home: thinkerHome, now: T0 });
  const said = answerHarness(store, 'gtm plugin, rea, mine', { client: 'claude', home: thinkerHome, userHome: h, now: T0 });
  assert.match(said, /Switched off for this repository/);
  const local = JSON.parse(fs.readFileSync(path.join(store.repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.enabledPlugins, { 'gtm@market': false }, 'the label\'s kind is taken off the name');
  assert.deepEqual(local.skillOverrides, { mine: 'user-invocable-only' });
  const cj = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  assert.deepEqual(cj.projects[store.repo].disabledMcpServers, ['rea']);
  assert.ok(cj.mcpServers.rea, 'the server stays configured for every other repository');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')).enabledPlugins['gtm@market'], true, 'the user\'s settings are not touched');
  const backups = fs.readdirSync(path.join(thinkerHome, 'state', 'harness-backups'));
  assert.equal(fs.readFileSync(path.join(thinkerHome, 'state', 'harness-backups', backups[0], '0-.claude.json'), 'utf8'), before);
  assert.equal(harnessPending(store, { home: thinkerHome }), false);

  assert.match(undoHarness(store, { home: thinkerHome, now: T0 }), /Turned back on/);
  const after = JSON.parse(fs.readFileSync(path.join(store.repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(after.enabledPlugins, {}); assert.deepEqual(after.skillOverrides, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[store.repo].disabledMcpServers, []);
  assert.match(undoHarness(store, { home: thinkerHome }), /Nothing to undo/);
});

test('none passes on every source for a month; never stops the suggestions on this machine', t => {
  const { store, h, thinkerHome } = suggested(t);
  assert.match(answerHarness(store, 'none', { home: thinkerHome, userHome: h, now: T0 }), /nothing switched off/);
  assert.equal(fs.existsSync(path.join(store.repo, '.claude', 'settings.local.json')), false);
  assert.ok(readHarnessState(store).declined['mcp:rea']);
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usage = harnessUsage(store.repo, { home: h, sessions: [0, 1, 2].map(i => session(dir, `n${i}`, [call('mcp__artemis__get_experiment')])) });
  assert.deepEqual(scheduleHarnessSuggestion(store, { now: T0 + 8 * 86400_000, home: thinkerHome, usage }), [], 'declined a week ago: not asked again');
  assert.equal(answerHarness(store, 'never', { home: thinkerHome, userHome: h, now: T0 }).startsWith('Recorded'), true);
  assert.equal(harnessNever(thinkerHome), true);
  assert.equal(scheduleHarnessSuggestion(store, { now: T0 + 60 * 86400_000, home: thinkerHome, usage, force: true }), null);
});

// --- what switching off saved -----------------------------------------------------------------------
// a session started at `start`, with `calls` model calls, loading what loadedLines loads minus `without`
function laterSession(dir, id, start, { calls = 4, without = [] } = {}) {
  const drop = n => without.some(w => n.startsWith(w));
  const lines = loadedLines().map(j => {
    const a = j.attachment;
    if (a.type === 'deferred_tools_delta') return { ...j, timestamp: start, attachment: { ...a, addedNames: a.addedNames.filter(n => !drop(n)) } };
    if (a.type === 'mcp_instructions_delta') { const keep = a.addedNames.map((n, i) => [n, a.addedBlocks[i]]).filter(([n]) => !without.some(w => w === `mcp__${n}__`)); return { ...j, attachment: { ...a, addedNames: keep.map(k => k[0]), addedBlocks: keep.map(k => k[1]) } }; }
    if (a.type === 'skill_listing') { const names = a.names.filter(n => !drop(`skill:${n}`)); return { ...j, attachment: { ...a, names, content: a.content.split(/\n(?=- \S)/).filter(e => names.some(n => e.startsWith(`- ${n}`))).join('\n') } }; }
    return j;
  });
  for (let i = 0; i < calls; i++) lines.push({ type: 'assistant', message: { id: `m${id}${i}`, usage: { input_tokens: 10 }, content: [{ type: 'text', text: 'ok' }] } });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(j => JSON.stringify(j)).join('\n') + '\n');
  return { client: 'claude', file: path.join(dir, `${id}.jsonl`), session: id, mtime: Date.parse(start) };
}

test('what switching off saved is read from the sessions started since: absent counts, still loaded does not', t => {
  const { store, h, thinkerHome } = suggested(t);
  answerHarness(store, 'gtm, rea', { home: thinkerHome, userHome: h, now: T0 });
  const dir = tmp('thinker-harness-later-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = laterSession(dir, 'before', new Date(T0 - 3600e3).toISOString(), { without: [] });
  const gone = laterSession(dir, 'gone', new Date(T0 + 3600e3).toISOString(), { calls: 5, without: ['mcp__rea__', 'skill:gtm:'] });
  const other = laterSession(dir, 'other', new Date(T0 + 7200e3).toISOString(), { calls: 2, without: ['skill:gtm:'] });
  const sv = harnessSavings(store, { sessions: [before, gone, other] });
  assert.equal(sv.sessions, 2, 'a session from before the switch is not counted');
  const by = Object.fromEntries(sv.sources.map(s => [s.name, s]));
  assert.equal(by.gtm.absent, 2); assert.equal(by.gtm.stillLoaded, 0);
  assert.equal(by.rea.absent, 1); assert.equal(by.rea.stillLoaded, 1, 'the checkout where rea still loaded is named, not counted as saved');
  assert.equal(by.rea.tokens, by.rea.tokensPerSession);
  assert.equal(by.rea.inputTokens, 5 * by.rea.tokensPerSession, 'read again in each model call of the session');
  assert.equal(sv.tokens, by.gtm.tokens + by.rea.tokens);
  assert.deepEqual(harnessSavings(checkout(t)), { sources: [], sessions: 0, tokens: 0, inputTokens: 0 }, 'nothing switched off, nothing read');
});

test('the page shows the same view as the command, and asks and undoes through the same functions', async t => {
  const store = checkout(t);
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const ui = createUiServer(store, { token: 'a'.repeat(32), home: tmp('thinker-harness-uih-'), transcriptsHome: tmp('thinker-harness-uit-') });
  const { port } = await ui.listen(0); t.after(() => ui.close());
  const call = (p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, 'x-thinker-token': 'a'.repeat(32), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') })); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  const v = await call('/api/harness');
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(Object.keys(v.body).sort(), Object.keys(harnessView(store)).sort());
  assert.equal((await call('/api/harness/suggest', { repo: '' })).status, 400, 'nothing to ask about: said, not queued');
  assert.match((await call('/api/harness/undo', { repo: '' })).body.said, /Nothing to undo/);
  assert.equal((await call('/api/harness?repo=all')).status, 200);
});
