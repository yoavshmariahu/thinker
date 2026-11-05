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
      assert.ok(d[arm].turns.length >= 9, `${r.id} ${arm}: the turns`);
      for (const c of d[arm].calls) assert.ok(c.read >= 0 && c.write >= 0 && c.t >= 1, `${r.id} ${arm} call ${c.k} is complete`);
    }
    assert.ok(d.control.calls.every(c => !c.cut), `${r.id}: the control was never cut`);
    assert.ok(d.protocol === 'responses' ? d.price.input === 10 && d.price.out === 50 && d.price.w1h === (d.codexBilling ? 0 : 12.5) : d.price.read === 0.2 && d.price.w1h === 8, `${r.id}: correct model prices`);
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
      assert.ok(data[arm].turns.length >= 9, `${f} ${arm}: the turns`);
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
    assert.match(nav(page), /href="\/see-the-data"/);
  }
  const compression = pages[2];
  assert.doesNotMatch(compression, /id="play"|id="pairs-sec"|<select id="runsel"/);
  assert.ok(compression.indexOf('id="pos"') < compression.indexOf('<h2 class="chart-heading">Context window size over calls'));
  assert.match(compression, /session-saving/);
  assert.match(fs.readFileSync(new URL('../site/clearing.html', import.meta.url), 'utf8'), /\/see-the-data.*location.search.*location.hash/);
});

test('See the data publishes the combined MLflow comparison with complete, sanitized usage', () => {
  const html = fs.readFileSync(new URL('../site/compression.html', import.meta.url), 'utf8');
  const raw = fs.readFileSync(new URL('../site/clearing-mlflow-knowledge.json', import.meta.url), 'utf8');
  const spanRaw = fs.readFileSync(new URL('../site/clearing-mlflow-span-costs.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw), span = JSON.parse(spanRaw);
  assert.match(html, /<h1>See the data<\/h1>/);
  assert.equal(request('/clearing-mlflow-knowledge.json').uri, '/clearing-mlflow-knowledge.json');
  assert.match(html, /not knowledge caching alone/);
  assert.doesNotMatch(html, /class="benchmark"|what the model sees now/);
  assert.match(html, /Historical cache-building costs, setup, preflight and cancelled runs are excluded/);
  assert.doesNotMatch(raw, /\/Users\/|\/private\/|encrypted_content|authorization|responseId|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(spanRaw, /\/Users\/|\/private\/|encrypted_content|authorization|responseId|localhost|127\.0\.0\.1/);
  assert.equal(data.pairs.length, 2);
  assert.equal(span.pairs.length, 1);
  for (const pair of [...data.pairs, ...span.pairs]) {
    for (const [arm, session] of Object.entries(pair.sessions)) {
      assert.equal(session.passed, true);
      assert.equal(session.calls.length, session.usage.requests);
      assert.ok(session.calls.every(c => c.write === 0 && c.serviceTier === 'default' && c.status === 200));
      assert.ok(session.calls.every(c => c.input === c.read + c.freshInput));
      if (arm === 'off') assert.ok(session.calls.every(c => !c.injected));
      else assert.ok(session.calls.some(c => c.injected));
      const cost = session.calls.reduce((sum, c) => sum + (c.freshInput * 10 + c.read + c.out * 50) / 1e6, 0);
      assert.ok(Math.abs(cost - session.costUsd) < 1e-8, 'published cost reconciles to captured usage');
      const id = {'PR26291-hard':'mlflow-registry', 'PR26300-hard':'mlflow-gateway', 'PR26307-hard':'mlflow-span'}[pair.task];
      const explorer = JSON.parse(fs.readFileSync(new URL(`../site/clearing-${id}.json`, import.meta.url), 'utf8'));
      const calls = explorer[arm === 'off' ? 'control' : 'cut'].calls;
      const events = explorer[arm === 'off' ? 'control' : 'cut'].knowledgeEvents;
      assert.equal(events.length, arm === 'off' ? 0 : 1);
      for (const e of events) {
        assert.equal(e.k, 1); assert.equal(e.hits, 1);
        assert.equal(e.actualReadSaving, null, 'potential reading must not become a measured savings claim');
        assert.equal(e.estimate.fileTokenCap, 6000);
        assert.equal(e.sourceReadTokens, e.sources.reduce((n,s) => n+s.readTokens, 0));
        assert.equal(e.potentialReadSaving, Math.max(0, e.sourceReadTokens-e.noteTokens));
        assert.ok(e.sources.every(s => s.sha256.length === 64 && s.bytes > 0));
        const transcript = JSON.parse(fs.readFileSync(new URL(`../site/clearing-${id}-session.json`, import.meta.url), 'utf8'));
        assert.deepEqual(transcript.cut.knowledgeEvents, events, 'metrics and transcript use the same event evidence');
        assert.ok(transcript.cut.turns[0].steps.some(s => s.kind === 'knowledge' && s.k === e.k));
      }
      assert.equal(calls.length, session.calls.length);
      assert.ok(Math.abs(calls.reduce((n,c) => n+(c.input*10+c.read+c.out*50)/1e6,0)-session.costUsd)<1e-8);
    }
    assert.ok(html.includes(pair.savingPercent.toString()));
  }
  const deploy = fs.readFileSync(new URL('../infra/access/public-deploy.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /\['compression.html', 'site\/compression.html'/);
  assert.match(deploy, /readdirSync/);
  assert.match(deploy, /'\/compression\*', '\/clearing\*'/);
});

test('Django uses recorded input without a separate Codex write charge and retains judged success; mitmproxy is not offered', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL('../site/' + name, import.meta.url), 'utf8'));
  const manifest = read('clearing-runs.json');
  assert.deepEqual(manifest.slice(0,5).map(r => r.id), ['click-1', 'django-astra', 'mlflow-registry', 'mlflow-gateway', 'mlflow-span']);
  for (const entry of manifest.slice(5)) {
    assert.match(entry.id, /^posthog-/);
    const data=read(`clearing-${entry.id}.json`), accounting=read(`clearing-${entry.id}-costs.json`), transcript=read(`clearing-${entry.id}-session.json`);
    assert.equal(data.recordedTTL,true);
    for (const [arm,side] of [['control','off'],['cut','on']]) {
      const calls=data[arm].calls;
      assert.equal(data[arm].turns.length,9);
      assert.equal(calls.length,accounting.sessions[side].calls.length);
      assert.ok(calls.every(c=>c.write===c.write1h+c.write5m));
      const price=calls.reduce((n,c)=>n+(c.input*4+c.read*.2+c.write1h*8+c.write5m*5+c.out*20)/1e6,0);
      assert.ok(Math.abs(price-accounting.sessions[side].cost)<1e-8,'measured write lifetimes reconcile to Artemis pricing');
      assert.equal(data[arm].judgment.pass,accounting.sessions[side].pass);
      assert.deepEqual(data[arm].knowledgeEvents,transcript[arm].knowledgeEvents);
    }
    assert.equal(data.control.knowledgeEvents.length,0);
    assert.ok(data.control.calls.every(c=>!c.cut));
  }
  const d = read('clearing-django-astra.json');
  for (const arm of ['control', 'cut']) {
    assert.equal(d[arm].turns.length, 14);
    assert.equal(d[arm].judgment.pass, true);
    assert.equal(d[arm].judgment.met, 5);
    assert.ok(d[arm].judgment.verdicts.every(v => v.verdict === 'met'));
  }
  assert.equal(d.codexBilling,true);
  assert.equal(d.writeCountsRecorded,false,'missing physical counters stay missing');
  assert.equal(d.costBounds,undefined);
  assert.equal(d.savings,undefined,'derive the headline from the same costs as the chart');
  assert.equal(d.price.w1h,0);assert.equal(d.price.w5m,0);
  const html=fs.readFileSync(new URL('../site/compression.html',import.meta.url),'utf8');
  const index=JSON.parse(html.match(/const RUN_INDEX = \/\*RUN_INDEX\*\/(.+?);\n/)[1]);
  const summary=index.find(r=>r.id==='django-astra').summary;
  for(const arm of ['control','cut']) {
    const cost=d[arm].calls.reduce((n,c)=>n+(c.input*10+c.read+c.out*50)/1e6,0);
    assert.ok(Math.abs(summary[arm].cost1h-cost)<1e-8);
    assert.ok(Math.abs(summary[arm].cost5m-cost)<1e-8);
  }
  assert.equal(summary.savings,undefined,'no obsolete range in the session selector');
  const sessionText=fs.readFileSync(new URL('../site/clearing-django-astra-session.json', import.meta.url),'utf8');
  assert.doesNotMatch(sessionText, /encrypted_content|gAAAAAB|\/Users\/yoav|\/private\/var\/folders/);
});
