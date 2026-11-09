import assert from 'node:assert/strict';
import tls from 'node:tls';
const base = 'https://thinker.sh';
const request = (path, method = 'GET') => fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(20000) });
const home = await request('/');
assert.equal(home.status, 200);
const html = await home.text();
assert.ok(html.includes('https://github.com/yoavshmariahu/thinker'));
assert.ok(html.includes('npx thinkersh'));
assert.ok(!html.includes('Enter access code'));
assert.ok(html.includes('/message.js'));
for (const path of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.text()).includes('<title>Documentation — thinker</title>'), path);
}
for (const path of ['/message.js', '/message.css', '/dist/install.sh', '/dist/thinker.tgz', '/dist/version.json',
  '/access/download/' + 'a'.repeat(64) + '/thinker.tgz']) assert.equal((await request(path, 'HEAD')).status, 200, path);
assert.ok(html.includes('href="/how-it-works"'));
const tour = await request('/how-it-works');
assert.equal(tour.status, 200);
assert.ok((await tour.text()).includes('<title>How it works — thinker</title>'));
assert.equal((await request('/home.css', 'HEAD')).status, 200);
const card = await request('/card.png');
assert.equal(card.status, 200);
assert.equal(card.headers.get('content-type'), 'image/png');
assert.ok(html.includes('content="https://thinker.sh/card.png"'), 'the homepage names the share card');
assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
const data = await request('/see-the-data');
assert.equal(data.status, 200);
assert.ok((await data.text()).includes('<h1>See the data</h1>'));
for (const host of ['zerotime.dev', 'www.zerotime.dev', 'www.thinker.sh']) {
  for (const path of ['/', '/docs.html', '/dist/version.json', '/see-the-data?run=click-1']) {
    const response = await request('https://' + host + path);
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), base + path);
  }
}
for (const path of ['/compression.html', '/clearing', '/see-the-data/']) {
  const response = await request(path + '?run=click-1&tag=a%2Fb&tag=c');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), base + '/see-the-data?run=click-1&tag=a%2Fb&tag=c');
}
assert.equal((await request('https://zerotime-frontend.s3.us-west-1.amazonaws.com/docs.html')).status, 403);
// What crawlers and web-filter vendors read before they categorize a site.
const robots = await request('/robots.txt');
assert.equal(robots.status, 200);
assert.match(await robots.text(), /Sitemap: https:\/\/thinker\.sh\/sitemap\.xml/);
assert.match(await (await request('/sitemap.xml')).text(), /<loc>https:\/\/thinker\.sh\/how-it-works<\/loc>/);
for (const path of ['/.well-known/security.txt', '/security.txt']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.match(await response.text(), /^Contact: https:\/\/github\.com\/yoavshmariahu\/thinker/m, path);
}
// The public headers: cacheable pages with HSTS and nosniff, where the gated site said private, no-store.
for (const path of ['/', '/docs.html', '/dist/install.sh']) {
  const response = await request(path);
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/, path);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
  assert.match(response.headers.get('cache-control') || '', /^public, max-age=\d+$/, path);
}
assert.equal((await request('/access/session')).headers.get('cache-control'), 'no-store', 'the install-command answer is still not cached');
// /dist serves the current GitHub release, which clients from before 0.1.35 still read (they refuse redirects).
const released = await (await fetch('https://github.com/yoavshmariahu/thinker/releases/latest/download/version.json', { signal: AbortSignal.timeout(20000) })).json();
assert.equal((await (await request('/dist/version.json')).json()).version, released.version, 'thinker.sh/dist is the current release');
// The certificate names this site first.
const peer = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: 'thinker.sh', port: 443, servername: 'thinker.sh' }, () => { resolve(socket.getPeerCertificate()); socket.end(); });
  socket.on('error', reject);
});
assert.equal(peer.subject.CN, 'thinker.sh');
assert.match(peer.subjectaltname, /DNS:zerotime\.dev/);
console.log('PASS: public homepage, every docs alias, message assets, current/legacy downloads, canonical data URL, domain/path redirects with query strings, private S3 origin, crawler files, public headers, current release under /dist, certificate.');
