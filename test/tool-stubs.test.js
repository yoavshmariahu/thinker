// A switched-off tool keeps its definition on disk and is sent as a pointer to it (src/tool-stubs.js):
// the registry, the file, the stub in a request, and the proxy's reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addStub, removeStub, readStubs, stubbedNames, stubOf, stubTools, stubReader, writeDefinition, toolFile, pointer, isPointer, STUB_SCHEMA, allowRule } from '../src/tool-stubs.js';
import { transformRequest, PROXY_DEFAULTS } from '../src/proxy.js';

const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-stubs-'))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const def = (name, n = 2000) => ({ name, description: `${name} does things. ${'x'.repeat(n)}`, input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });

test('the switch writes the definition to disk and the name into the registry; undo takes both out', t => {
  const home = tmp(t);
  const { file } = addStub(home, 'Artifact', def('Artifact'), { at: 0 });
  assert.equal(file, toolFile(home, 'Artifact'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), def('Artifact'));
  assert.deepEqual(readStubs(home).tools, { Artifact: { file, at: '1970-01-01T00:00:00.000Z' } });
  assert.ok(stubbedNames(home).has('Artifact'));
  // a definition a transcript recorded without its schema still gives the file a description
  const { file: f2 } = addStub(home, 'SendFeedback', { name: 'SendFeedback', description: 'sends', input_schema: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(f2, 'utf8')), { name: 'SendFeedback', description: 'sends', input_schema: {} });
  assert.equal(removeStub(home, 'Artifact'), true);
  assert.equal(removeStub(home, 'Artifact'), false, 'gone already');
  assert.ok(!fs.existsSync(file));
  assert.deepEqual([...stubbedNames(home)], ['SendFeedback']);
  assert.throws(() => addStub(home, '../etc/passwd', def('x')), /not a tool name/);
  // the allow rule the wiring writes (clients.js): an absolute path in Claude Code's own syntax
  assert.equal(allowRule('/h/.thinker'), 'Read(//h/.thinker/tools/**)');
});

test('the file is completed by whichever door sees the real definition, and a pointer is never written as one', t => {
  const home = tmp(t);
  addStub(home, 'Artifact', { name: 'Artifact', description: 'short, as the transcript had it', input_schema: {} });
  const file = toolFile(home, 'Artifact');
  // the proxy sees the schema the engine sends with the pointer the mod put in: the schema joins, the description stays
  assert.equal(writeDefinition(home, 'Artifact', { name: 'Artifact', description: pointer('Artifact', file), input_schema: def('Artifact').input_schema }).written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: 'Artifact', description: 'short, as the transcript had it', input_schema: def('Artifact').input_schema });
  // the full definition replaces the transcript's
  assert.equal(writeDefinition(home, 'Artifact', def('Artifact')).written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), def('Artifact'));
  assert.equal(writeDefinition(home, 'Artifact', def('Artifact')).written, false, 'the same again: not rewritten');
  assert.equal(writeDefinition(home, 'Artifact', { name: 'Artifact', description: pointer('Artifact', file), input_schema: {} }).written, false, 'the pointer alone changes nothing');
  assert.ok(isPointer(pointer('Artifact', file)) && !isPointer(def('Artifact').description));
});

test('a request carries the pointer and a schema that refuses nothing in place of each registered tool, the rest untouched', t => {
  const home = tmp(t);
  const { file } = addStub(home, 'Artifact', def('Artifact'));
  const tools = [def('Bash'), { ...def('Artifact'), cache_control: { type: 'ephemeral' } }, def('Read')];
  const seen = [];
  const r = stubTools(tools, readStubs(home), { seen: d => seen.push(d.name) });
  assert.deepEqual(r.replaced.map(x => x.name), ['Artifact']);
  assert.ok(r.chars > 1500, `what left the request: ${r.chars}`);
  assert.deepEqual(r.tools[0], def('Bash')); assert.deepEqual(r.tools[2], def('Read'));
  assert.deepEqual(r.tools[1], { name: 'Artifact', description: pointer('Artifact', file), input_schema: STUB_SCHEMA, cache_control: { type: 'ephemeral' } }, 'the cache marker stays where the agent put it');
  assert.match(r.tools[1].description, /read .*tools\/Artifact\.json/);
  assert.deepEqual(seen, ['Artifact'], 'the door that saw the definition is told, to write the file');
  assert.equal(stubOf(def('Artifact'), file).description, pointer('Artifact', file));
  // nothing registered, or no tools: as they came
  assert.equal(stubTools(tools, { tools: {} }).tools, tools);
  assert.deepEqual(stubTools(undefined, readStubs(home)), { tools: undefined, replaced: [], chars: 0 });
  assert.equal(stubTools(tools, readStubs(home)).replaced.length, 1, 'with no `seen`');
});

test('the reader re-reads the registry when its file changes and writes each definition once', t => {
  const home = tmp(t);
  const reader = stubReader(home);
  assert.deepEqual(reader.read().tools, {}, 'no registry yet');
  addStub(home, 'Artifact', { name: 'Artifact', description: 'from the transcript', input_schema: {} });
  assert.ok(reader.read().tools.Artifact, 'the new file is seen');
  reader.seen(def('Artifact'));
  assert.deepEqual(JSON.parse(fs.readFileSync(toolFile(home, 'Artifact'), 'utf8')), def('Artifact'), 'the proxy completes the file');
  fs.writeFileSync(toolFile(home, 'Artifact'), '{"name":"Artifact","description":"hand-edited","input_schema":{}}');
  reader.seen(def('Artifact'));
  assert.match(fs.readFileSync(toolFile(home, 'Artifact'), 'utf8'), /hand-edited/, 'the same definition again is not written again');
  reader.seen(def('Bash'));
  assert.ok(!fs.existsSync(toolFile(home, 'Bash')), 'an unregistered tool writes nothing');
  removeStub(home, 'Artifact');
  assert.deepEqual(reader.read().tools, {}, 'the removal is seen');
});

test('the proxy sends the stub in place of the definition on every request, cut or not, held out or not', t => {
  const home = tmp(t);
  const { file } = addStub(home, 'Artifact', def('Artifact'));
  const cfg = { ...PROXY_DEFAULTS, stubs: stubReader(home) };
  const h = { 'x-claude-code-session-id': 's1' };
  const req = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', tools: [def('Bash'), def('Artifact')], messages: [{ role: 'user', content: 'hi' }], stream: true }));
  const r = transformRequest('POST', '/v1/messages', h, req, cfg);
  assert.equal(r.reason, 'nothing-to-cut'); assert.equal(r.injected, undefined);
  assert.deepEqual(r.stubbed.tools, ['Artifact']); assert.ok(r.stubbed.chars > 1500);
  const sent = JSON.parse(r.body.toString());
  assert.deepEqual(sent.tools[0], def('Bash'));
  assert.equal(sent.tools[1].description, pointer('Artifact', file));
  assert.deepEqual(sent.tools[1].input_schema, STUB_SCHEMA);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }], 'the messages are the agent\'s');
  // the file holds what the request carried
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), def('Artifact'));
  // a held-out session gets the stub too: the switch is the person's decision, not the clearing's experiment
  const held = transformRequest('POST', '/v1/messages', h, req, { ...cfg, holdout: 1 });
  assert.equal(held.reason, 'holdout'); assert.deepEqual(held.stubbed.tools, ['Artifact']);
  assert.equal(JSON.parse(held.body.toString()).tools[1].description, pointer('Artifact', file));
  // nothing registered: the bytes as they came
  const plain = transformRequest('POST', '/v1/messages', h, req, PROXY_DEFAULTS);
  assert.equal(plain.body, req); assert.equal(plain.stubbed, undefined);
  removeStub(home, 'Artifact');
  assert.equal(transformRequest('POST', '/v1/messages', h, req, cfg).body, req, 'undone: as it came');
});
