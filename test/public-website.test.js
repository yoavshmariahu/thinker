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
  for (const f of ['/clearing-click-1.json', '/clearing-click-1-session.json', '/clearing-click-2.json', '/clearing-runs.json']) assert.equal(request(f).uri, f);
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
test('the clearing page inlines a run index and the default run, and every run file is complete', () => {
  const html = fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8');
  const ix = html.match(/const RUN_INDEX = \/\*RUN_INDEX\*\/(\[.*?\]);\n/s);
  assert.ok(ix, 'the run index is inlined');
  const index = JSON.parse(ix[1]);
  assert.ok(index.some(r => r.group === 'click'), 'the real session is there');
  const m = html.match(/const RUN_DATA = \/\*RUN_DATA\*\/(\{.*?\});\n/s);
  assert.ok(m, 'the default run is inlined');
  const inlined = JSON.parse(m[1]);
  assert.equal(Object.keys(inlined).length, 1, 'one run inlined, the rest fetched');
  for (const r of index) {
    const d = JSON.parse(fs.readFileSync(new URL(`../site/clearing-${r.id}.json`, import.meta.url), 'utf8'));
    for (const arm of ['cut', 'control']) {
      assert.ok(d[arm].calls.length > 10, `${r.id} ${arm}: every model call`);
      assert.ok(d[arm].turns.length >= 10, `${r.id} ${arm}: the turns`);
      for (const c of d[arm].calls) assert.ok(c.read >= 0 && c.write >= 0 && c.t >= 1, `${r.id} ${arm} call ${c.k} is complete`);
    }
    assert.ok(d.control.calls.every(c => !c.cut), `${r.id}: the control was never cut`);
    assert.ok(d.price && d.price.read === 0.2 && d.price.w1h === 8, `${r.id}: Opus 5.5 list prices`);
    assert.ok(r.summary && r.summary.cut.cost1h > 0 && r.summary.control.cost1h > 0, `${r.id}: the index carries both arms' cost`);
  }
  assert.ok(html.includes('One run per arm'), 'the caveats are stated');
  assert.ok(html.includes('list prices'), 'the price basis is stated');
});

test('the clearing page\'s session view reads both runs, turn by turn, from one data file per run', () => {
  const html = fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8');
  assert.match(html, /clearing-\$\{id\}-session\.json/);
  assert.match(html, /id="view-session"/);
  for (const f of fs.readdirSync(new URL('../site', import.meta.url)).filter(f => /^clearing-.*-session\.json$/.test(f))) {
    const data = JSON.parse(fs.readFileSync(new URL('../site/' + f, import.meta.url), 'utf8'));
    for (const arm of ['cut', 'control']) {
      assert.ok(data[arm].turns.length >= 10, `${f} ${arm}: the turns`);
      for (const t of data[arm].turns) assert.ok(t.prompt && t.steps.length, `${f} ${arm} turn ${t.n} has a prompt and steps`);
      assert.doesNotMatch(JSON.stringify(data[arm].turns.map(t => t.prompt)), /\/Users\//, `${f} ${arm}: no home paths`);
    }
    const cutResults = data.cut.turns.flatMap(t => t.steps).filter(s => s.kind === 'result' && s.cutAt);
    assert.ok(cutResults.length > 0, `${f}: the cut results are marked`);
    for (const r of cutResults) assert.ok(data.blobs[r.blob], `${f}: a cut result keeps its original text`);
  }
});
