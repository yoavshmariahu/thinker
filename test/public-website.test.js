import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../infra/access/public-gateway.js', import.meta.url), 'utf8'), context);
const request = (uri, method = 'GET') => context.handler({ request: { uri, method, headers: {}, cookies: {} } });
test('public website serves docs, messages and current/legacy downloads without authorization', () => {
  for (const uri of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) assert.equal(request(uri).uri, '/docs.html');
  for (const uri of ['/clearing', '/clearing/', '/clearing.html']) assert.equal(request(uri).uri, '/clearing.html');
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
  assert.ok(!home.includes('| bash'), 'the site offers the npx install only');
  assert.match(home, /<code id="cmd">npx @zerotimedev\/thinker<\/code>/);
  assert.ok(!home.includes('zerotime.dev/dist'), 'the site no longer installs from zerotime.dev');
  assert.ok(!home.includes('Enter access code'));
  assert.ok(!home.includes('Join waitlist'));
  assert.ok(!home.includes("fetch('/access/session'"));
  for (const file of ['index.html', 'docs.html', 'clearing.html']) {
    const html = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8');
    assert.match(html, /href="https:\/\/github.com\/yoavshmariahu\/thinker"/);
    assert.match(html, /src="\/message.js" defer/);
  }
});
test('the clearing page is one paired run, with its data inline and its caveats stated', () => {
  const html = fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8');
  const data = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)[1]);
  assert.equal(data.cut.length, 29); assert.equal(data.control.length, 30);
  assert.equal(data.cut.filter(c => c.cut).length, 4, 'four cuts, each at the first call of a turn');
  for (const c of data.cut) if (c.cut) assert.ok(c.t >= 3 && data.cut.find(x => x.t === c.t) === c);
  assert.equal(data.results.filter(r => r.cut).length, 24);
  assert.ok(!/Users\/|\.worktrees|\.js\b/.test(JSON.stringify(data)), 'no paths or file names leave the machine');
  assert.match(html, /One run per arm/);
  assert.match(html, /The control ran second/);
  assert.match(html, /href="index.html" class="nav-brand"/);
  const home = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(home, /href="clearing.html"/);
});
