// Optional real-client transport check, with a loopback fake model and disposable Codex home.
// THINKER_CODEX_PROXY_SMOKE=1 npm test -- test/proxy-codex.test.js
// No model provider is contacted and no personal login or settings are loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startProxy, proxyConfig } from '../src/proxy.js';
import { CLEARED_OUTPUT } from '../src/proxy-responses.js';

test('installed Codex resumes through the proxy with old outputs cleared', { skip: process.env.THINKER_CODEX_PROXY_SMOKE !== '1', timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-codex-proxy-'));
  const seen = [];
  let fixtureError;
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      try {
        if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
        assert.ok(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity');
        const body = JSON.parse(Buffer.concat(chunks)); seen.push(body);
        let output;
        if (seen.length === 1) {
          const tools = (body.tools || []).flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(f => ({ ...f, name: `${tool.name}.${f.name}` })) : [tool]);
          const shell = tools.find(tool => /(^|\.)(exec_command|shell_command)$/.test(tool.name));
          assert.ok(shell, `No shell fixture tool among ${tools.map(x => x.name).join(', ')}`);
          const key = shell.name.endsWith('exec_command') ? 'cmd' : 'command';
          output = [{ type: 'function_call', id: 'fc_fixture', call_id: 'fixture_call', name: shell.name, arguments: JSON.stringify({ [key]: "printf '%s' '" + 'fixture-output-'.repeat(200) + "'" }) }];
        } else {
          output = [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'READY', annotations: [] }] }];
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const response = { id: `resp_${seen.length}`, object: 'response', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
        const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
        emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
        for (let i = 0; i < output.length; i++) emit({ type: 'response.output_item.done', output_index: i, item: output[i] });
        emit({ type: 'response.completed', response }); res.end();
      } catch (e) { fixtureError = e; res.writeHead(500); res.end('{}'); }
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = startProxy(proxyConfig({ protocol: 'responses', upstream: `http://127.0.0.1:${upstream.address().port}/v1`, trigger: '1', 'clear-at-least': '1', 'keep-min': '0' }, {}));
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const codexHome = path.join(dir, 'codex'); fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "thinker_fixture"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[model_providers.thinker_fixture]\nname = "Thinker fixture"\nbase_url = "http://127.0.0.1:${proxy.address().port}"\nenv_key = "THINKER_FIXTURE_KEY"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: dir, env: { ...process.env, HOME: dir, CODEX_HOME: codexHome, THINKER_HOME: path.join(dir, 'thinker'), THINKER_TEST: '1', THINKER_FIXTURE_KEY: 'fixture-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (fixtureError) reject(fixtureError); else if (code !== 0) reject(new Error(`Codex exit ${code}: ${stderr}\n${stdout}`)); else resolve(stdout); });
  });
  const first = await run(['exec', '--skip-git-repo-check', '--json', 'Run the fixture command and reply READY.']);
  const thread = first.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'thread.started')?.thread_id;
  assert.ok(thread, first);
  assert.ok(seen.some(r => r.input.some(i => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes('fixture-output-'))), 'the first turn receives its full tool output');
  await run(['exec', 'resume', '--skip-git-repo-check', '--json', thread, 'Now reply READY again.']);
  assert.ok(seen.at(-1).input.some(i => i.type === 'function_call_output' && i.output === CLEARED_OUTPUT), 'the resumed second turn clears the old output');
  assert.ok(seen.at(-1).input.some(i => i.type === 'function_call' && i.call_id === 'fixture_call'), 'the matching call survives');
});
