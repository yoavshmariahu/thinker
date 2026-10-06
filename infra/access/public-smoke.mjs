import assert from 'node:assert/strict';
const base = 'https://zerotime.dev';
const request = (path, method = 'GET') => fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(20000) });
const home = await request('/');
assert.equal(home.status, 200);
const html = await home.text();
assert.ok(html.includes('https://github.com/yoavshmariahu/thinker'));
assert.ok(html.includes('curl -fsSL https://zerotime.dev/dist/install.sh | bash'));
assert.ok(!html.includes('Enter access code'));
assert.ok(html.includes('/message.js'));
for (const path of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.text()).includes('<title>Documentation — thinker</title>'), path);
}
for (const path of ['/message.js', '/message.css', '/dist/install.sh', '/dist/thinker.tgz', '/dist/version.json',
  '/access/download/' + 'a'.repeat(64) + '/thinker.tgz']) assert.equal((await request(path, 'HEAD')).status, 200, path);
assert.equal((await request('https://www.zerotime.dev/docs.html')).headers.get('location'), base + '/docs.html');
assert.equal((await request('https://zerotime-frontend.s3.us-west-1.amazonaws.com/docs.html')).status, 403);
console.log('PASS: public homepage, every docs alias, message assets, current/legacy downloads, www redirect, private S3 origin.');
