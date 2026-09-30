import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const code = 'test-private-code';
const config = { codeHash: crypto.createHash('sha256').update(code).digest('hex'), signingKey: 'test-signing-key' };
const source = readFileSync(new URL('../infra/access/gateway.js', import.meta.url), 'utf8');
const context = vm.createContext({ require: () => crypto, Date });
vm.runInContext(source.replace('__ACCESS_CONFIG__', JSON.stringify(config)), context);
function call(uri, { headers = {}, cookies = {}, method = 'GET' } = {}) {
  return context.handler({ request: { uri, method, headers: { host: { value: 'zerotime.dev' }, ...headers }, cookies, querystring: {} } });
}
function login() {
  const result = call('/access/session', { headers: { 'x-thinker-access-code': { value: code } } });
  assert.equal(result.statusCode, 200);
  return result;
}

test('all docs aliases and distribution URLs enforce access before returning content', () => {
  for (const path of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) {
    const result = call(path);
    assert.equal(result.statusCode, 302, path);
    assert.equal(result.headers.location.value, '/?next=' + encodeURIComponent(path));
    assert.equal(result.body, '');
    assert.match(result.headers['cache-control'].value, /no-store/);
  }
  for (const path of ['/dist/thinker.tgz', '/dist/version.json', '/dist/install.sh', '/install.sh', '/thinker101/install.sh', '/Thinker101/install.sh', '/private/new.html']) {
    assert.equal(call(path).statusCode, 403, path);
    assert.equal(call(path, { method: 'HEAD' }).statusCode, 403, path);
  }
});

test('public pages and existing directory routing remain available', () => {
  for (const path of ['/', '/index.html', '/favicon.svg', '/apple-touch-icon.png']) assert.equal(call(path).uri, path);
  assert.equal(call('/gokce-bday').uri, '/gokce-bday/index.html');
  assert.equal(call('/gokce-bday/movie/').uri, '/gokce-bday/movie/index.html');
  assert.equal(call('/docs.html', { headers: { host: { value: 'www.zerotime.dev' } } }).headers.location.value, 'https://zerotime.dev/docs.html');
});

test('invalid credentials, cross-site requests and ambiguous paths fail closed', () => {
  assert.equal(call('/access/session').statusCode, 401);
  for (const value of ['', 'wrong', code.toUpperCase(), 'x'.repeat(257)]) {
    assert.equal(call('/access/session', { headers: { 'x-thinker-access-code': { value } } }).statusCode, 401);
  }
  for (const extra of [{ origin: { value: 'https://other.example' } }, { 'sec-fetch-site': { value: 'cross-site' } }]) {
    assert.equal(call('/access/session', { headers: { 'x-thinker-access-code': { value: code }, ...extra } }).statusCode, 403);
  }
  for (const path of ['/docs%2ehtml', '//docs.html', '/gokce-bday/../docs.html', '/gokce-bday/%2e%2e/docs.html', '/gokce-bday/./docs.html', '/docs\\index.html']) assert.equal(call(path).statusCode, 400, path);
  assert.equal(call('/access/session', { method: 'HEAD' }).statusCode, 405);
  assert.equal(call('/access/session', { method: 'POST' }).statusCode, 405);
});

test('signed HttpOnly sessions authorize docs and restore without exposing credentials', () => {
  const result = login();
  const cookies = result.cookies;
  assert.match(cookies['__Host-thinker_session'].attributes, /Secure; HttpOnly; SameSite=Strict/);
  assert.ok(!result.body.includes(code));
  assert.ok(!result.body.includes(config.signingKey));
  for (const path of ['/docs.html', '/docs', '/docs/']) {
    assert.ok(call(path, { cookies }).uri.startsWith('/docs'));
  }
  const restored = call('/access/session', { cookies });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.cookies, undefined);
  assert.equal(call('/docs.html').statusCode, 302); // a subsequent anonymous/cache-hit request still gates
});

test('forged, expired and wrong-purpose cookies cannot authorize access', () => {
  const now = Math.floor(Date.now() / 1000);
  const mac = value => crypto.createHmac('sha256', config.signingKey).update(value).digest('hex');
  for (const value of ['true', code, `${now + 60}.fake`, `${now - 60}.${mac('session:' + (now - 60))}`,
    `${now + 604801}.${mac('session:' + (now + 604801))}`, `${now + 60}.${mac('download')}`]) {
    assert.equal(call('/docs.html', { cookies: { '__Host-thinker_session': { value } } }).statusCode, 302);
  }
});

test('private install bootstrap carries download credentials through installer and future updates', () => {
  const command = JSON.parse(login().body).installCommand;
  const url = new URL(command.split(' ')[2]);
  const bootstrap = call(url.pathname);
  assert.equal(bootstrap.statusCode, 200);
  const base = url.pathname.replace('/install.sh', '');
  assert.ok(bootstrap.body.includes(`THINKER_DIST_URL="https://zerotime.dev${base}/thinker.tgz"`));
  assert.ok(bootstrap.body.includes(`${base}/installer.sh`));
  assert.ok(bootstrap.body.includes('bash "$installer" "$@"'));
  for (const file of ['installer.sh', 'thinker.tgz', 'version.json']) {
    assert.equal(call(`${base}/${file}`).uri, '/dist/' + (file === 'installer.sh' ? 'install.sh' : file));
  }
  assert.equal(call(base + '/docs.html').statusCode, 404);
  assert.equal(call('/access/download/' + '0'.repeat(64) + '/thinker.tgz').statusCode, 403);
  assert.equal(call(base + '/install.sh', { method: 'HEAD' }).body, '');
});

test('the public homepage contains no password or client-side authorization shortcut', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('thinker101'));
  assert.ok(!html.includes('ACCESS_KEY'));
  assert.ok(!html.includes('sessionStorage.setItem'));
  assert.ok(html.includes("fetch('/access/session'"));
  assert.ok(!html.includes('https://zerotime.dev/dist/'));
});

function page(fetch, search = '', hash = '') {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const elements = new Map();
  const listeners = {};
  const location = { search, hash, assign(url) { this.destination = url; } };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, value: '', focus() {} });
    return elements.get(id);
  };
  const browser = vm.createContext({ fetch, location, URLSearchParams,
    document: { getElementById: element, addEventListener() {} },
    window: { addEventListener(name, fn) { listeners[name] = fn; } },
    sessionStorage: { removeItem() {} }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], browser);
  return { browser, element, location, ready: listeners.DOMContentLoaded };
}

test('homepage only unlocks after successful server verification', async () => {
  const requests = [];
  const p = page(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ installCommand: 'private install command' }) };
  });
  p.element('access-code').value = code;
  const button = {};
  await p.browser.handleAccessSubmit({ preventDefault() {}, target: { querySelector: () => button } });
  assert.equal(requests[0].url, '/access/session');
  assert.equal(requests[0].options.headers['X-Thinker-Access-Code'], code);
  assert.equal(p.element('cmd').textContent, 'private install command');
  assert.equal(p.element('command-view').style.display, 'flex');
  assert.equal(p.element('access-code').value, '');
  assert.equal(button.disabled, false);
});

test('homepage preserves docs destination and anchor after verification', async () => {
  const p = page(async () => ({ ok: true, json: async () => ({ installCommand: 'private' }) }), '?next=%2Fdocs%2F', '#cli-reference');
  await p.ready();
  assert.equal(p.location.destination, '/docs/#cli-reference');
});

test('failed verification cannot reveal downloads; submission can be retried', async () => {
  const p = page(async () => ({ ok: false, status: 401 }));
  const button = {};
  await p.browser.handleAccessSubmit({ preventDefault() {}, target: { querySelector: () => button } });
  assert.equal(p.element('access-error').textContent, 'Invalid access code');
  assert.equal(p.element('cmd').textContent, undefined);
  assert.equal(button.disabled, false);
  await p.ready();
  assert.equal(p.element('cmd').textContent, undefined);
});


test('legacy download grace period expires at the fixed deadline and exposes only three exact paths', () => {
  const deadline = '2026-10-02T06:30:25Z';
  let now = Date.parse(deadline) - 1;
  const clock = class extends Date { static now() { return now; } };
  const grace = vm.createContext({ require: () => crypto, Date: clock });
  vm.runInContext(source.replace('__ACCESS_CONFIG__', JSON.stringify({ ...config, legacyDownloadsUntil: deadline })), grace);
  const request = (uri, method = 'GET') => grace.handler({ request: { uri, method,
    headers: { host: { value: 'zerotime.dev' } }, cookies: {}, querystring: {} } });
  const paths = ['/dist/thinker.tgz', '/dist/install.sh', '/dist/version.json'];
  for (const uri of paths) {
    assert.equal(request(uri).uri, uri);
    assert.equal(request(uri, 'HEAD').uri, uri);
    assert.equal(request(uri, 'POST').statusCode, 405);
  }
  assert.equal(request('/docs.html').statusCode, 302);
  for (const uri of ['/dist/other.json', '/dist/releases/old/thinker.tgz', '/dist/thinker.tgz/extra', '/thinker101/install.sh']) {
    assert.equal(request(uri).statusCode, 403, uri);
  }
  for (const uri of ['/dist/%74hinker.tgz', '/dist/../docs.html', '/dist//thinker.tgz']) {
    assert.equal(request(uri).statusCode, 400, uri);
  }
  for (const offset of [0, 1, 86400000]) {
    now = Date.parse(deadline) + offset;
    for (const uri of paths) for (const method of ['GET', 'HEAD']) assert.equal(request(uri, method).statusCode, 403);
  }
  const token = crypto.createHmac('sha256', config.signingKey).update('download').digest('hex');
  assert.equal(request('/access/download/' + token + '/thinker.tgz').uri, '/dist/thinker.tgz');
});
