import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../infra/access/public-gateway.js', import.meta.url), 'utf8'), context);
const request = (uri, method = 'GET') => context.handler({ request: { uri, method, headers: {}, cookies: {} } });
test('public website serves docs, messages and current/legacy downloads without authorization', () => {
  for (const uri of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) assert.equal(request(uri).uri, '/docs.html');
  for (const uri of ['/clearing', '/clearing/', '/clearing.html', '/compression', '/compression/', '/compression.html']) assert.equal(request(uri).uri, '/compression.html');
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
test('homepage installs publicly and both pages expose repository and message widget', () => {
  const home = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(!home.includes('| bash'), 'the site offers the npx install only');
  assert.match(home, /<code id="cmd">npx thinkersh<\/code>/);
  assert.ok(!home.includes('zerotime.dev/dist'), 'the site no longer installs from zerotime.dev');
  assert.ok(!home.includes('Enter access code'));
  assert.ok(!home.includes('Join waitlist'));
  assert.ok(!home.includes("fetch('/access/session'"));
  for (const file of ['index.html', 'docs.html', 'compression.html']) {
    const html = fs.readFileSync(new URL('../site/' + file, import.meta.url), 'utf8');
    assert.match(html, /href="https:\/\/github.com\/yoavshmariahu\/thinker"/);
    assert.match(html, /src="\/message.js" defer/);
  }
});
test('the compression page inlines a run index and the default run, and every run file is complete', () => {
  const html = fs.readFileSync(new URL('../site/compression.html', import.meta.url), 'utf8');
  const ix = html.match(/const RUN_INDEX = \/\*RUN_INDEX\*\/(\[.*?\]);\n/s);
  assert.ok(ix, 'the run index is inlined');
  const index = JSON.parse(ix[1]);
  assert.ok(index.some(r => r.group === 'click'), 'the real session is there');
  assert.equal(new Set(index.map(r => r.group)).size, index.length, 'one example per workload');
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
    assert.ok(d.costBounds ? d.price.input === 10 && d.price.out === 50 && d.price.w1h === 12.5 : d.price.read === 0.2 && d.price.w1h === 8, `${r.id}: correct model prices`);
    assert.ok(r.summary && r.summary.cut.cost1h > 0 && r.summary.control.cost1h > 0, `${r.id}: the index carries both arms' cost`);
  }
  assert.ok(html.includes('One run per arm'), 'the caveats are stated');
  assert.ok(html.includes('list prices'), 'the price basis is stated');
});

test('the compression page\'s session view reads both runs, turn by turn, from one data file per run', () => {
  const html = fs.readFileSync(new URL('../site/compression.html', import.meta.url), 'utf8');
  assert.match(html, /clearing-\$\{id\}-session\.json/);
  assert.match(html, /id="view-session"/);
  for (const { id } of JSON.parse(fs.readFileSync(new URL('../site/clearing-runs.json', import.meta.url), 'utf8'))) {
    const f = `clearing-${id}-session.json`;
    const data = JSON.parse(fs.readFileSync(new URL('../site/' + f, import.meta.url), 'utf8'));
    for (const arm of ['cut', 'control']) {
      assert.ok(data[arm].turns.length >= 10, `${f} ${arm}: the turns`);
      for (const t of data[arm].turns) assert.ok(t.prompt && t.steps.length, `${f} ${arm} turn ${t.n} has a prompt and steps`);
      assert.doesNotMatch(JSON.stringify(data[arm].turns.map(t => t.prompt)), /\/Users\//, `${f} ${arm}: no home paths`);
    }
    assert.deepEqual(data.cut.turns.map(t => t.prompt), data.control.turns.map(t => t.prompt), `${f}: compare the same user turn`);
    const cutResults = data.cut.turns.flatMap(t => t.steps).filter(s => s.kind === 'result' && s.cutAt);
    assert.ok(cutResults.length > 0, `${f}: the cut results are marked`);
    for (const r of cutResults) assert.ok(data.blobs[r.blob], `${f}: a cut result keeps its original text`);
  }
});

test('the public pages share navigation and Compression keeps legacy links and exploration controls', () => {
  const pages = ['index', 'docs', 'compression'].map(name => fs.readFileSync(new URL(`../site/${name}.html`, import.meta.url), 'utf8'));
  const nav = html => html.match(/<div class="site-nav-right"[^>]*>[\s\S]*?<\/div>/)[0];
  for (const page of pages) {
    assert.equal(nav(page), nav(pages[0]));
    assert.match(page, /href="\/nav.css"/);
    assert.match(nav(page), />See the data<\/a>/);
  }
  const compression = pages[2];
  assert.doesNotMatch(compression, /id="play"|id="pairs-sec"|<select id="runsel"/);
  assert.ok(compression.indexOf('id="pos"') < compression.indexOf('<h2 class="chart-heading">Context window size over calls'));
  assert.match(compression, /session-saving/);
  assert.match(fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8'), /compression.html.*location.search.*location.hash/);
});

test('See the data publishes the combined MLflow comparison with complete, sanitized usage', () => {
  const html = fs.readFileSync(new URL('../site/compression.html', import.meta.url), 'utf8');
  const raw = fs.readFileSync(new URL('../site/clearing-mlflow-knowledge.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  assert.match(html, /<h1>See the data<\/h1>/);
  assert.equal(request('/clearing-mlflow-knowledge.json').uri, '/clearing-mlflow-knowledge.json');
  assert.match(html, /do not isolate knowledge caching/);
  assert.match(html, /Historical cache-building costs, setup, preflight and cancelled runs are excluded/);
  assert.doesNotMatch(raw, /\/Users\/|\/private\/|encrypted_content|authorization|responseId|localhost|127\.0\.0\.1/);
  assert.equal(data.pairs.length, 2);
  for (const pair of data.pairs) {
    for (const [arm, session] of Object.entries(pair.sessions)) {
      assert.equal(session.passed, true);
      assert.equal(session.calls.length, session.usage.requests);
      assert.ok(session.calls.every(c => c.write === 0 && c.serviceTier === 'default' && c.status === 200));
      assert.ok(session.calls.every(c => c.input === c.read + c.freshInput));
      if (arm === 'off') assert.ok(session.calls.every(c => !c.injected));
      else assert.ok(session.calls.some(c => c.injected));
      const cost = session.calls.reduce((sum, c) => sum + (c.freshInput * 10 + c.read + c.out * 50) / 1e6, 0);
      assert.ok(Math.abs(cost - session.costUsd) < 1e-8, 'published cost reconciles to captured usage');
      assert.ok(html.includes('$' + session.costUsd.toFixed(2)));
    }
    assert.ok(html.includes(pair.savingPercent.toFixed(1) + '%'));
  }
  const deploy = fs.readFileSync(new URL('../infra/access/public-deploy.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /\['compression.html', 'site\/compression.html'/);
  assert.match(deploy, /readdirSync/);
  assert.match(deploy, /'\/compression\*', '\/clearing\*'/);
});

test('Django uses API totals and an explicit cost range with judged success; mitmproxy is not offered', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL('../site/' + name, import.meta.url), 'utf8'));
  const manifest = read('clearing-runs.json');
  assert.deepEqual(manifest.map(r => r.id), ['click-1', 'django-astra']);
  const d = read('clearing-django-astra.json');
  for (const arm of ['control', 'cut']) {
    assert.equal(d[arm].turns.length, 14);
    assert.equal(d[arm].judgment.pass, true);
    assert.equal(d[arm].judgment.met, 5);
    assert.ok(d[arm].judgment.verdicts.every(v => v.verdict === 'met'));
  }
  const bounds = arm => {
    const sums = d[arm].calls.reduce((s,c) => ({input:s.input+c.input,read:s.read+c.read,out:s.out+c.out}), {input:0,read:0,out:0});
    return {min:(sums.input*10+sums.read+sums.out*50)/1e6,max:(sums.input*12.5+sums.read+sums.out*50)/1e6};
  };
  const a=bounds('cut'), b=bounds('control');
  assert.ok(Math.abs(d.savings.minDollars-(b.min-a.max))<1e-8);
  assert.ok(Math.abs(d.savings.maxDollars-(b.max-a.min))<1e-8);
  const sessionText=fs.readFileSync(new URL('../site/clearing-django-astra-session.json', import.meta.url),'utf8');
  assert.doesNotMatch(sessionText, /encrypted_content|gAAAAAB|\/Users\/yoav|\/private\/var\/folders/);
});
