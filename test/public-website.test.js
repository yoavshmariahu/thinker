import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../infra/access/public-gateway.js', import.meta.url), 'utf8'), context);
const request = (uri, method = 'GET', host = 'thinker.sh', querystring = {}) => context.handler({ request: { uri, method, headers: { host: { value: host } }, querystring, cookies: {} } });
test('public website serves docs, messages and current/legacy downloads without authorization', () => {
  for (const uri of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) assert.equal(request(uri).uri, '/docs.html');
  assert.equal(request('/see-the-data').uri, '/compression.html');
  for (const f of ['/clearing-click-1.json', '/clearing-click-1-session.json', '/clearing-click-2.json', '/clearing-runs.json']) assert.equal(request(f).uri, f);
  for (const uri of ['/nav.css', '/message.js', '/message.css', '/dist/install.sh', '/dist/thinker.tgz', '/dist/version.json']) {
    assert.equal(request(uri).uri, uri); assert.equal(request(uri, 'HEAD').uri, uri);
  }
  const legacy = '/access/download/' + 'a'.repeat(64);
  for (const name of ['install.sh', 'installer.sh', 'thinker.tgz', 'version.json']) assert.equal(request(legacy + '/' + name).uri, '/dist/' + (name === 'installer.sh' ? 'install.sh' : name));
  assert.equal(request('/access/session').statusCode, 200);
  assert.equal(request('/private/secret.json').statusCode, 404);
  assert.equal(request('/docs/../secret').statusCode, 400);
  assert.equal(request('/docs.html', 'POST').statusCode, 405);
});
test('old domains and data URLs redirect directly to thinker.sh, retaining encoded and repeated query values', () => {
  const query = { run: { value: 'click-1' }, tag: { value: 'a%2Fb', multiValue: [{ value: 'a%2Fb' }, { value: 'c+d' }] }, empty: { value: '' } };
  const suffix = '?run=click-1&tag=a%2Fb&tag=c+d&empty=';
  for (const host of ['thinker.sh', 'zerotime.dev', 'www.zerotime.dev', 'www.thinker.sh']) {
    for (const uri of ['/clearing', '/clearing/', '/clearing.html', '/compression', '/compression/', '/compression.html', '/see-the-data/', '/see-the-data.html']) {
      for (const method of ['GET', 'HEAD']) {
        const response = request(uri, method, host, query);
        assert.equal(response.statusCode, 301);
        assert.equal(response.headers.location.value, 'https://thinker.sh/see-the-data' + suffix);
      }
    }
    if (host === 'thinker.sh') continue;
    for (const uri of ['/', '/docs.html', '/see-the-data', '/dist/version.json', '/gokce-bday/']) {
      const response = request(uri, 'GET', host, query);
      assert.equal(response.statusCode, 301);
      assert.equal(response.headers.location.value, 'https://thinker.sh' + uri + suffix);
    }
  }
  assert.equal(request('/').uri, '/', 'canonical homepage does not loop');
  assert.equal(request('/see-the-data', 'HEAD').uri, '/compression.html');
});
test('the walkthrough has a public shareable page and canonical aliases', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(request('/how-it-works', method).uri, '/how-it-works.html');
    assert.equal(request('/home.css', method).uri, '/home.css');
    for (const host of ['thinker.sh', 'zerotime.dev', 'www.thinker.sh']) {
      for (const uri of ['/how-it-works/', '/how-it-works.html']) {
        const response = request(uri, method, host, { ref: { value: 'shared' } });
        assert.equal(response.statusCode, 301);
        assert.equal(response.headers.location.value, 'https://thinker.sh/how-it-works?ref=shared');
      }
    }
  }
  assert.equal(request('/how-it-works', 'POST').statusCode, 405);
});
test('homepage installs publicly and both pages expose repository and message widget', () => {
  const home = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(!home.includes('| bash'), 'the site offers the npx install only');
  assert.match(home, /<code id="cmd">npx thinkersh<\/code>/);
  assert.ok(!home.includes('zerotime.dev/dist'), 'the site no longer installs from zerotime.dev');
  assert.ok(!home.includes('Enter access code'));
  assert.ok(!home.includes('Join waitlist'));
  assert.ok(!home.includes("fetch('/access/session'"));
  for (const file of ['index.html', 'docs.html', 'compression.html', 'how-it-works.html']) {
    const html = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8');
    assert.match(html, /href="https:\/\/github.com\/yoavshmariahu\/thinker"/);
    assert.match(html, /src="\/message.js" defer/);
  }
});
// The published run data is frozen: nothing in this repository regenerates site/clearing-*.json, so the
// arithmetic that used to be reconciled here -- cost sums to 1e-8, turn and call counts, judged verdicts,
// the headline percentage -- could only ever fail if a person hand-edited a shipped file, and it broke on
// every new run instead. What a test can still catch is a run the page references but the deploy never
// publishes, and a capture that carries a home path or a credential into the open.
test('every published run file the compression page references is served and carries nothing private', () => {
  const site = name => fs.readFileSync(new URL('../site/' + name, import.meta.url), 'utf8');
  const html = site('compression.html');
  const index = JSON.parse(html.match(/const RUN_INDEX = \/\*RUN_INDEX\*\/(\[.*?\]);\n/s)[1]);
  assert.ok(index.length > 0, 'the run index is inlined');
  assert.equal(new Set(index.map(r => r.group)).size, index.length, 'one example per workload');
  assert.equal(Object.keys(JSON.parse(html.match(/const RUN_DATA = \/\*RUN_DATA\*\/(\{.*?\});\n/s)[1])).length, 1,
    'one run inlined, the rest fetched');
  assert.deepEqual(JSON.parse(site('clearing-runs.json')).map(r => r.id), index.map(r => r.id),
    'the inlined index and the fetched manifest name the same runs');
  // A home path or an encrypted reasoning blob must never reach a published file. The session captures
  // legitimately quote "authorization" and "localhost" out of the recorded work, so the stricter sweep is the
  // metrics files only -- that split is why this was four tests reconciling arithmetic nobody regenerates.
  const LEAK = /encrypted_content|gAAAAAB|\/Users\/yoav|\/private\/var\/folders/;
  const STRICT = /\/Users\/|\/private\/|encrypted_content|authorization|responseId|localhost|127\.0\.0\.1/;
  for (const { id } of index) {
    for (const f of [`clearing-${id}.json`, `clearing-${id}-session.json`]) {
      const raw = site(f);
      JSON.parse(raw);
      assert.doesNotMatch(raw, LEAK, `${f} carries a home path or an encrypted blob`);
      assert.equal(request("/" + f).uri, "/" + f, `${f} is served without authorization`);
    }
    assert.doesNotMatch(site(`clearing-${id}.json`), STRICT, `clearing-${id}.json is a metrics file and must be clean`);
  }
  for (const f of ["clearing-mlflow-knowledge.json", "clearing-mlflow-span-costs.json"]) {
    assert.doesNotMatch(site(f), STRICT, `${f} must be clean`);
    assert.equal(request("/" + f).uri, "/" + f, `${f} is served`);
  }
  assert.ok(html.includes('One run per arm'), 'the caveats are stated');
  assert.ok(html.includes('list prices'), 'the price basis is stated');
  // the data files reach the bucket: public-deploy.mjs walks site/ and the distribution passes /clearing*
  const deploy = fs.readFileSync(new URL('../infra/access/public-deploy.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /\['compression.html', 'site\/compression.html'/);
  assert.match(deploy, /readdirSync/);
  assert.match(deploy, /'\/compression\*', '\/clearing\*'/);
});

test('the public pages share navigation and Compression keeps legacy links and exploration controls', () => {
  const pages = ['index', 'docs', 'compression', 'how-it-works'].map(name => fs.readFileSync(new URL(`../site/${name}.html`, import.meta.url), 'utf8'));
  const nav = html => html.match(/<div class="site-nav-right"[^>]*>[\s\S]*?<\/div>/)[0];
  for (const page of pages) {
    assert.equal(nav(page), nav(pages[0]));
    assert.match(page, /href="\/nav.css"/);
    assert.match(nav(page), />See the data<\/a>/);
    assert.match(nav(page), /href="\/see-the-data"/);
  }
  const compression = pages[2];
  assert.doesNotMatch(compression, /id="play"|id="pairs-sec"|<select id="runsel"/);
  assert.ok(compression.indexOf('id="pos"') < compression.indexOf('<h2 class="chart-heading">Context window size over calls'));
  assert.match(compression, /session-saving/);
  assert.match(fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8'), /\/see-the-data.*location.search.*location.hash/);
});

test('every public page names one 1200x630 share card, and the card is served and deployed', () => {
  const card = fs.readFileSync(new URL('../site/card.png', import.meta.url));
  assert.equal(card.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'a PNG');
  assert.equal(card.readUInt32BE(16), 1200, 'the width link previews expect');
  assert.equal(card.readUInt32BE(20), 630, 'the height link previews expect');
  assert.ok(card.length < 5e6, 'under the 5MB X accepts');
  for (const method of ['GET', 'HEAD']) assert.equal(request('/card.png', method).uri, '/card.png');
  for (const file of ['index.html', 'docs.html', 'compression.html', 'how-it-works.html']) {
    const html = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8');
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, file);
    // Absolute: a relative URL is not fetched by the crawlers.
    assert.match(html, /<meta property="og:image" content="https:\/\/thinker\.sh\/card\.png">/, file);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/thinker\.sh\/card\.png">/, file);
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)[1];
    assert.match(html, new RegExp(`<meta property="og:url" content="${canonical.replace(/[.\/]/g, '\\$&')}">`), file);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+">/, file);
  }
  const deploy = fs.readFileSync(new URL('../infra/access/public-deploy.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /\['card.png', 'site\/card.png', 'image\/png'\]/, 'uploaded with its own type');
  assert.match(deploy, /'\/card\.png'.*'\/message\.\*'/, 'and invalidated at the edge');
});

test('the site carries what crawlers and web-filter vendors read before categorizing it (2026-11-09)', async () => {
  // thinker.sh was registered on 2026-11-04 and company filters block a new, thin, uncategorized domain
  // serving a shell script; these files, the public headers and the certificate are what a categorizer looks at.
  for (const method of ['GET', 'HEAD']) {
    for (const uri of ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt']) assert.equal(request(uri, method).uri, uri);
    assert.equal(request('/security.txt', method).uri, '/.well-known/security.txt', 'the RFC 9116 legacy location');
  }
  assert.equal(request('/.well-known/other', 'GET').statusCode, 404);
  const robots = fs.readFileSync(new URL('../site/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/thinker\.sh\/sitemap\.xml$/m);
  const sitemap = fs.readFileSync(new URL('../site/sitemap.xml', import.meta.url), 'utf8');
  for (const file of ['index.html', 'docs.html', 'compression.html', 'how-it-works.html']) {
    const canonical = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8').match(/<link rel="canonical" href="([^"]+)">/)[1];
    assert.ok(sitemap.includes(`<loc>${canonical}</loc>`), `${file}'s canonical URL is in the sitemap`);
  }
  const security = fs.readFileSync(new URL('../site/security.txt', import.meta.url), 'utf8');
  assert.match(security, /^Contact: https:\/\/github\.com\/yoavshmariahu\/thinker\//m);
  assert.match(security, /^Canonical: https:\/\/thinker\.sh\/\.well-known\/security\.txt$/m);
  const expires = Date.parse(security.match(/^Expires: (\S+)$/m)[1]);
  assert.ok(expires > Date.now(), 'security.txt has expired; move Expires forward');
  assert.ok(expires < Date.now() + 400 * 86400e3, 'RFC 9116 wants Expires within a year');
  assert.doesNotMatch(security, /@/, 'no address a scraper can harvest');
  const { RESPONSE_POLICY, cacheControlFor } = await import('../infra/access/public-headers.mjs');
  const policy = RESPONSE_POLICY('x');
  assert.equal(policy.SecurityHeadersConfig.StrictTransportSecurity.AccessControlMaxAgeSec, 31536000);
  assert.equal(policy.SecurityHeadersConfig.StrictTransportSecurity.IncludeSubdomains, false, 'zerotime.dev has other subdomains');
  assert.ok(policy.SecurityHeadersConfig.ContentTypeOptions.Override);
  assert.equal(policy.SecurityHeadersConfig.FrameOptions.FrameOption, 'DENY');
  const cache = policy.CustomHeadersConfig.Items.find(h => h.Header === 'Cache-Control');
  assert.doesNotMatch(cache.Value, /no-store|private/, 'the public site is cacheable');
  assert.equal(cache.Override, false, 'the function\'s no-store on /access/session and each upload\'s value stand');
  assert.match(cacheControlFor('index.html'), /^public, max-age=300$/);
  assert.match(cacheControlFor('dist/version.json'), /^public, max-age=300$/);
  assert.match(cacheControlFor('card.png'), /^public, max-age=86400$/);
  assert.match(cacheControlFor('clearing-click-1-session.json'), /^public, max-age=86400$/);
  const deploy = fs.readFileSync(new URL('../infra/access/public-deploy.mjs', import.meta.url), 'utf8');
  for (const key of ['robots.txt', 'sitemap.xml', '.well-known/security.txt', 'dist/version.json', 'dist/thinker.tgz']) assert.ok(deploy.includes(`['${key}', `), `${key} is deployed`);
  assert.match(deploy, /cacheControlFor\(key\)/, 'uploads carry the public cache control');
  assert.match(deploy, /update-response-headers-policy/);
  assert.match(deploy, /redirect to GitHub would strand them/, 'the pre-0.1.35 updater refuses redirects, so /dist is a copy');
  assert.match(deploy, /'\/\.well-known\/\*', '\/dist\/\*'/, 'and invalidated at the edge');
  const production = JSON.parse(fs.readFileSync(new URL('../infra/access/production.json', import.meta.url), 'utf8'));
  assert.match(production.certificateArn, /^arn:aws:acm:us-east-1:\d+:certificate\//);
});
