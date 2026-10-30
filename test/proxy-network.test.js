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

// get-uri still requests basic-ftp v5. Our security override to v6 must keep FTP-hosted
// PAC files working, including servers that need a directory listing instead of the optional MDTM.
for (const listingFallback of [false, true]) {
  test(`FTP-hosted PAC routes requests with the patched FTP client (listing fallback: ${listingFallback})`, { timeout: 15000 }, async t => {
    const networkPort = await listen(t, http.createServer((req, res) => res.end('from-pac')));
    const pac = `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${networkPort}"; }`;
    const commands = [], sockets = new Set(), servers = new Set();
    const track = socket => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      return socket;
    };
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
    });
    const ftp = net.createServer(control => {
      track(control).setEncoding('utf8');
      control.write('220 Fixture ready\r\n');
      let pending = '', data;
      control.on('data', async chunk => {
        pending += chunk;
        while (pending.includes('\r\n')) {
          const end = pending.indexOf('\r\n'), command = pending.slice(0, end);
          pending = pending.slice(end + 2);
          commands.push(command);
          const verb = command.split(' ')[0];
          if (verb === 'USER') control.write('331 Password required\r\n');
          else if (verb === 'PASS') control.write('230 Logged in\r\n');
          else if (verb === 'FEAT') control.write('211-Features\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
          else if (verb === 'MDTM') control.write(listingFallback ? '502 Unsupported\r\n' : '213 20261001000000\r\n');
          else if (verb === 'EPSV') {
            const server = net.createServer(socket => { data = track(socket); server.close(); });
            servers.add(server);
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            control.write(`229 Entering Extended Passive Mode (|||${server.address().port}|)\r\n`);
          } else if (verb === 'MLSD' || verb === 'RETR') {
            control.write('150 Opening data connection\r\n');
            data.end(verb === 'MLSD' ? `type=file;size=${pac.length};modify=20261001000000; proxy.pac\r\n` : pac,
              () => control.write('226 Transfer complete\r\n'));
          } else if (verb === 'QUIT') control.end('221 Goodbye\r\n');
          else control.write('200 OK\r\n');
        }
      });
    });
    const ftpPort = await listen(t, ftp);
    env(t, { HTTP_PROXY: `pac+ftp://127.0.0.1:${ftpPort}/proxy.pac` });
    assert.deepEqual(await post(await proxy(t, 'http://gateway.invalid')), { status: 200, body: 'from-pac' });
    assert.ok(commands.includes('RETR /proxy.pac'));
    assert.equal(commands.some(command => command.startsWith('MLSD')), listingFallback);
  });
}
