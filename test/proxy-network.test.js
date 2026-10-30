import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startProxy, PROXY_DEFAULTS } from '../src/proxy.js';

const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy'];
function env(t, values) {
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  t.after(() => { for (const k of keys) old[k] === undefined ? delete process.env[k] : process.env[k] = old[k]; });
}
async function listen(t, server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}
async function proxy(t, upstream, options = {}) {
  const server = startProxy({ ...PROXY_DEFAULTS, upstream }, options);
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}
const post = port => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { authorization: 'Bearer model-fixture' } }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); req.end('{"model":"fixture","messages":[]}');
});

test('HTTP proxy resolves the gateway name and a reset retries through that same proxy', async t => {
  let calls = 0;
  const network = http.createServer((req, res) => {
    calls++;
    assert.equal(req.url, 'http://gateway.invalid/v1/messages');
    assert.equal(req.headers.authorization, 'Bearer model-fixture');
    if (calls === 1) return req.socket.destroy();
    res.end('recovered');
  });
  const port = await listen(t, network);
  env(t, { HTTP_PROXY: `http://127.0.0.1:${port}` });
  const thinker = await proxy(t, 'http://gateway.invalid');
  assert.deepEqual(await post(thinker), { status: 200, body: 'recovered' });
  assert.equal(calls, 2, 'the retry must not bypass the transport proxy with agent:false');
});

test('lowercase proxy variables and NO_PROXY preserve a direct local route', async t => {
  let forwarded = 0;
  const network = http.createServer((req, res) => { forwarded++; res.end('proxied'); });
  const networkPort = await listen(t, network);
  const direct = await listen(t, http.createServer((req, res) => res.end('direct')));
  env(t, { http_proxy: `http://127.0.0.1:${networkPort}`, no_proxy: '127.0.0.1' });
  assert.deepEqual(await post(await proxy(t, `http://127.0.0.1:${direct}`)), { status: 200, body: 'direct' });
  assert.deepEqual(await post(await proxy(t, 'http://gateway.invalid')), { status: 200, body: 'proxied' });
  assert.equal(forwarded, 1);
});

test('HTTPS uses CONNECT and verifies the gateway certificate through a transport proxy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-network-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=gateway.invalid', '-addext', 'subjectAltName=DNS:gateway.invalid'], { stdio: 'ignore', env: process.env });
  const ca = fs.readFileSync(cert);
  const target = await listen(t, https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => res.end('secure')));
  const sockets = new Set(); let tunnels = 0;
  const network = http.createServer();
  network.on('connect', (req, client, head) => {
    tunnels++; assert.equal(req.url, 'gateway.invalid:443');
    const socket = net.connect(target, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
    });
    for (const s of [client, socket]) { sockets.add(s); s.on('error', () => s.destroy()); s.on('close', () => sockets.delete(s)); }
  });
  t.after(() => { for (const s of sockets) s.destroy(); });
  const port = await listen(t, network);
  env(t, { HTTPS_PROXY: `http://127.0.0.1:${port}` });
  assert.deepEqual(await post(await proxy(t, 'https://gateway.invalid', { agentOptions: { ca } })), { status: 200, body: 'secure' });
  assert.equal(tunnels, 1);
});
