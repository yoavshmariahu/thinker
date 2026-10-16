// mcp.js, the launcher every agent runs: an update reaches a server an app started days ago (2026-10-16:
// Cursor's still ran the code of before an update) without the client reconnecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// a stand-in install: the real launcher beside a tiny server that says which copy it is
function install(dir, version) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'mcp.js'), path.join(dir, 'src', 'mcp.js'));
  writeServer(dir, version);
}
function writeServer(dir, version) {
  // as an update does: a new file at the same path
  const f = path.join(dir, 'src', 'mcp-server.js'), tmp = f + '.new';
  fs.writeFileSync(tmp, `
let inited = false, buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  const say = r => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }) + '\\n');
  if (m.method === 'initialize') { inited = true; say({ result: { serverInfo: { name: 'thinker', version: '${version}' } } }); }
  else if (m.method === 'tools/call') say(inited ? { result: { content: [{ type: 'text', text: '${version} pid ' + process.pid }] } } : { error: { code: -32002, message: 'not initialized' } });
  else if (m.method === 'die') process.exit(1);
} });
process.stdin.on('end', () => process.exit(0));
`);
  fs.renameSync(tmp, f);
}

function session(dir) {
  const p = spawn(process.execPath, [path.join(dir, 'src', 'mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const msgs = []; let buf = '', waiters = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } waiters = waiters.filter(w => !w()); });
  const reply = id => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`no reply to ${id}: ${JSON.stringify(msgs)}`)), 5000); const w = () => { const m = msgs.find(x => x.id === id); if (m) { clearTimeout(t); res(m); return true; } return false; }; if (!w()) waiters.push(w); });
  const req = (id, method, params = {}) => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return reply(id); };
  const note = method => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { p, msgs, req, note, close: () => new Promise(r => { p.on('exit', r); p.stdin.end(); }) };
}

test('an update to the installed server reaches a running session without the client reconnecting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-launcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  install(dir, 'v1');
  const s = session(dir);
  assert.equal((await s.req(1, 'initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.version, 'v1');
  s.note('notifications/initialized');
  const first = (await s.req(2, 'tools/call', { name: 'orient' })).result.content[0].text;
  assert.match(first, /^v1 /);
  writeServer(dir, 'v2');
  const second = (await s.req(3, 'tools/call', { name: 'orient' })).result.content[0].text;
  assert.match(second, /^v2 /, 'the call after the update is served by the new code, initialized by the replay');
  assert.notEqual(second.split('pid ')[1], first.split('pid ')[1]);
  assert.ok(s.msgs.some(m => m.method === 'notifications/tools/list_changed'), 'the client is told to read the tools again');
  assert.ok(!s.msgs.some(m => m.id === 'thinker-launcher-reinit'), 'the replayed initialize is answered to the launcher only');
  assert.equal(s.msgs.filter(m => m.result?.serverInfo).length, 1);
  // a server that died is started again for the next request
  s.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'die' }) + '\n');
  await new Promise(r => setTimeout(r, 300));
  assert.match((await s.req(4, 'tools/call', { name: 'orient' })).result.content[0].text, /^v2 /);
  await s.close();
});
