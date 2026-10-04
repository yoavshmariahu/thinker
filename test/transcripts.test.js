import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTranscript, detectFormat, toolName, hydrate, recordEvent, findSessions } from '../src/transcripts.js';
import { exploreCount, condense } from '../src/distill.js';
import { extractJson } from '../src/llm.js';
import { installClient } from '../src/clients.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-tr-')));
const write = (lines, name = 't.jsonl') => { const f = path.join(tmp(), name); fs.writeFileSync(f, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n'); return f; };
const shape = events => events.map(e => e.t === 'tool' ? `${e.name}:${e.input.file_path || e.input.command || e.input.pattern}=${e.result}` : `${e.t}:${e.text}`);

test('tool names from every agent map to one vocabulary', () => {
  for (const [n, c] of [['read_file', 'Read'], ['Read', 'Read'], ['run_shell_command', 'Bash'], ['Shell', 'Bash'], ['exec', 'Bash'], ['search_file_content', 'Grep'], ['apply_patch', 'Edit'], ['replace', 'Edit'], ['write_file', 'Write'], ['list_directory', 'Glob']]) assert.equal(toolName(n), c);
  assert.equal(toolName('mcp__github__get_issue'), 'mcp__github__get_issue');
});

test('Claude Code transcript', () => {
  const f = write([
    { type: 'user', cwd: '/r', message: { content: 'where is x' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'src/x.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'def x(): pass' }] }] } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'in src/x.py' }] } },
  ]);
  const r = parseTranscript(f);
  assert.equal(r.format, 'claude');
  assert.deepEqual(shape(r.events), ['prompt:where is x', 'say:looking', 'Read:src/x.py=def x(): pass', 'say:in src/x.py']);
  assert.equal(r.model, 'claude-opus-5-5');
  // the model is that of the whole session, even when only the tail is read
  assert.equal(parseTranscript(f, { fromLine: 3 }).events.length, 1);
  assert.equal(parseTranscript(f, { fromLine: 3 }).model, 'claude-opus-5-5');
});

test('Codex rollout and `codex exec --json` output', () => {
  const rollout = write([
    { type: 'session_meta', payload: { cwd: '/r', id: 's' } },
    { type: 'turn_context', payload: { cwd: '/r', model: 'gpt-6-sol' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'where is x' }] } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'where is x' }] } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'zzz' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rg","-n","def x","src"]}', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'src/x.py:1:def x' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'in src/x.py' }] } },
  ]);
  const r = parseTranscript(rollout);
  assert.equal(r.format, 'codex'); assert.equal(r.cwd, '/r'); assert.equal(r.model, 'gpt-6-sol');
  assert.deepEqual(shape(r.events), ['prompt:where is x', 'Bash:rg -n def x src=src/x.py:1:def x', 'say:in src/x.py']);
  assert.equal(exploreCount(r.events), 1);

  const stream = write([
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'cat src/x.py', aggregated_output: 'def x(): pass', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'in src/x.py' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepEqual(shape(parseTranscript(stream).events), ['Bash:cat src/x.py=def x(): pass', 'say:in src/x.py']);
  assert.equal(parseTranscript(stream).model, null);
});

test('Cursor transcript and `agent -p` stream', () => {
  const f = write([
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nwhere is x\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'def x', path: '/r/src' } }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'in src/x.py' }] } },
  ]);
  const r = parseTranscript(f);
  assert.equal(r.format, 'cursor');
  assert.deepEqual(shape(r.events), ['prompt:where is x', 'Grep:/r/src=', 'say:in src/x.py']);

  const stream = write([
    { type: 'system', subtype: 'init', cwd: '/r' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'where is x' }] } },
    { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/r/src/x.py' } } } },
    { type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: { path: '/r/src/x.py' }, result: { success: { content: 'def x(): pass' } } } } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'in src/x.py' }] } },
    { type: 'result', subtype: 'success', result: 'in src/x.py' },
  ]);
  assert.deepEqual(shape(parseTranscript(stream).events), ['prompt:where is x', 'Read:/r/src/x.py=def x(): pass', 'say:in src/x.py']);
});

test('Gemini session JSON and stream', () => {
  const dir = tmp(), f = path.join(dir, 'session.json');
  fs.writeFileSync(f, JSON.stringify({ sessionId: 's', messages: [
    { type: 'user', content: 'where is x' },
    { type: 'gemini', model: 'gemini-3.8-flash', content: 'in src/x.py', toolCalls: [{ id: '1', name: 'read_file', args: { absolute_path: '/r/src/x.py' }, result: [{ functionResponse: { response: { output: 'def x(): pass' } } }] }] },
  ] }, null, 2));
  const r = parseTranscript(f);
  assert.equal(r.format, 'gemini'); assert.equal(r.lineCount, 2); assert.equal(r.model, 'gemini-3.8-flash');
  assert.equal(r.events[0].text, 'where is x');
  assert.equal(r.events[1].name, 'Read'); assert.equal(r.events[1].input.file_path, '/r/src/x.py');
  assert.equal(r.events[2].text, 'in src/x.py');
  assert.equal(parseTranscript(f, { fromLine: 2 }).events.length, 0);

  const stream = write([
    { type: 'init', session_id: 's' },
    { type: 'message', role: 'user', content: 'where is x' },
    { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't1', parameters: { command: 'cat src/x.py' } },
    { type: 'tool_result', tool_id: 't1', output: 'def x(): pass' },
    { type: 'message', role: 'assistant', content: 'in ', delta: true },
    { type: 'message', role: 'assistant', content: 'src/x.py', delta: true },
  ]);
  assert.deepEqual(shape(parseTranscript(stream).events), ['prompt:where is x', 'Bash:cat src/x.py=def x(): pass', 'say:in src/x.py']);
});

test('recorded trace round-trips and results missing from a record are refilled from the repo', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/x.py'), 'def x():\n    return 1\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  const store = path.join(dir, '.thinker');
  recordEvent(store, 's1', { t: 'prompt', text: 'where is x' });
  recordEvent(store, 's1', { t: 'tool', name: 'Read', input: { file_path: path.join(dir, 'src/x.py') }, result: '{"file_path":"x","content_length":22}' });
  recordEvent(store, 's1', { t: 'tool', name: 'Grep', input: { pattern: 'def x' }, result: '' });
  recordEvent(store, 's1', { t: 'tool', name: 'Read', input: { file_path: '/etc/hosts' }, result: '' });
  const f = recordEvent(store, 's1', { t: 'say', text: 'in src/x.py' });
  recordEvent(store, 's1', { t: 'say', text: 'in src/x.py' }); // same message from a second hook
  const r = parseTranscript(f);
  assert.equal(r.format, 'events'); assert.equal(r.events.length, 5);
  hydrate(r.events, dir);
  assert.ok(r.events[1].result.startsWith('def x():'));
  assert.ok(r.events[2].result.includes('src/x.py:1:def x'));
  assert.equal(r.events[3].result, ''); // outside the repo: never read
  assert.ok(condense(r.events).includes('READ'));
});

test('extractJson finds the object in fenced or chatty replies', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": {"b": [1, 2]}}\n```'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('Sure. {"notes": []} Hope that helps.'), { notes: [] });
  assert.throws(() => extractJson('no json here'));
});

test('extractJson supports ambiguous and malformed data formats', () => {
  // 1. Raw unescaped newlines and tabs inside string literals
  const rawMultiline = '{"notes": [{"title": "Multiline note", "body": "Symptom: crash\nRoot cause: null pointer\r\nFix: add check\t(done)"}]}';
  const parsedMultiline = extractJson(rawMultiline);
  assert.equal(parsedMultiline.notes[0].title, 'Multiline note');
  assert.equal(parsedMultiline.notes[0].body, 'Symptom: crash\nRoot cause: null pointer\r\nFix: add check\t(done)');

  // 2. Trailing commas in objects and arrays
  const trailingCommas = '{"notes": [{"title": "Trailing", "tags": ["a", "b",],},],}';
  assert.deepEqual(extractJson(trailingCommas), { notes: [{ title: 'Trailing', tags: ['a', 'b'] }] });

  // 3. Comments (inline and block)
  const withComments = '{\n// Notes list\n"notes": [\n/* comment */\n{"title": "http://example.com"}\n]\n}';
  assert.deepEqual(extractJson(withComments), { notes: [{ title: 'http://example.com' }] });

  // 4. Python literals (True, False, None)
  const pyLiterals = '{"notes": [{"title": "Pythonic", "valid": True, "stale": False, "extra": None}]}';
  assert.deepEqual(extractJson(pyLiterals), { notes: [{ title: 'Pythonic', valid: true, stale: false, extra: null }] });

  // 5. Single-quoted strings
  const singleQuoted = "{ 'notes': [{ 'title': 'Single Quote', 'kind': 'fix' }] }";
  assert.deepEqual(extractJson(singleQuoted), { notes: [{ title: 'Single Quote', kind: 'fix' }] });

  // 6. Unquoted object keys
  const unquotedKeys = '{ notes: [{ title: "Unquoted", kind: "invariant" }] }';
  assert.deepEqual(extractJson(unquotedKeys), { notes: [{ title: 'Unquoted', kind: 'invariant' }] });

  // 7. Truncated mid-string recovery
  const truncatedString = '{"notes": [{"title": "Complete 1", "kind": "fix"}, {"title": "Cut off", "body": "some incomplete text';
  const parsedTruncStr = extractJson(truncatedString);
  assert.equal(parsedTruncStr.notes.length, 2);
  assert.equal(parsedTruncStr.notes[0].title, 'Complete 1');
  assert.equal(parsedTruncStr.notes[1].body, 'some incomplete text');

  // 8. Truncated mid-key recovery (falls back to last complete element)
  const truncatedKey = '{"notes": [{"title": "Complete 1", "kind": "fix"}, {"tit';
  const parsedTruncKey = extractJson(truncatedKey);
  assert.equal(parsedTruncKey.notes.length, 1);
  assert.equal(parsedTruncKey.notes[0].title, 'Complete 1');

  // 9. Exact real-world PR mining failure recovery
  const prMiningError = '{"notes":[{"title":"Configurable separator for flattened keys","kind":"convention","answers":["How do I change the separator in flattened keys?","Can the flatten processor join nested keys with underscores?","Why are nested field names separated by dots?"],"body":"The separator is configured as `fla';
  const parsedPrMining = extractJson(prMiningError);
  assert.equal(parsedPrMining.notes[0].title, 'Configurable separator for flattened keys');
  assert.equal(parsedPrMining.notes[0].kind, 'convention');
  assert.equal(parsedPrMining.notes[0].body, 'The separator is configured as `fla');

  // 10. Schema array post-processing
  const rawArray = '[{"title": "Note in array", "kind": "howto"}]';
  const parsedArray = extractJson(rawArray, { properties: { notes: { type: 'array' } } });
  assert.deepEqual(parsedArray, { notes: [{ title: 'Note in array', kind: 'howto' }] });
});

test('findSessions finds each agent\'s sessions for the repo, and traces without a transcript', () => {
  const home = tmp(), repo = path.join(tmp(), 'my.repo');
  fs.mkdirSync(repo);
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put(path.join(home, '.claude/projects', repo.replace(/[\/.]/g, '-'), 'c1.jsonl'), '{}\n');
  put(path.join(home, '.cursor/projects', repo.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), 'agent-transcripts/u1/u1.jsonl'), '{}\n');
  put(path.join(home, '.cursor/projects/some-long-path-3c018c9/.workspace-trusted'), JSON.stringify({ workspacePath: repo }));
  put(path.join(home, '.cursor/projects/some-long-path-3c018c9/agent-transcripts/u2/u2.jsonl'), '{}\n');
  const d = new Date(), day = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('/');
  const id = '01a0e1ba-8bd1-7331-8fad-eb1f4608045a';
  put(path.join(home, '.codex/sessions', day, `rollout-2026-01-01T00-00-00-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { cwd: repo } }) + '\n');
  put(path.join(home, '.codex/sessions', day, 'rollout-2026-01-01T00-00-00-11111111-8bd1-7331-8fad-eb1f4608045a.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: '/elsewhere' } }) + '\n');
  put(path.join(repo, '.thinker/state/trace-g1.jsonl'), '{"t":"prompt","text":"x"}\n');
  put(path.join(repo, '.thinker/state/trace-c1.jsonl'), '{"t":"prompt","text":"x"}\n');
  const old = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; delete process.env.CODEX_HOME;
  try {
    const found = findSessions(repo, { storeDir: path.join(repo, '.thinker') }).map(s => `${s.client}:${s.session}`).sort();
    assert.deepEqual(found, ['claude:c1', `codex:${id}`, 'cursor:u1', 'cursor:u2', 'trace:g1']);
  } finally { process.env.HOME = old.HOME; if (old.CODEX_HOME) process.env.CODEX_HOME = old.CODEX_HOME; }
});

test('learning hooks are installed for every agent and record the session', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.thinker/notes'), { recursive: true });
  const o = { repo: dir, cli: CLI, mcpEntry: { command: 'node', args: ['/x'], env: {} }, hooks: true, learn: true, late: false, shared: true, mcp: false };
  for (const c of ['codex', 'cursor', 'gemini']) installClient(c, o);
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.ok(read('.codex/hooks.json').hooks.Stop[0].hooks[0].command.includes('hook stop --client codex'));
  assert.ok(read('.codex/hooks.json').hooks.PostToolUse[0].hooks[0].command.includes('--record'));
  assert.ok(read('.gemini/settings.json').hooks.AfterAgent[0].hooks[0].command.includes('hook stop --client gemini'));
  assert.ok(read('.cursor/hooks.json').hooks.stop[0].command.includes('--record'));
  assert.ok(read('.cursor/hooks.json').hooks.sessionEnd[0].command.includes('hook stop --client cursor'));
  assert.ok(read('.cursor/hooks.json').hooks.afterShellExecution[0].command.includes('hook tool'));

  const env = { ...process.env, THINKER_NO_BG_VERIFY: '1', HOME: tmp() };
  const hook = (what, ev) => execFileSync('node', [CLI, 'hook', what, '--client', 'gemini', '--record', '--repo', dir, ...(what === 'stop' ? ['--no-distill'] : [])], { input: JSON.stringify(ev), encoding: 'utf8', env });
  hook('prompt', { session_id: 'g1', prompt: 'where is x' });
  hook('tool', { session_id: 'g1', tool_name: 'read_file', tool_input: { absolute_path: path.join(dir, 'a.py') }, tool_response: { llmContent: 'def x(): pass' } });
  const trace = parseTranscript(path.join(dir, '.thinker/state/trace-g1.jsonl'));
  assert.deepEqual(shape(trace.events), ['prompt:where is x', `Read:${path.join(dir, 'a.py')}=def x(): pass`]);
  // hooks inside thinker's own model calls do nothing
  execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'gemini', '--record', '--repo', dir], { input: JSON.stringify({ session_id: 'g2', prompt: 'x' }), env: { ...env, THINKER_IN_LLM: '1' } });
  assert.ok(!fs.existsSync(path.join(dir, '.thinker/state/trace-g2.jsonl')));
});

test('learn.sessions: false keeps session distillation off while maintenance goes on', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.thinker/notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker/config.json'), JSON.stringify({ learn: { sessions: false } }));
  const env = { ...process.env, HOME: tmp(), THINKER_LOG: 'off', THINKER_TELEMETRY: 'off' };
  const run = args => execFileSync('node', [CLI, ...args, '--repo', dir], { encoding: 'utf8', env });
  assert.match(run(['learn']), /learning from sessions is off \(learn\.sessions/);
  const both = run(['learn', '--maintain', '--dry']);
  assert.match(both, /learning from sessions is off/);
  assert.match(both, /maintained: 0 re-verified/, 'maintenance still runs');
  // the environment switch is stronger: nothing runs
  assert.match(execFileSync('node', [CLI, 'learn', '--maintain', '--dry', '--repo', dir], { encoding: 'utf8', env: { ...env, THINKER_NO_LEARN: '1' } }), /switched off \(THINKER_NO_LEARN\)/);
});

test('incremental checkpoints retain the first appended event and an incomplete final record', () => {
  const file = write([{ t: 'say', text: 'first' }]);
  try {
    const first = parseTranscript(file, { format: 'events' });
    assert.equal(first.lineCount, 1);
    fs.appendFileSync(file, JSON.stringify({ t: 'tool', name: 'Edit', input: { file_path: 'a.js' }, result: 'ok' }) + '\n');
    const next = parseTranscript(file, { format: 'events', fromLine: first.lineCount });
    assert.equal(next.events.length, 1); assert.equal(next.events[0].name, 'Edit');
    fs.appendFileSync(file, '{"t":"say","text":');
    const partial = parseTranscript(file, { format: 'events', fromLine: next.lineCount });
    assert.equal(partial.lineCount, next.lineCount);
    fs.appendFileSync(file, '"last"}\n');
    assert.equal(parseTranscript(file, { format: 'events', fromLine: partial.lineCount }).events[0].text, 'last');
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});
