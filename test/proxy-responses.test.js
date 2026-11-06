import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proxyConfig, startProxy, transformRequest, proxyReport, cutCandidates } from '../src/proxy.js';
import { CLEARED_OUTPUT, responsesUsage, responsesUsageTap, responsesReport, responsesCandidates, applyResponsesCut } from '../src/proxy-responses.js';

import { placeholder, freshCut, cutResponse, cutStore, decideCut } from '../src/cutting.js';

const cfg = extra => proxyConfig({ protocol: 'responses', upstream: 'http://127.0.0.1:1/v1', trigger: '1', 'clear-at-least': '1', 'keep-min': '1', ...extra }, {});
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const call = id => ({ type: 'function_call', call_id: id, name: 'exec_command', arguments: '{}' });
const result = (id, output = 'old file contents '.repeat(200)) => ({ type: 'function_call_output', call_id: id, output });
const history = () => [user('first task'), call('a'), result('a', 'old file contents '.repeat(4000)), { type: 'reasoning', encrypted_content: 'opaque' }, user('second task'), call('b'), result('b')];
const raw = (input = history(), extra = {}) => Buffer.from(JSON.stringify({ model: 'test-model', input, stream: true, store: false, ...extra }));
const transform = (body = raw(), config = cfg(), headers = { session_id: 'unit-session' }) => transformRequest('POST', '/responses', headers, body, config);

test('Responses clearing is opt-in and validates its routing and thresholds', () => {
  const body = raw();
  assert.equal(transform(body, proxyConfig({}, {})).body, body);
  assert.throws(() => proxyConfig({ protocol: 'responses' }, {}), /explicit --upstream/);
  for (const flags of [{ protocol: 'bogus' }, { trigger: -1 }, { trigger: true }, { trigger: 'bad' }, { 'keep-min': -1 }, { 'clear-at-least': 0 }, { holdout: 2 }, { upstream: 'file:///tmp/no' }]) assert.throws(() => cfg(flags));
  assert.equal(proxyConfig({}, { THINKER_PROXY_PROTOCOL: 'responses', THINKER_PROXY_UPSTREAM: 'https://api.openai.com/v1' }).protocol, 'responses');
});

test('only old text outputs change; current turn, IDs, calls, instructions and reasoning survive', () => {
  const input = history();
  input.splice(3, 0, { type: 'custom_tool_call_output', call_id: 'custom', output: [{ type: 'input_text', text: 'x'.repeat(4000) }] });
  input.splice(4, 0, result('image', [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]));
  const original = raw(input, { instructions: 'keep this', tools: [{ type: 'function', name: 'exec_command', parameters: {} }] });
  const t = transform(original);
  const sent = JSON.parse(t.body), before = JSON.parse(original);
  assert.equal(t.injected, true);
  assert.equal(t.clearedUses, 2);
  assert.ok(t.removedBytes > 4000);
  assert.deepEqual(sent, { ...before, input: before.input.map((item, i) => i === 2 ? { ...item, output: placeholder(item.output.length) } : i === 3 ? { ...item, output: [{ type: 'input_text', text: placeholder(4000) }] } : item) });
  assert.equal(transform(t.body).body, t.body, 'idempotent if a client sends the shortened history');
  assert.deepEqual(transform(original).body, t.body, 'retries reconstruct exactly the same prefix without session state');
  const next = transform(raw([...input, call('c'), result('c')]));
  assert.deepEqual(JSON.parse(next.body).input.slice(0, input.length), sent.input, 'a follow-up keeps the rewritten prefix and the current turn');
});

test('native compaction, linked histories, unknown shapes and encoded bodies pass through', () => {
  for (const body of [raw(history(), { previous_response_id: 'r1' }), raw(history(), { conversation: 'c1' }), raw([{ type: 'item_reference', id: 'previous' }, ...history()]), raw(history(), { context_management: [{ type: 'compaction', compact_threshold: 1000 }] }), raw([...history(), { type: 'compaction_trigger' }]), raw('hello'), Buffer.from('null'), Buffer.from('{')]) assert.equal(transform(body).body, body);
  for (const endpoint of ['/responses/compact', '/v1/responses/compact', '/models', '/v1/messages']) { const body = raw(); assert.equal(transformRequest('POST', endpoint, {}, body, cfg()).body, body); }
  const body = raw();
  assert.equal(transform(body, cfg(), { 'content-encoding': 'zstd' }).reason, 'encoded-request');
  assert.equal(transformRequest('POST', '/v1/responses?x=y', { session_id: 'unit-session' }, body, cfg()).injected, true);
});

test('size gates, newest-output floor, first turn and session holdouts are conservative', () => {
  const body = raw();
  assert.equal(transform(body, cfg({ trigger: 999999 })).reason, 'below-trigger');
  assert.equal(transform(body, cfg({ 'clear-at-least': 999999 })).reason, 'below-clear-minimum');
  assert.equal(transform(body, cfg({ 'keep-min': 10 })).injected, undefined);
  assert.equal(transform(raw(history().slice(0, 4)), cfg({ 'keep-min': 0 })).injected, undefined, 'never clears the current turn even with a zero floor');
  assert.equal(transform(raw([call('a'), result('a')])).reason, 'no-user-turn');
  assert.equal(transform(body, cfg({ holdout: 1 }), { session_id: 's1' }).reason, 'holdout');
  assert.equal(transform(body, cfg({ holdout: 1 }), {}).reason, 'missing-session');
  assert.equal(transform(raw(history(), { prompt_cache_key: 's2' }), cfg({ holdout: 1 })).reason, 'holdout');
  assert.equal(transform(body, cfg({ holdout: 0 })).injected, true);
});

const usage = { input_tokens: 250, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 40, cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 30 } }, output_tokens: 7 };
const answer = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', usage, output: [] } })}\n\n`;
test('Responses usage reads split SSE and JSON without Anthropic cache weights', () => {
  for (const data of [answer, JSON.stringify({ usage })]) {
    const tap = responsesUsageTap();
    for (let i = 0; i < data.length; i += 3) tap.push(Buffer.from(data.slice(i, i + 3)));
    assert.deepEqual(tap.result(), { input: 250, read: 200, write: 40, write30m: 10, write12h: 30, freshInput: 10, out: 7, apiUsage: usage, ...(data === answer ? { responseId: 'r1' } : {}) });
  }
  const r = proxyReport([{ op: 'proxy', protocol: 'responses', injected: true, input: 250, read: 200, out: 7, removedBytes: 400, estimatedRemovedTokens: 100, status: 200 }, { op: 'proxy', protocol: 'responses', reason: 'encoded-request', status: 200 }]);
  assert.deepEqual(Object.keys(r), ['responses']);
  assert.equal(r.responses.clearing.input, 250);
  assert.equal(r.responses.clearing.cachedInput, 200);
  assert.equal(r.responses.clearing.billedInput, undefined);
  assert.deepEqual(r.responses.unchanged.reasons, { 'encoded-request': 1 });
  // What the cut took out, in tokens as well as bytes: this path is told nothing by the API, so the row's own
  // estimate is the only token figure it has, and the telemetry's spend cards count the Codex door by it.
  assert.equal(r.responses.clearing.removedBytes, 400);
  assert.equal(r.responses.clearing.removedTokens, 100);
  // a row from before the estimate was summed carries no token figure and must not drag the total down
  assert.equal(proxyReport([{ op: 'proxy', protocol: 'responses', injected: true, removedBytes: 400, status: 200 }]).responses.clearing.removedTokens, 0);
});

test('HTTP transport preserves auth, streaming, errors and compact requests without logging content', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(req.url.includes('error') ? 429 : 200, { 'content-type': 'text/event-stream', 'x-request-id': 'test-id' });
      res.write(answer.slice(0, 20)); res.end(answer.slice(20));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-responses-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const proxy = startProxy({ ...cfg(), upstream: `http://127.0.0.1:${upstream.address().port}/v1` }, { logFile, dumpDir: path.join(dir, 'dumps') });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = async endpoint => {
    const r = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer mock-only', 'chatgpt-account-id': 'fixture-account', session_id: 'session-test' }, body: raw() });
    assert.equal(r.headers.get('x-request-id'), 'test-id');
    assert.equal(await r.text(), answer); return r.status;
  };
  assert.equal(await send('/responses'), 200);
  assert.equal(await send('/responses?error=1'), 429);
  assert.equal(await send('/responses/compact'), 200);
  assert.deepEqual(seen.map(x => x.url), ['/v1/responses', '/v1/responses?error=1', '/v1/responses/compact']);
  assert.equal(seen[0].headers.authorization, 'Bearer mock-only');
  assert.equal(seen[0].headers['chatgpt-account-id'], 'fixture-account');
  assert.equal(seen[0].headers['anthropic-beta'], undefined);
  assert.equal(JSON.parse(seen[0].body).input[2].output, placeholder(history()[2].output.length));
  assert.equal(seen[2].body, raw().toString());
  const log = fs.readFileSync(logFile, 'utf8');
  assert.doesNotMatch(log, /mock-only|fixture-account|old file contents|opaque/);
  const rows = log.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].session, 'session-test'); assert.equal(rows[0].input, 250);
  assert.deepEqual([rows[0].write, rows[0].write30m, rows[0].write12h, rows[0].freshInput], [40, 10, 30, 10]);
  assert.deepEqual(rows[0].apiUsage, usage);
  // Codex reads the same ledger: what its cut took out of this request, so the desktop card's second
  // section and `thinker proxy report` have a figure for it too (`proxy.js:clearedBy`, 2026-11-05).
  assert.equal(rows[0].cleared, Math.round(rows[0].clientCut.tokens), 'the saving is on the row, as a whole number of tokens');
  assert.equal(rows[0].clearedUses, rows[0].clientCut.cut);
  assert.ok(rows[0].cleared > 0);
  const dumpDir = path.join(dir, 'dumps', 'session-test');
  const dumps = fs.readdirSync(dumpDir).map(f => JSON.parse(fs.readFileSync(path.join(dumpDir, f))));
  assert.ok(dumps.length);
  assert.ok(dumps.every(d => d.usage.write === 40 && d.usage.write30m === 10 && d.usage.write12h === 30));
  assert.deepEqual(dumps[0].usage.apiUsage, usage);
  const upgrade = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, '127.0.0.1', () => socket.write('GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    let output = ''; socket.on('data', c => output += c); socket.on('end', () => resolve(output)); socket.on('error', reject);
  });
  assert.match(upgrade, /426.*[\s\S]*supports_websockets = false/);
});

test('Codex closing SSE on response.completed still logs clearing and usage once', async t => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(answer); // deliberately keep HTTP open after the completion event
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-responses-close-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const proxy = startProxy({ ...cfg(), upstream: `http://127.0.0.1:${upstream.address().port}` }, { logFile });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.address().port, path: '/responses', method: 'POST', headers: { session_id: 'close-session' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.includes('\n\n')) res.destroy(); });
      res.on('close', resolve);
    });
    req.on('error', reject); req.end(raw());
  });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(logFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  const all = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  const rows = all.filter(r => r.op === 'proxy');
  assert.equal(all.filter(r => r.op === 'proxy-cut').length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].injected, true);
  assert.ok(rows[0].removedBytes > 0);
  assert.deepEqual([rows[0].input, rows[0].read, rows[0].write, rows[0].write30m, rows[0].write12h, rows[0].out], [250, 200, 40, 10, 30, 7]);
  assert.equal(rows[0].status, 200);
});

test('managed service routes Codex by its existing auth without changing the Anthropic route', async t => {
  const seen = { anthropic: [], chatgpt: [], api: [] }, servers = {};
  for (const name of Object.keys(seen)) {
    const server = http.createServer((req, res) => {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        seen[name].push({ path: req.url, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(answer);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); servers[name] = server;
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const base = name => `http://127.0.0.1:${servers[name].address().port}`;
  const proxy = startProxy({ ...cfg(), protocol: 'anthropic', codex: true, upstream: base('anthropic'), codexUpstreams: { chatgpt: base('chatgpt') + '/backend-api/codex', api: base('api') + '/v1' } });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const send = async (endpoint, headers = {}, data = raw()) => {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer fixture', session_id: 'managed-session', ...headers }, body: data });
    assert.equal(res.status, 200); await res.text();
  };
  await send('/codex/responses', { 'chatgpt-account-id': 'fixture-account' });
  await send('/codex/responses');
  await send('/codex/responses/compact', { 'chatgpt-account-id': 'fixture-account' });
  await send('/v1/messages', {}, JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(seen.chatgpt[0].path, '/backend-api/codex/responses');
  assert.equal(seen.api[0].path, '/v1/responses');
  for (const name of ['chatgpt', 'api']) {
    assert.equal(JSON.parse(seen[name][0].body).input[2].output, placeholder(history()[2].output.length));
    assert.equal(seen[name][0].auth, 'Bearer fixture');
    assert.equal(seen[name][0].beta, undefined);
  }
  assert.equal(seen.chatgpt[1].path, '/backend-api/codex/responses/compact');
  assert.equal(seen.chatgpt[1].body, raw().toString());
  assert.equal(seen.anthropic[0].path, '/v1/messages');
  // The Anthropic route is passed through as the agent wrote it: since #610 the proxy cuts the context
  // itself and asks the API for nothing, so no context_management is added (it carried edits before).
  assert.equal(seen.anthropic[0].body, JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(JSON.parse(seen.anthropic[0].body).context_management, undefined);
});

test('Codex uses the shared turn-boundary policy and freezes both cuts and refusals', () => {
  const input = history();
  const rec = freshCut('ratchet');
  const config = { ...cfg(), cutRecord: rec };
  const first = transform(raw(input), config);
  assert.equal(first.clear.payback <= 20, true);
  cutResponse(rec, config, first, { input: 200, read: 100, out: 1 });
  const originalPrefix = JSON.parse(first.body).input;
  // In the old Codex path, every new result released another old result below keepMin.
  for (let i = 0; i < 5; i++) {
    input.push(call('new'+i), result('new'+i, 'x'.repeat(40000)));
    const next = transform(raw(input), config);
    assert.deepEqual(next.cut, first.cut);
    assert.equal(next.clear, undefined);
    assert.deepEqual(JSON.parse(next.body).input.slice(0, originalPrefix.length), originalPrefix);
  }
  const boundary = transform(raw([...input, user('next turn')]), config);
  assert.ok(boundary.cut.length > rec.cut.length, 'a new user turn can add a batch');
  const frozen = { ...rec, turn: boundary.turn, cut: boundary.cut };
  const stopped = transform(raw([...input, user('next turn'),call('more'),result('more')]), { ...config, clearAtLeast: 1e9, cutRecord: frozen });
  assert.deepEqual(stopped.cut, boundary.cut, 'stopping preserves all prior placeholders');
  const refusal = freshCut('refused');
  const no = transform(raw(history()), { ...config, clearAtLeast: 1e9, cutRecord: refusal });
  cutResponse(refusal, config, no, {});
  const later = transform(raw([...history(),call('huge'),result('huge','x'.repeat(500000))]), { ...config, cutRecord: refusal });
  assert.deepEqual(later.cut, [], 'a declined boundary is frozen for the turn too');
});

test('Codex candidates price only new cuts and the rewritten tail, using shared gates', () => {
  const input = history();
  const first = responsesCandidates(input, {keepMin:1});
  const rec = freshCut('policy');
  for (const opts of [{trigger:1,clearAtLeast:1},{trigger:1e9,clearAtLeast:1},{trigger:1,clearAtLeast:1e9}]) {
    const config={...cfg(),...opts,cutRecord:rec};
    const actual=transform(raw(input),config);
    const expected=decideCut(rec,config,{prompt:raw(input).length/4,turn:2},{cand:first,model:'test-model',ttl:config.ttl});
    assert.deepEqual(actual.cut, expected.cut);
    assert.equal(!!actual.clear,expected.clear);
  }
  const small=responsesCandidates(input,{keepMin:0,cut:first.ids});
  assert.equal(small.tokens,0,'already-cut results cannot satisfy the next batch floor');
  const expensive=[user('old'),call('small'),result('small','x'.repeat(400)),user('next'),{role:'assistant',content:[{type:'output_text',text:'x'.repeat(40000)}]}];
  const held=transform(raw(expensive),{...cfg({'keep-min':0})});
  assert.equal(held.reason,'payback');assert.ok(held.held.payback>20);
  assert.equal(transform(raw(),cfg(),{}).reason,'missing-session','cannot promise a ratchet without a session');
});

test('Codex applies one cut per session when clearDeep is disabled and preserves opaque content', () => {
  const base=history(),first=transform(raw(base));
  const rec={...freshCut('one'),cut:first.cut,turn:first.turn};
  const next=transform(raw([...base,user('new')]),{...cfg(),clearDeep:false,cutRecord:rec});
  assert.deepEqual(next.cut,first.cut);assert.equal(next.clear,undefined);
  const opaque={type:'custom_tool_call_output',call_id:'image',output:[{type:'input_image',image_url:'data:image/png;base64,AAAA'}]};
  assert.deepEqual(applyResponsesCut([opaque],['image']).input,[opaque]);
});

test('the shared cut store keeps state without a log and persists across restarts', () => {
  const memory=cutStore(null),rec={...freshCut('s'),cut:['a'],turn:2};memory.write(rec);
  const got=memory.read('s');assert.deepEqual(got.cut,['a']);got.cut.push('other');assert.deepEqual(memory.read('s').cut,['a']);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'responses-ratchet-'));
  try {cutStore(dir).write(rec);assert.deepEqual(cutStore(dir).read('s').cut,['a']);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('HTTP Codex requests retain the cut set across growing turns and a proxy restart', async t => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push(JSON.parse(body));res.writeHead(200,{'content-type':'text/event-stream'});res.end(answer);});});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-shared-policy-')),logFile=path.join(dir,'proxy.jsonl');
  let proxy;
  const open=async()=>{proxy=startProxy({...cfg(),upstream:`http://127.0.0.1:${upstream.address().port}`},{logFile});await new Promise(r=>proxy.once('listening',r));};
  const close=async()=>{proxy.closeAllConnections();await new Promise(r=>proxy.close(r));};
  t.after(async()=>{await close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const send=async input=>{const r=await fetch(`http://127.0.0.1:${proxy.address().port}/responses`,{method:'POST',headers:{session_id:'persisted'},body:raw(input)});assert.equal(r.status,200);await r.text();return seen.at(-1).input;};
  await open();let input=history(),first=await send(input);
  for(let i=0;i<3;i++){input=[...input,call('later'+i),result('later'+i,'x'.repeat(30000))];const next=await send(input);assert.deepEqual(next.slice(0,first.length),first);}
  await close();await open();const resumed=await send(input);assert.deepEqual(resumed.slice(0,first.length),first,'restart does not restore or newly clear old results');
  const before=resumed;const next=await send([...input,user('next request')]);assert.notDeepEqual(next.slice(0,before.length),before,'a boundary can add a batch');
  const rows=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r=>r.op==='proxy-cut').length,2,'only the two boundaries trigger new cut events');
});

test('Claude and Codex protect the same results for each turn, keep floor, and prior cut set', () => {
  const messages=[], input=[];
  for(let turn=0;turn<3;turn++) {
    messages.push({role:'user',content:'prompt '+turn});input.push(user('prompt '+turn));
    for(let n=0;n<4;n++) {const id=turn+'.'+n, output='x'.repeat(n?10000:100);
      messages.push({role:'user',content:[{type:'tool_result',tool_use_id:id,content:output}]});input.push(result(id,output));
    }
  }
  for(const keepMin of [0,1,3,10])for(const cut of [[],['0.1','0.2']]) {
    const claude=cutCandidates(messages,{keepMin,cut}),codex=responsesCandidates(input,{keepMin,cut});
    assert.deepEqual(codex.ids,claude.ids);assert.equal(codex.chars,claude.chars);
    // Provider-specific character calibration differs; thresholds still use tokens.
    assert.equal(codex.tokens,codex.chars/4);
    assert.ok(codex.ids.every(id=>!id.startsWith('2.')),'protect the whole newest turn');
  }
});

test('failed persistence still holds the in-process reservation', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cut-memory-fallback-'));
  try {const file=path.join(dir,'not-a-directory');fs.writeFileSync(file,'x');const store=cutStore(file);
    store.write({...freshCut('s'),turn:3,cut:['a']});assert.deepEqual(store.read('s').cut,['a']);assert.equal(store.read('s').turn,3);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('Responses cache usage distinguishes absence, zero, and inconsistent provider counts', () => {
  for (const value of [undefined, null, -1, '40', 1.5]) {
    const got = responsesUsage({ input_tokens: 250, input_tokens_details: { cached_tokens: 200, cache_write_tokens: value } });
    assert.equal(got.write, undefined); assert.equal(got.freshInput, undefined);
  }
  const zero = responsesUsage({ input_tokens: 250, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 } });
  assert.equal(zero.write, 0); assert.equal(zero.freshInput, 50);
  assert.equal(zero.write30m, undefined, 'do not guess lifetimes from the total');
  const invalid = responsesUsage({ ...usage, input_tokens: 220 });
  assert.equal(invalid.usageInconsistent, true); assert.equal(invalid.freshInput, undefined);
  const badSplit = responsesUsage({ ...usage, input_tokens_details: { ...usage.input_tokens_details, cache_write_tokens: 39 } });
  assert.equal(badSplit.usageInconsistent, true);
});

test('large JSON and SSE completions retain usage, UTF-8 metadata, and unfinished final lines', () => {
  const response = { id: 'response-🧪', model: 'gpt-test', service_tier: 'default', status: 'completed', output: 'x'.repeat(1100000), usage };
  const json = JSON.stringify(response);
  const event = JSON.stringify({ type: 'response.completed', response });
  const multiline = event.replace(',"response":', ',\ndata: "response":');
  for (const text of [json, 'event: response.completed\r\ndata: ' + event, 'data: ' + multiline + '\n\n']) {
    const bytes = Buffer.from(text), tap = responsesUsageTap();
    for (let i = 0; i < bytes.length; i += 8191) tap.push(bytes.subarray(i, i + 8191));
    const got = tap.result();
    assert.equal(got.write, 40); assert.equal(got.write12h, 30);
    assert.equal(got.responseId, response.id); assert.equal(got.responseModel, 'gpt-test');
    assert.equal(got.serviceTier, 'default'); assert.equal(got.responseStatus, 'completed');
    assert.deepEqual(got.apiUsage, usage); assert.equal(got.output, undefined);
    assert.deepEqual(tap.result(), got, 'reading twice does not duplicate a final data line');
  }
  const tap = responsesUsageTap(), bytes = Buffer.from(JSON.stringify({ id: '🧪', usage }));
  for (const byte of bytes) tap.push(Buffer.from([byte]));
  assert.equal(tap.result().responseId, '🧪');
});

test('oversized events report missing capture and permit a later usage event', () => {
  const oversized = 'data: ' + JSON.stringify({ output: 'x'.repeat(9 * 1024 * 1024) }) + '\n\n';
  const tap = responsesUsageTap(); tap.push(Buffer.from(oversized));
  assert.deepEqual(tap.result(), { usageCaptureLimited: true });
  const recovered = responsesUsageTap();
  for (let i = 0; i < oversized.length; i += 32768) recovered.push(Buffer.from(oversized.slice(i, i + 32768)));
  recovered.push(Buffer.from(answer)); assert.equal(recovered.result().write, 40);
});

test('Responses reports expose partial write coverage without manufacturing fresh input', () => {
  const row = { op: 'proxy', protocol: 'responses', status: 200, ...responsesUsage(usage) };
  const complete = responsesReport([row, row]).unchanged;
  assert.equal(complete.input, 500); assert.equal(complete.cachedInput, 400);
  assert.equal(complete.cacheWrite, 80); assert.equal(complete.cacheWrite30m, 20); assert.equal(complete.cacheWrite12h, 60);
  assert.equal(complete.freshInput, 20);
  assert.deepEqual(complete.writeCoverage, { reported: 2, missing: 0, ttlReported: 2, inconsistent: 0 });
  const legacy = { op: 'proxy', protocol: 'responses', input: 250, read: 200, out: 7 };
  const mixed = responsesReport([row, legacy]).unchanged;
  assert.equal(mixed.cacheWrite, 40); assert.equal(mixed.freshInput, null);
  assert.deepEqual(mixed.writeCoverage, { reported: 1, missing: 1, ttlReported: 1, inconsistent: 0 });
  assert.equal(responsesReport([legacy]).unchanged.cacheWrite, null);
  assert.equal(responsesReport([{ ...legacy, write: 0 }]).unchanged.cacheWrite, 0);
  const inconsistent = responsesReport([{ ...row, input: 100 }]).unchanged;
  assert.equal(inconsistent.writeCoverage.inconsistent, 1); assert.equal(inconsistent.freshInput, null);
});

test('proxy report exports cache-write coverage in JSON and labels partial text totals', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'proxy.jsonl');
  const measured = { op: 'proxy', protocol: 'responses', status: 200, ...responsesUsage(usage) };
  const old = { op: 'proxy', protocol: 'responses', reason: 'holdout', input: 250, read: 200, out: 7 };
  fs.writeFileSync(log, [measured, { ...old, reason: 'below-trigger' }, old].map(JSON.stringify).join('\n'));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, 'proxy', 'report', ...args], {
    cwd: dir, env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: dir, THINKER_PROXY_LOG: log }, encoding: 'utf8' });
  const report = JSON.parse(run('--json'));
  assert.equal(report.responses.unchanged.cacheWrite, 40);
  assert.equal(report.responses.unchanged.writeCoverage.missing, 1);
  assert.equal(report.responses.holdout.cacheWrite, null);
  const text = run();
  assert.match(text, /40 cache-write tokens reported on 1\/2 requests \(1 missing\)/);
  assert.match(text, /30m 10, 12h 30 \(TTL split on 1\/2 requests\)/);
  assert.match(text, /cache writes not reported/);
  assert.doesNotMatch(text, /ordinary input tokens/);
});
