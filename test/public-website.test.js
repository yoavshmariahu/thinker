import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../infra/access/public-gateway.js', import.meta.url), 'utf8'), context);
const request = (uri, method = 'GET') => context.handler({ request: { uri, method, headers: {}, cookies: {} } });
test('public website serves docs, messages and current/legacy downloads without authorization', () => {
  for (const uri of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) assert.equal(request(uri).uri, '/docs.html');
  for (const uri of ['/message.js', '/message.css', '/dist/install.sh', '/dist/thinker.tgz', '/dist/version.json']) {
    assert.equal(request(uri).uri, uri); assert.equal(request(uri, 'HEAD').uri, uri);
  }
  const legacy = '/access/download/' + 'a'.repeat(64);
  for (const name of ['install.sh', 'installer.sh', 'thinker.tgz', 'version.json']) assert.equal(request(legacy + '/' + name).uri, '/dist/' + (name === 'installer.sh' ? 'install.sh' : name));
  assert.equal(request('/access/session').statusCode, 200);
  assert.equal(request('/private/secret.json').statusCode, 404);
  assert.equal(request('/docs/../secret').statusCode, 400);
  assert.equal(request('/docs.html', 'POST').statusCode, 405);
});
test('homepage installs publicly and both pages expose repository and message widget', () => {
  const home = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(home, /curl -fsSL https:\/\/zerotime.dev\/dist\/install.sh \| bash/);
  assert.ok(!home.includes('Enter access code'));
  assert.ok(!home.includes('Join waitlist'));
  assert.ok(!home.includes("fetch('/access/session'"));
  for (const file of ['index.html', 'docs.html']) {
    const html = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8');
    assert.match(html, /href="https:\/\/github.com\/yoavshmariahu\/thinker"/);
    assert.match(html, /src="\/message.js" defer/);
  }
});
