// Thinker Evals: experiments compared cache off against cache on. Hash-routed over the evals API.
const $app = document.getElementById('app');
const $tip = document.getElementById('tip');
const $drawer = document.getElementById('drawer');

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
let pageVersion = null;
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  // the app was updated since this page loaded: its code here is stale
  const v = r.headers.get('x-evals-version');
  if (v && pageVersion && v !== pageVersion) document.getElementById('stale').hidden = false;
  pageVersion ||= v;
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (j.redirect) { location.hash = j.redirect; throw new Error('moved'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const fmt = {
  n: v => v == null ? '–' : Math.round(v).toLocaleString(),
  tok: v => v == null ? '–' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : Math.round(v).toString(),
  ms: v => { if (v == null) return '–'; const s = Math.abs(v) / 1000, sign = v < 0 ? '−' : ''; return s < 90 ? sign + s.toFixed(0) + 's' : s < 5400 ? sign + (s / 60).toFixed(1) + 'm' : sign + (s / 3600).toFixed(1) + 'h'; },
  pct: v => v == null ? '–' : (v * 100).toFixed(0) + '%',
  usd: v => v == null ? '–' : '$' + (Math.abs(v) < 10 ? Math.abs(v).toFixed(2) : Math.abs(v).toFixed(0)),
  date: t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '–',
  dt: t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–',
  ago: t => { if (!t) return '–'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; },
};
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '±');
// a difference on − off, in the metric's own unit
const fmtDelta = {
  share: v => v == null ? '–' : `${sign(v)}${Math.abs(v * 100).toFixed(0)} pts`,
  tokens: v => v == null ? '–' : `${sign(v)}${fmt.tok(Math.abs(v))}`,
  count: v => v == null ? '–' : `${sign(v)}${Math.abs(v).toFixed(1)}`,
  ms: v => v == null ? '–' : `${sign(v)}${fmt.ms(Math.abs(v))}`,
  usd: v => v == null ? '–' : `${sign(v)}${fmt.usd(Math.abs(v))}`,
};
const fmtValue = { share: fmt.pct, tokens: fmt.tok, count: v => (v == null ? '–' : (+v).toFixed(0)), ms: fmt.ms, usd: fmt.usd };

function verdict(d, better) {
  if (!d || d.mean == null) return { key: 'none', label: '–' };
  if (d.lo == null) return { key: 'few', label: 'too few pairs' };
  if (d.lo <= 0 && d.hi >= 0) return { key: 'same', label: 'no clear difference' };
  return (better === 'up') === (d.mean > 0) ? { key: 'better', label: 'cache better' } : { key: 'worse', label: 'cache worse' };
}
const verdictBadge = v => v.key === 'better' ? `<span class="status good">${v.label}</span>` : v.key === 'worse' ? `<span class="status critical">${v.label}</span>` : `<span class="muted">${v.label}</span>`;

function tip(e, html) { $tip.innerHTML = html; $tip.hidden = false; const x = Math.min(e.clientX + 14, innerWidth - $tip.offsetWidth - 8), y = Math.min(e.clientY + 14, innerHeight - $tip.offsetHeight - 8); $tip.style.left = x + 'px'; $tip.style.top = y + 'px'; }
function bindTips(root) { root.querySelectorAll('[data-tip]').forEach(el => { el.addEventListener('mousemove', e => tip(e, el.dataset.tip)); el.addEventListener('mouseleave', () => { $tip.hidden = true; }); }); }
const tipAttr = html => `data-tip="${esc(html)}"`;
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }

function sortable(table) {
  table.querySelectorAll('th.sort').forEach(th => th.addEventListener('click', () => {
    const idx = [...th.parentNode.children].indexOf(th), dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
    table.querySelectorAll('th').forEach(t => delete t.dataset.dir); th.dataset.dir = dir;
    const rows = [...table.tBodies[0].rows];
    rows.sort((a, b) => { const x = a.cells[idx].dataset.v ?? a.cells[idx].textContent, y = b.cells[idx].dataset.v ?? b.cells[idx].textContent; const nx = Number(x), ny = Number(y); const c = x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny) ? nx - ny : String(x).localeCompare(String(y)); return dir === 'asc' ? c : -c; });
    rows.forEach(r => table.tBodies[0].appendChild(r));
  }));
}

// ---------- routing ----------
let pollTimer = null;
const routes = [
  [/^#?\/?$/, pageExperiments], [/^#\/exp\/(.+)$/, pageExperiment], [/^#\/prs$/, pagePRs], [/^#\/pr\/(.+)$/, pagePR],
  [/^#\/new$/, pageNew], [/^#\/prsets$/, pagePrsets], [/^#\/caches$/, pageCaches], [/^#\/cache\/(.+)$/, pageCache],
  [/^#\/session\/(.+)$/, pageSession],
];
async function route() {
  clearInterval(pollTimer); $tip.hidden = true;
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (!m) continue;
    const section = h.startsWith('#/prsets') ? 'prsets' : h.startsWith('#/cache') ? 'caches' : h.startsWith('#/pr') ? 'prs' : h.startsWith('#/new') ? 'new' : 'experiments';
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === section));
    try { await fn(...m.slice(1).map(x => (x == null ? x : decodeURIComponent(x)))); } catch (e) { if (e.message !== 'moved') $app.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    return;
  }
  $app.innerHTML = '<p>Not found.</p>';
}
addEventListener('hashchange', route);



// ---------- experiments ----------
const expName = e => e.meta.name || e.dir;
const kindChip = k => k ? `<span class="pill kind">${esc(k)}</span>` : '<span class="pill muted">kind not set</span>';

async function pageExperiments() {
  const s = await api('/api/experiments');
  document.getElementById('scan').textContent = `indexed ${fmt.ago(s.scanned_at)}`;
  const repos = [...new Set(s.experiments.flatMap(e => (e.repo || '').split(',')).filter(Boolean))].sort();
  const models = [...new Set(s.experiments.flatMap(e => (e.models || '').split(',')).filter(Boolean))].sort();
  const st = JSON.parse(sessionGet('expFilter') || '{}');
  const compared = s.experiments.filter(e => e.cmp?.pairs);
  $app.innerHTML = `
    <div class="head"><div><h1>Experiments</h1>
    <p class="sub">Each experiment runs a set of PRs with the cache off and with it on, to test one behavior or one model. The numbers are paired: the same PR and rep on both sides, invalid results left out.</p></div>
    <a class="button primary" href="#/new">New experiment</a></div>
    <div class="filters">
      <input id="q" placeholder="Search experiments…" value="${esc(st.q || '')}" aria-label="Search experiments">
      <select id="repo" aria-label="Repository"><option value="">All repositories</option>${repos.map(r => `<option ${st.repo === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <select id="model" aria-label="Model"><option value="">All models</option>${models.map(r => `<option ${st.model === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <select id="kind" aria-label="Kind"><option value="">Behavior and model</option><option value="behavior" ${st.kind === 'behavior' ? 'selected' : ''}>Behavior</option><option value="model" ${st.kind === 'model' ? 'selected' : ''}>Model</option></select>
      <label class="check"><input type="checkbox" id="onlycmp" ${st.onlycmp !== false ? 'checked' : ''}> Only with a cache-off arm</label>
      <span class="muted" style="margin-left:auto">${compared.length} of ${s.experiments.length} compare cache off and on</span>
    </div>
    <div class="card wrap"><table id="exps"><thead><tr>
      <th class="sort">Experiment</th><th class="sort">Repo · model</th><th class="sort num">PRs</th>
      <th class="sort num" title="Pass rate, cache off → cache on">Pass rate off → on</th>
      <th class="sort num" title="Paired mean difference in input tokens, as a share of the cache-off median">Input tokens</th>
      <th class="sort num">Tool calls</th><th class="sort num">Wall time</th><th class="sort num">Served</th><th class="sort">Date</th><th>Status</th>
    </tr></thead><tbody></tbody></table></div>
    <p class="muted small">Database <code>${esc(s.store.db)}</code> · last snapshot ${s.store.snapshot ? fmt.ago(s.store.snapshot.at) : 'none yet'}${s.store.s3 ? ` · copied to <code>${esc(s.store.s3)}</code>` : ' · <b>no S3 bucket set (EVALS_S3_URI): snapshots are local only</b>'}${s.store.last?.uploadError ? ` · <span class="err">last upload failed: ${esc(s.store.last.uploadError)}</span>` : ''}</p>
    <p class="muted small">Differences are cache on − cache off, as a share of the cache-off median. Colored where the 90% interval excludes zero: <span class="status good">cache better</span> <span class="status critical">cache worse</span>. Hover a number for its interval and pair count.</p>`;
  const [q, repo, model, kind, onlycmp] = ['q', 'repo', 'model', 'kind', 'onlycmp'].map(id => document.getElementById(id));
  const draw = () => {
    const f = { q: q.value.toLowerCase(), repo: repo.value, model: model.value, kind: kind.value, onlycmp: onlycmp.checked };
    sessionSet('expFilter', JSON.stringify(f));
    const rows = s.experiments.filter(e => (!f.q || (expName(e) + ' ' + e.dir + ' ' + (e.meta.question || '')).toLowerCase().includes(f.q)) && (!f.repo || (e.repo || '').split(',').includes(f.repo))
      && (!f.model || (e.models || '').split(',').includes(f.model)) && (!f.kind || e.meta.kind === f.kind) && (!f.onlycmp || e.meta.off));
    document.querySelector('#exps tbody').innerHTML = rows.map(e => expRow(e, s.metrics)).join('') || '<tr><td colspan="10" class="muted">No experiments match.</td></tr>';
    document.querySelectorAll('#exps tr.click').forEach(tr => tr.addEventListener('click', ev => { if (ev.target.tagName !== 'A') location.hash = tr.dataset.href; }));
    bindTips($app);
  };
  [q, repo, model, kind, onlycmp].forEach(el => el.addEventListener('input', draw));
  draw(); sortable(document.getElementById('exps'));
  // while an experiment runs, the list redraws itself
  if (s.experiments.some(e => e.job?.status === 'running')) pollTimer = setInterval(() => { if (!document.querySelector('#exps th[data-dir]')) route(); }, 5000);
}

function expRow(e, metrics) {
  const c = e.cmp, M = Object.fromEntries(metrics.map(m => [m.key, m]));
  const rel = k => {
    if (!c?.pairs) return '<td class="num muted">–</td>';
    const d = c.delta[k], base = c.off[k], m = M[k];
    const v = verdict(d, m.better);
    const share = base ? d.mean / base : null;
    const t = `${esc(m.label)}: off ${fmtValue[m.unit](base)} · on ${fmtValue[m.unit](c.on[k])}<br>paired Δ ${fmtDelta[m.unit](d.mean)}${d.lo != null ? ` (90%: ${fmtDelta[m.unit](d.lo)} to ${fmtDelta[m.unit](d.hi)})` : ''}<br>${d.n} pairs · ${v.label}`;
    return `<td class="num ${v.key}" data-v="${share ?? ''}" ${tipAttr(t)}>${share == null ? fmtDelta[m.unit](d.mean) : `${sign(share)}${Math.abs(share * 100).toFixed(0)}%`}</td>`;
  };
  const pass = () => {
    if (!c || (!c.off.graded && !c.on.graded)) return `<td class="num muted">${c && c.off.score != null ? `score ${c.off.score.toFixed(2)} → ${c.on.score?.toFixed(2) ?? '–'}` : '–'}</td>`;
    const d = c.delta.pass, v = verdict(d, 'up');
    const t = `cache off ${c.off.passed}/${c.off.graded} · cache on ${c.on.passed}/${c.on.graded}<br>paired Δ ${fmtDelta.share(d.mean)}${d.lo != null ? ` (90%: ${fmtDelta.share(d.lo)} to ${fmtDelta.share(d.hi)})` : ''}<br>PRs: ${c.counts.gained} gained, ${c.counts.lost} lost<br>graded by ${esc(c.graders.join('; '))}`;
    return `<td class="num ${v.key}" data-v="${d.mean ?? ''}" ${tipAttr(t)}>${fmt.pct(c.off.pass_rate)} → ${fmt.pct(c.on.pass_rate)}</td>`;
  };
  const sub = e.meta.question ? esc(e.meta.question)
    : e.meta.off ? `${esc(e.meta.off)} vs ${esc(e.meta.on)}${e.meta.others.length ? ` (+ ${e.meta.others.map(esc).join(', ')})` : ''} · <i>question not recorded</i>`
    : `no cache-off arm (${esc([e.meta.on, ...e.meta.others].filter(Boolean).join(', '))})`;
  return `<tr class="click" data-href="#/exp/${enc(e.dir)}">
    <td style="white-space:normal;min-width:260px"><a href="#/exp/${enc(e.dir)}"><b>${esc(expName(e))}</b></a> ${kindChip(e.meta.kind)}<div class="muted small">${sub}</div></td>
    <td>${esc(e.repo || '–')}<div class="muted small">${esc(e.models || 'model unrecorded')}</div></td>
    <td class="num">${e.prs}</td>${pass()}${rel('in_tokens')}${rel('tool_calls')}${rel('wall_ms')}
    <td class="num" data-v="${c?.pairs ? c.served / c.pairs : ''}">${c?.pairs ? fmt.pct(c.served / c.pairs) : '–'}</td>
    <td data-v="${e.first_at || 0}">${fmt.date(e.first_at)}</td><td>${statusCell(e.job)}</td></tr>`;
}

// ---------- one experiment ----------
async function pageExperiment(dir) {
  const x = await api(`/api/experiment?dir=${enc(dir)}`);
  const { run, meta, cmp, metrics } = x;
  const arms = x.arms.map(a => a.arm);
  $app.innerHTML = `
    <p class="muted"><a href="#/">Experiments</a> / ${esc(dir)}</p>
    <h1>${esc(meta.name || dir)} ${kindChip(meta.kind)}</h1>
    <p class="question">${meta.question ? esc(meta.question) : '<span class="muted">What this experiment tests is not recorded.</span>'} <a href="#" id="edit">${meta.defined ? 'Edit' : 'Define it'}</a></p>
    <p class="sub">${esc(run.repo || 'unknown repo')} · ${esc(run.models || 'model unrecorded')} via ${esc(run.runner)} · ${cmp ? cmp.prs.length : '?'} PRs · ${run.results} results${run.invalid ? ` (${run.invalid} invalid)` : ''} · ${fmt.dt(run.first_at)} · <code>bench/runs/${esc(dir)}</code></p>
    <div id="editor"></div><div id="live"></div>
    ${modulesCard(meta)}
    ${!meta.off ? `<div class="card confirm"><b>No cache-off arm.</b> This experiment ran ${arms.map(esc).join(', ') || 'nothing yet'}. ${arms.length > 1 ? '<a href="#" id="edit2">Pick the arm to compare against</a>.' : ''}</div>`
      : !x.all.some(c => c.pairs) ? `<div class="card">No valid pairs yet between <b>${esc(meta.off)}</b> (cache off) and ${x.all.map(c => `<b>${esc(c.on)}</b>`).join(', ') || 'another arm'}.</div>`
      : `<div id="cmp"></div>`}
    ${x.all.some(c => c.prs.length) ? prTable(x.all, meta) : ''}
    ${x.arms.length ? `<details class="card" style="margin-top:16px"><summary>All arms</summary><div class="wrap">${armsTable(x.arms)}</div></details>` : ''}
    ${x.invalid.length ? `<details class="card" style="margin-top:12px"><summary>${x.invalid.length} invalid results, left out of every number</summary><table><tbody>${x.invalid.map(i => `<tr class="click" data-id="${esc(i.id)}"><td>${esc(i.task)} · ${esc(i.arm)} · rep ${i.rep}</td><td style="white-space:normal">${esc(i.reason)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
  bindTips($app);
  $app.querySelectorAll('tr[data-id]').forEach(el => el.addEventListener('click', () => { location.hash = '#/session/' + enc(el.dataset.id); }));
  $app.querySelectorAll('tr[data-pr]').forEach(el => el.addEventListener('click', ev => { if (!ev.target.closest('a,.c')) openPair(x.all, el.dataset.pr, meta); }));
  if (document.getElementById('prs')) sortable(document.getElementById('prs'));
  if (document.getElementById('cmp')) {
    const draw = scope => { document.getElementById('cmp').innerHTML = comparison(x.all.filter(c => c.pairs), metrics, meta, scope); bindTips(document.getElementById('cmp'));
      document.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { sessionSet('scope', b.dataset.scope); draw(b.dataset.scope); })); };
    draw(sessionGet('scope') || 'all');
  }
  const openEditor = ev => { ev.preventDefault(); editor(dir, meta, arms); };
  document.getElementById('edit').addEventListener('click', openEditor);
  document.getElementById('edit2')?.addEventListener('click', openEditor);
  // a running experiment shows its progress here; the page redraws as sessions finish
  const showRun = j => { const el = document.getElementById('live'); if (!el) return; el.innerHTML = j ? runPanel(j) : ''; if (j) { bindTips(el); bindCancel(el, () => route()); } };
  showRun(x.job && (x.job.status === 'running' || x.job.status !== 'done' && !x.run.results) ? x.job : null);
  if (x.job?.status === 'running') {
    let seen = x.job.done;
    pollTimer = setInterval(async () => {
      const y = await api(`/api/experiment?dir=${enc(dir)}`).catch(() => null);
      if (!y) return;
      if (!y.job || y.job.status !== 'running' || y.job.done !== seen) { clearInterval(pollTimer); route(); return; }
      showRun(y.job);
    }, 3000);
  }
}

// Arm colors: cache off is the neutral reference, the cache-on arm takes the first hue and any
// further arm the next ones, in the experiment's own order, so a color always means the same arm.
const armHue = (arm, meta, comps) => arm === meta.off ? 'var(--baseline)' : `var(--series-${Math.min(8, comps.findIndex(c => c.on === arm) + 1)})`;
const armRole = (arm, meta) => arm === meta.off ? 'cache off' : arm === meta.on ? 'cache on' : '';
const HEADLINE = ['pass', 'in_tokens', 'tool_calls', 'wall_ms', 'out_tokens', 'cost'];

// The comparison of every arm against cache off. `scope` is 'all' pairs or only the pairs where the
// cache arm was 'served' a note. Each comparison has its own pair set, so the cache-off figure is
// shown from each arm's own pairs where they differ.
// what the experiment was built from; older runs have no modules recorded
function modulesCard(meta) {
  const m = meta.modules;
  if (!m) return `<div class="card modules-none muted small">Modules not recorded: this run was started before experiments recorded their PR set, cache, agent and grader, so its cache's provenance is unknown.</div>`;
  const last = (meta.launched || []).slice(-1)[0];
  const failed = (last?.checks || []).filter(c => !c.ok);
  return `<div class="modules">
    <div class="card mod"><div class="mtitle">PR set</div><a href="#/prsets">${esc(m.prset.name)}</a> · ${m.prset.prs} PRs<div class="muted small">${esc(m.prset.rule)}</div><div class="muted small">${esc(m.prset.tasks)} at ${esc((m.prset.base || '?').slice(0, 10))} · hash ${esc(m.prset.hash)}</div></div>
    <div class="card mod"><div class="mtitle">Cache</div><a href="#/cache/${enc(m.cache.name)}">${esc(m.cache.name)}</a> · ${m.cache.notes} notes<div class="muted small">mined (${esc(m.cache.source)}, ${m.cache.limit} changes) by ${esc(m.cache.model)} at ${esc(m.cache.anchor.slice(0, 10))}</div><div class="muted small">notes hash ${esc(m.cache.notes_hash)}</div></div>
    <div class="card mod"><div class="mtitle">Arms</div><b>${esc(m.arms.off)}</b> (off) vs <b>${esc(m.arms.on)}</b> (on)${m.arms.extra?.length ? `<div class="muted small">also ${m.arms.extra.map(esc).join(', ')}</div>` : ''}</div>
    <div class="card mod"><div class="mtitle">Agent</div>${esc(m.agent.model)} via ${esc(m.agent.runner)}<div class="muted small">${m.agent.reps} reps · ${m.agent.conc} at a time${m.agent.flags.length ? ' · ' + m.agent.flags.map(f => '--' + esc(f)).join(' ') : ''}</div></div>
    <div class="card mod"><div class="mtitle">Grading</div>${esc(m.grading.summary)}</div>
    ${last?.checks ? `<div class="card mod"><div class="mtitle">Checks at launch</div>${failed.length ? `<span class="status critical">${failed.length} failed</span>` : `<span class="status good">all ${last.checks.length} passed</span>`}</div>` : ''}
  </div>`;
}

function comparison(comps, metrics, meta, scope) {
  const M = Object.fromEntries(metrics.map(m => [m.key, m]));
  const served = scope === 'served';
  const sides = c => served ? { off: c.servedOffSide, on: c.servedOnSide, d: c.deltaServed, n: c.served } : { off: c.offSide, on: c.onSide, d: c.delta, n: c.pairs };
  const graded = comps.some(c => c.offSide.graded);
  // a loop experiment (bench/loop.js) leads with whether the sessions got to done
  const loop = comps.some(c => c.offSide.done != null || c.onSide.done != null);
  const keys = [...(loop ? ['done'] : []), ...HEADLINE.filter(k => k !== 'pass' || graded)];
  const legend = `<div class="legend"><span><i style="background:var(--baseline)"></i>${esc(meta.off)} · cache off</span>${comps.map(c => `<span><i style="background:${armHue(c.on, meta, comps)}"></i>${esc(c.on)}${armRole(c.on, meta) ? ' · ' + armRole(c.on, meta) : ''}</span>`).join('')}</div>`;

  const card = k => {
    const m = M[k], vk = k === 'pass' ? 'pass_rate' : k;  // a side stores the pass rate as pass_rate
    const base = sides(comps[0]).off[vk];
    const vals = [base, ...comps.map(c => sides(c).on[vk])].filter(v => v != null);
    const max = Math.max(...vals.map(Math.abs), m.unit === 'share' ? 1 : 0) || 1;
    const bar = (arm, v, extra = '') => `<div class="brow"><span class="blab">${esc(arm)}</span><span class="btrack"><span class="bfill" style="width:${v == null ? 0 : Math.max(1.5, (Math.abs(v) / max) * 100)}%;background:${armHue(arm, meta, comps)}"></span></span><span class="bval">${k === 'pass' ? fmt.pct(v) : fmtValue[m.unit](v)}</span>${extra}</div>`;
    const rows = comps.map(c => {
      const sd = sides(c), d = sd.d[k], v = verdict(d, m.better);
      const rel = sd.off[vk] ? d.mean / sd.off[vk] : null;
      const t = `<b>${esc(c.on)} − ${esc(meta.off)}</b><br>${k === 'pass' ? `${sd.on.passed}/${sd.on.graded} vs ${sd.off.passed}/${sd.off.graded}` : `${fmtValue[m.unit](sd.on[k])} vs ${fmtValue[m.unit](sd.off[k])}`}<br>paired Δ ${fmtDelta[m.unit](d.mean)}${d.lo != null ? `<br>90% interval ${fmtDelta[m.unit](d.lo)} to ${fmtDelta[m.unit](d.hi)}` : ''}<br>${d.n} pairs · ${v.label}`;
      const chip = d.mean == null ? '' : `<span class="dchip ${v.key}" ${tipAttr(t)}>${m.unit === 'share' || rel == null ? fmtDelta[m.unit](d.mean) : `${sign(rel)}${Math.abs(rel * 100).toFixed(0)}%`}</span>`;
      return bar(c.on, sd.on[vk], chip);
    }).join('');
    return `<div class="card mcard"><div class="mtitle">${esc(m.label)}${m.unit === 'share' ? '' : ' <span class="muted small">median</span>'}<span class="muted small" style="float:right">${m.better === 'up' ? 'higher is better' : 'lower is better'}</span></div>
      ${bar(meta.off, base)}${rows}</div>`;
  };

  const head = comps.map(c => `<th class="num" colspan="3" style="border-left:3px solid ${armHue(c.on, meta, comps)}">${esc(c.on)}<div class="armname">${armRole(c.on, meta) || 'vs cache off'} · ${sides(c).n} pairs</div></th>`).join('');
  const rows = metrics.filter(m => (m.key !== 'pass' || graded) && (!m.loop || loop)).map(m => {
    const base = sides(comps[0]).off;
    return `<tr><th scope="row">${esc(m.label)}</th><td class="num">${m.key === 'pass' ? `${fmt.pct(base.pass_rate)} <span class="muted">${base.passed}/${base.graded}</span>` : fmtValue[m.unit](base[m.key])}</td>
      ${comps.map(c => { const sd = sides(c), d = sd.d[m.key], v = verdict(d, m.better);
        return `<td class="num" style="border-left:3px solid ${armHue(c.on, meta, comps)}">${m.key === 'pass' ? `${fmt.pct(sd.on.pass_rate)} <span class="muted">${sd.on.passed}/${sd.on.graded}</span>` : fmtValue[m.unit](sd.on[m.key])}</td>
          <td class="num ${v.key}"><b>${fmtDelta[m.unit](d.mean)}</b>${d.lo != null ? `<div class="muted small">${fmtDelta[m.unit](d.lo)} to ${fmtDelta[m.unit](d.hi)}</div>` : ''}</td><td class="ci">${ciBar(d, m)}</td>`; }).join('')}</tr>`;
  }).join('');

  const outcomes = graded ? comps.map(c => {
    const k = c.counts, judged = c.prs.filter(p => p.change).length;
    const seg = (n, cls, label) => n ? `<span class="${cls}" style="flex:${n}" ${tipAttr(`${n} PR${n === 1 ? '' : 's'} ${label}`)}>${n} ${label}</span>` : '';
    return `<div class="orow"><span class="blab"><i class="sw" style="background:${armHue(c.on, meta, comps)}"></i>${esc(c.on)}</span><div class="outcomes">${seg(k.gained, 'g', 'gained')}${seg(k.lost, 'l', 'lost')}${seg(k.bothPass, 'bp', 'pass both')}${seg(k.bothFail, 'bf', 'fail both')}${seg(judged - k.gained - k.lost - k.bothPass - k.bothFail, 'mx', 'same mixed rate')}</div></div>`;
  }).join('') : '';
  const c0 = comps[0];
  return `
    <div class="scopebar"><span class="seg"><button data-scope="all" class="${served ? '' : 'on'}">All pairs</button><button data-scope="served" class="${served ? 'on' : ''}">Only where the cache served a note</button></span>
      <span class="muted small">${comps.map(c => `${esc(c.on)}: ${c.served} of ${c.pairs} pairs served`).join(' · ')}</span></div>
    ${legend}
    <div class="mgrid">${keys.map(card).join('')}</div>
    <p class="muted small">Bars are each arm's value; the chip beside a bar is its paired difference from <b>${esc(meta.off)}</b> (cache off) — <span class="dchip better">green</span> where the 90% interval says the arm is better, <span class="dchip worse">red</span> where worse, grey where the interval includes zero. Hover a chip for the interval.</p>
    ${outcomes ? `<h2>PR outcomes against cache off</h2>${outcomes}` : ''}
    <details class="card" style="margin-top:14px" open><summary>Every metric, with intervals</summary><div class="wrap"><table class="cmp"><thead><tr><th></th><th class="num">${esc(meta.off)}<div class="armname">cache off</div></th>${head}</tr>
      <tr class="subhead"><th></th><th></th>${comps.map(() => '<th class="num">value</th><th class="num">Δ vs off · 90%</th><th></th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small" style="margin:8px 0 0">Pairs are the same PR and rep on both sides, both valid. ${c0.graders.length ? `Pass graded by ${esc(c0.graders.join('; '))}.` : 'No pass/fail grading.'}${c0.offSide.score != null ? ` Mean judge score: ${esc(meta.off)} ${c0.offSide.score.toFixed(2)}, ${comps.map(c => `${esc(c.on)} ${c.onSide.score?.toFixed(2) ?? '–'}`).join(', ')}.` : ''} Spend is the runner's recorded figure at list price.${comps.some(c => c.unpaired.off || c.unpaired.on) ? ` Sessions without a valid partner are left out (${comps.map(c => `${esc(c.on)}: ${c.unpaired.on}, cache off: ${c.unpaired.off}`).join('; ')}).` : ''}</p></details>`;
}

// the interval on a zero-centred scale of its own; the dot is the mean
function ciBar(d, m) {
  if (d.mean == null) return '';
  const W = 120, H = 18, mid = W / 2;
  const ext = Math.max(Math.abs(d.lo ?? d.mean), Math.abs(d.hi ?? d.mean), Math.abs(d.mean)) || 1;
  const sx = v => mid + (v / ext) * (mid - 8);
  const v = verdict(d, m.better), col = v.key === 'better' ? 'var(--good)' : v.key === 'worse' ? 'var(--critical)' : 'var(--text-muted)';
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><line x1="${mid}" x2="${mid}" y1="1" y2="${H - 1}" stroke="var(--border)"/>
    ${d.lo != null ? `<line x1="${sx(d.lo)}" x2="${sx(d.hi)}" y1="${H / 2}" y2="${H / 2}" stroke="${col}" stroke-width="2" stroke-linecap="round"/>` : ''}
    <circle cx="${sx(d.mean)}" cy="${H / 2}" r="4.5" fill="${col}" stroke="var(--surface-1)" stroke-width="2"/></svg>`;
}

const CHANGE = { gained: ['good', 'gained'], lost: ['critical', 'lost'], 'both pass': ['', 'both pass'], 'both fail': ['', 'both fail'], same: ['', 'same rate'] };
const changeCell = ch => ch[0] ? `<span class="status ${ch[0]}">${ch[1]}</span>` : `<span class="muted">${ch[1]}</span>`;
// a PR's token difference against cache off, as a share of the cache-off median
function tokChip(p) {
  if (p.d_in_tokens == null || !p.off.in_tokens) return '';
  const r = p.d_in_tokens / p.off.in_tokens, cls = Math.abs(r) < 0.1 ? 'same' : r < 0 ? 'better' : 'worse';
  return `<span class="dchip ${cls}" ${tipAttr(`paired Δ input tokens ${fmtDelta.tokens(p.d_in_tokens)} (${fmt.tok(p.off.in_tokens)} → ${fmt.tok(p.on.in_tokens)})<br>Δ tool calls ${fmtDelta.count(p.d_tool_calls)} · Δ wall ${fmtDelta.ms(p.d_wall_ms)}`)}>${sign(r)}${Math.abs(r * 100).toFixed(0)}%</span>`;
}
function prTable(comps, meta) {
  const tasks = [...new Set(comps.flatMap(c => c.prs.map(p => p.task)))].sort();
  const pr = (c, t) => c.prs.find(p => p.task === t);
  const first = t => comps.map(c => pr(c, t)).find(Boolean);
  return `<h2>Per PR</h2>
    <p class="sub">Each square is one rep: <span class="c p">✓</span> pass <span class="c f">✗</span> fail <span class="c n">·</span> ungraded <span class="c x">!</span> invalid; a blue underline means the cache served a note. The chip is the PR's paired input-token difference from cache off (grey within ±10%: one PR has too few reps for an interval). Click a row to put the reps side by side, a square for the session and its transcript.</p>
    <div class="card wrap"><table id="prs"><thead><tr><th class="sort">PR</th><th style="border-left:3px solid var(--baseline)">${esc(meta.off)}<div class="armname">cache off</div></th>
      ${comps.map(c => `<th class="sort" style="border-left:3px solid ${armHue(c.on, meta, comps)}">${esc(c.on)}<div class="armname">${armRole(c.on, meta) || 'vs cache off'}</div></th>`).join('')}</tr></thead><tbody>
    ${tasks.map(t => { const f = first(t);
      return `<tr class="click" data-pr="${esc(t)}">
        <td style="white-space:normal;min-width:220px"><a href="#/pr/${enc(t)}">${esc(f.pr ? '#' + f.pr : t)}</a> <span class="muted small">${esc(f.title || '')}</span></td>
        <td style="border-left:3px solid var(--baseline)"><div class="cells">${f.off.results.map(cell).join('')}</div><div class="muted small">${fmt.tok(f.off.in_tokens)} tok</div></td>
        ${comps.map(c => { const p = pr(c, t); if (!p) return '<td class="muted">–</td>';
          return `<td data-v="${p.change === 'gained' ? 2 : p.change === 'lost' ? -2 : p.d_in_tokens != null && p.off.in_tokens ? -p.d_in_tokens / p.off.in_tokens : 0}" style="border-left:3px solid ${armHue(c.on, meta, comps)}"><div class="cells">${p.on.results.map(cell).join('')}</div>
            <div class="small">${fmt.tok(p.on.in_tokens)} tok ${tokChip(p)} ${p.change === 'gained' || p.change === 'lost' ? changeCell(CHANGE[p.change]) : ''}</div></td>`; }).join('')}</tr>`; }).join('')}</tbody></table></div>`;
}
function cell(c) {
  const cls = c.invalid ? 'x' : c.pass === 1 ? 'p' : c.pass === 0 ? 'f' : 'n';
  const label = c.invalid ? '!' : c.pass === 1 ? '✓' : c.pass === 0 ? '✗' : (c.score != null ? c.score.toFixed(1).replace(/^0/, '') : '·');
  const t = `rep ${c.rep} · ${c.invalid ? 'invalid: ' + c.invalid : c.pass === 1 ? 'pass' : c.pass === 0 ? 'fail' : 'ungraded'}${c.score != null ? ' · score ' + c.score.toFixed(2) : ''}<br>input ${fmt.tok(c.in_tokens)} · ${c.tool_calls ?? '–'} tool calls · ${fmt.ms(c.wall_ms)}${c.served ? `<br>served ${c.injected || ''} note${c.injected === 1 ? '' : 's'}` : ''}`;
  return `<span class="c ${cls}${c.served ? ' s' : ''}" data-id="${esc(c.id)}" ${tipAttr(t)}>${label}</span>`;
}
function armsTable(arms) {
  return `<table><thead><tr><th>Arm</th><th class="num">Valid / n</th><th class="num">Pass</th><th class="num">Score</th><th class="num">Input tok</th><th class="num">Output tok</th><th class="num">Tool calls</th><th class="num">Wall</th><th class="num">Spend</th><th class="num">Served</th><th>Graded by</th></tr></thead><tbody>
    ${arms.map(a => `<tr><td>${esc(a.arm)}</td><td class="num">${a.valid} / ${a.n}</td><td class="num">${a.graded ? `${fmt.pct(a.pass_rate)} <span class="muted">${a.passed}/${a.graded}</span>` : '–'}</td><td class="num">${a.score == null ? '–' : a.score.toFixed(2)}</td>
      <td class="num">${fmt.tok(a.in_tokens)}</td><td class="num">${fmt.tok(a.out_tokens)}</td><td class="num">${a.tool_calls ?? '–'}</td><td class="num">${fmt.ms(a.wall_ms)}</td><td class="num">${fmt.usd(a.cost_total)}</td><td class="num">${fmt.pct(a.served_share)}</td><td>${a.graders.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table>`;
}

function editor(dir, meta, arms) {
  const opt = (sel, a) => `<option ${a === sel ? 'selected' : ''}>${esc(a)}</option>`;
  const el = document.getElementById('editor');
  el.innerHTML = `<form class="card launch" id="ef" style="margin-bottom:16px">
    <label>Name<input name="name" value="${esc(meta.name || '')}" placeholder="${esc(dir)}" maxlength="120"></label>
    <label style="grid-column:span 2">What it tests<input name="question" value="${esc(meta.question || '')}" placeholder="Does the prompt hook help Sonnet on PostHog PRs?" maxlength="300"></label>
    <label>Tests a<select name="kind"><option value="behavior" ${meta.kind === 'behavior' ? 'selected' : ''}>behavior</option><option value="model" ${meta.kind === 'model' ? 'selected' : ''}>model</option></select></label>
    <label>Cache off arm<select name="off">${arms.map(a => opt(meta.off, a)).join('')}</select></label>
    <label>Cache on arm<select name="on">${arms.map(a => opt(meta.on, a)).join('')}</select></label>
    <div class="full"><button class="primary" type="submit">Save</button> <button type="button" id="ecancel">Cancel</button> <span class="muted small">Saved in the evals database with the experiment's sessions.</span> <span class="err" id="eerr"></span></div></form>`;
  const f = document.getElementById('ef');
  document.getElementById('ecancel').onclick = () => { el.innerHTML = ''; };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/experiment', { dir, name: f.name.value, question: f.question.value, kind: f.kind.value, off: f.off.value, on: f.on.value }); if (location.hash === `#/exp/${enc(dir)}`) route(); else location.hash = `#/exp/${enc(dir)}`; }
    catch (err) { document.getElementById('eerr').textContent = err.message; }
  });
}

// ---------- the two sides of one PR ----------
function openPair(comps, task, meta) {
  const ps = comps.map(c => ({ arm: c.on, p: c.prs.find(x => x.task === task) })).filter(x => x.p);
  const p0 = ps[0].p;
  const cols = [{ arm: meta.off, results: p0.off.results }, ...ps.map(x => ({ arm: x.arm, results: x.p.on.results }))];
  const reps = [...new Set(cols.flatMap(c => c.results.map(r => r.rep)))].sort((a, b) => a - b);
  const side = r => !r ? '<td class="muted">not run</td>' : `<td class="pairside" data-id="${esc(r.id)}">${r.invalid ? `<span class="status serious">invalid</span> <span class="muted small">${esc(r.invalid)}</span>` : r.pass === 1 ? '<span class="status good">pass</span>' : r.pass === 0 ? '<span class="status critical">fail</span>' : r.score != null ? `score ${r.score.toFixed(2)}` : '<span class="muted">ungraded</span>'}
    <div class="small">${fmt.tok(r.in_tokens)} input · ${r.tool_calls ?? '–'} tool calls · ${fmt.ms(r.wall_ms)}${r.served ? ` · ${r.injected || ''} note${r.injected === 1 ? '' : 's'} served` : ''}</div><a href="#" class="small">open result</a></td>`;
  document.getElementById('drawer-body').innerHTML = `
    <div class="head"><div><h1 style="margin:0">${esc(p0.pr ? 'PR #' + p0.pr : task)}</h1><p class="sub">${esc(p0.title || '')}</p></div><button id="close">Close</button></div>
    <div class="wrap"><table class="pair"><thead><tr><th>Rep</th>${cols.map(c => `<th>${esc(c.arm)}${armRole(c.arm, meta) ? ` <span class="muted">· ${armRole(c.arm, meta)}</span>` : ''}</th>`).join('')}</tr></thead><tbody>
    ${reps.map(rep => `<tr><td>${rep}</td>${cols.map(c => side(c.results.find(r => r.rep === rep))).join('')}</tr>`).join('')}</tbody></table></div>
    <p><a href="#/pr/${enc(task)}" id="allexp">This PR in every experiment →</a></p>`;
  document.getElementById('close').onclick = () => $drawer.close();
  document.getElementById('allexp').onclick = () => $drawer.close();
  document.querySelectorAll('#drawer-body .pairside a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); $drawer.close(); location.hash = '#/session/' + enc(a.closest('[data-id]').dataset.id); }));
  if (!$drawer.open) $drawer.showModal();
}

$drawer.addEventListener('click', e => { if (e.target === $drawer) $drawer.close(); });
document.addEventListener('click', e => { const c = e.target.closest('.c[data-id]'); if (c) { e.stopPropagation(); e.preventDefault(); if ($drawer.open) $drawer.close(); location.hash = '#/session/' + enc(c.dataset.id); } }, true);

// ---------- PRs ----------
async function pagePRs() {
  const { rows } = await api('/api/prs');
  $app.innerHTML = `<h1>PRs</h1><p class="sub">Every PR that has been run with the cache off and on, pooled over the experiments that ran it.</p>
    <div class="filters"><input id="q" placeholder="Search PRs…" aria-label="Search PRs"></div>
    <div class="card wrap"><table id="prt"><thead><tr><th class="sort">PR</th><th class="sort">Repo</th><th class="sort num">Experiments</th><th class="sort num">Pass off</th><th class="sort num">Pass on</th><th class="sort num">Gained</th><th class="sort num">Lost</th><th class="sort num">Input tokens</th></tr></thead><tbody></tbody></table></div>
    <p class="muted small">Input tokens: the paired difference as a share of the cache-off median, averaged over experiments.</p>`;
  const draw = () => {
    const q = document.getElementById('q').value.toLowerCase();
    document.querySelector('#prt tbody').innerHTML = rows.filter(r => !q || (r.task + ' ' + (r.title || '')).toLowerCase().includes(q)).map(r => `<tr class="click" data-href="#/pr/${enc(r.task)}">
      <td style="white-space:normal;min-width:280px"><a href="#/pr/${enc(r.task)}">${esc(r.pr ? '#' + r.pr : r.task)}</a>${r.pr && r.task.endsWith('-hard') ? ' <span class="pill">hard</span>' : ''} <span class="muted small">${esc(r.title || '')}</span></td><td>${esc(r.repo || '–')}</td><td class="num">${r.experiments}</td>
      <td class="num" data-v="${r.off[1] ? r.off[0] / r.off[1] : ''}">${r.off[1] ? `${fmt.pct(r.off[0] / r.off[1])} <span class="muted">${r.off[0]}/${r.off[1]}</span>` : '–'}</td>
      <td class="num" data-v="${r.on[1] ? r.on[0] / r.on[1] : ''}">${r.on[1] ? `${fmt.pct(r.on[0] / r.on[1])} <span class="muted">${r.on[0]}/${r.on[1]}</span>` : '–'}</td>
      <td class="num">${r.gained || ''}</td><td class="num">${r.lost || ''}</td><td class="num" data-v="${r.d_in_share ?? ''}">${r.d_in_share == null ? '–' : `${sign(r.d_in_share)}${Math.abs(r.d_in_share * 100).toFixed(0)}%`}</td></tr>`).join('');
    document.querySelectorAll('#prt tr.click').forEach(tr => tr.addEventListener('click', e => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  };
  document.getElementById('q').addEventListener('input', draw);
  draw(); sortable(document.getElementById('prt'));
}
async function pagePR(id) {
  const x = await api('/api/pr?id=' + enc(id));
  $app.innerHTML = `<p class="muted"><a href="#/prs">PRs</a> / ${esc(id)}</p>
    <h1>${esc(x.info?.pr ? 'PR #' + x.info.pr : id)}</h1><p class="sub">${esc(x.info?.title || '')} · ${esc(x.info?.repo || '')}</p>
    <div class="card wrap"><table><thead><tr><th>Experiment</th><th>Model</th><th>Cache off</th><th>Cache on</th><th class="num">Tokens off → on</th><th class="num">Δ tool calls</th><th>Change</th></tr></thead><tbody>
    ${x.experiments.map(e => { const p = e.pr;
      return `<tr><td style="white-space:normal"><a href="#/exp/${enc(e.dir)}">${esc(e.meta.name || e.dir)}</a> ${kindChip(e.meta.kind)}<div class="muted small">${esc(e.meta.off || '–')} vs ${esc(e.meta.on || '–')} · ${fmt.date(e.first_at)}</div></td><td>${esc(e.models || '–')}</td>
        <td>${p ? `<div class="cells">${p.off.results.map(cell).join('')}</div>` : ''}</td><td>${p ? `<div class="cells">${p.on.results.map(cell).join('')}</div>` : ''}</td>
        <td class="num">${p ? `${fmt.tok(p.off.in_tokens)} → ${fmt.tok(p.on.in_tokens)}` : '–'}</td><td class="num">${p ? fmtDelta.count(p.d_tool_calls) : '–'}</td>
        <td>${p ? changeCell(CHANGE[p.change] || ['', '–']) : '<span class="muted">no cache comparison</span>'}</td></tr>`; }).join('')}</tbody></table></div>`;
  bindTips($app);
}

// ---------- what is in progress: shown on the entity itself ----------
const STATUS = { running: ['good', 'running'], done: ['good', 'finished'], failed: ['critical', 'failed'], cancelled: ['serious', 'cancelled'], exited: ['serious', 'stopped'] };
// a compact status for a list row: a running job's bar, else nothing (the row's numbers say the rest)
function statusCell(j, unit = 'sessions') {
  if (!j || j.status !== 'running') return j && j.status !== 'done' ? `<span class="status ${(STATUS[j.status] || [''])[0]}">${esc((STATUS[j.status] || ['', j.status])[1])}</span>` : '';
  const share = j.expected ? j.done / j.expected : 0;
  const label = j.kind === 'cache' ? (j.progress?.total ? `${esc(j.step)} ${j.progress.done}/${j.progress.total}` : esc(j.step)) : `${j.done}/${j.expected} ${unit}${j.live?.filter(l => l.state === 'working').length ? ` · ${j.live.filter(l => l.state === 'working').length} working` : ''}`;
  const frac = j.kind === 'cache' && j.progress?.total ? (j.done + j.progress.done / j.progress.total) / j.expected : share;
  return `<div class="mini"><span class="status ${j.limit_wait ? 'warning' : 'good'}">${j.limit_wait ? 'waiting on a usage limit' : 'running'}</span><div class="bar"><span style="width:${Math.max(2, frac * 100)}%"></span></div><span class="muted small">${label}</span></div>`;
}

// the running experiment on its own page: sessions done, each running session as it works, cancel
function runPanel(j) {
  const st = j.limit_wait ? ['warning', 'waiting on a usage limit'] : STATUS[j.status] || ['', j.status];
  const share = j.expected ? j.done / j.expected : 0;
  const workers = (j.live || []).map(l => l.state !== 'working' ? `<div class="worker muted small">worker ${l.worker + 1}: starting a session…</div>`
    : `<div class="worker"><div class="small"><b>worker ${l.worker + 1}</b> <span class="muted">· ${l.steps} steps · ${l.tools} tool calls · context ${fmt.tok(l.context_tokens)} · last activity ${fmt.ago(l.last_at)}</span></div>
       <div class="small">${esc(l.request || '')}</div>${l.last_tool ? `<div class="small muted">now: <code>${esc(l.last_tool.name)}</code> ${esc(l.last_tool.input)}</div>` : ''}</div>`).join('');
  return `<div class="card runpanel">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="status ${st[0]}">${esc(st[1])}</span>
      <span class="muted small">started ${fmt.dt(j.started_at)} · ${fmt.ms(j.elapsed)} so far${j.eta != null && j.status === 'running' ? ` · about ${fmt.ms(j.eta)} left` : ''}${j.source === 'terminal' ? ' · started from a terminal' : ''}</span>
      ${j.status === 'running' && j.source === 'app' ? `<button class="danger" data-cancel="${j.id}" style="margin-left:auto">Cancel</button>` : ''}</div>
    <div style="display:flex;gap:12px;align-items:center;margin:10px 0 6px"><div class="bar" style="flex:1"><span style="width:${Math.max(0, share - (j.errors / (j.expected || 1))) * 100}%"></span>${j.errors ? `<span class="err" style="width:${(j.errors / j.expected) * 100}%"></span>` : ''}</div>
      <span class="num">${j.done} / ${j.expected ?? '?'} sessions finished${j.errors ? ` · <span class="err">${j.errors} errored</span>` : ''}</span></div>
    ${workers ? `<div class="workers">${workers}</div>` : j.runner && j.runner !== 'claude' && j.status === 'running' ? '<div class="muted small">This runner writes its sessions when they end, so they show here as they finish.</div>' : ''}
    <details><summary class="muted small">Command and log</summary><pre>${esc(j.command)}</pre>${j.log ? `<pre>${esc(j.log)}</pre>` : ''}</details>
  </div>`;
}

// a cache being built, on its own page: the step, mining's own progress, the log
function buildPanel(j) {
  const st = STATUS[j.status] || ['', j.status];
  const steps = ['snapshot', 'mine-prs', 'phrase', 'relink', 'export'];
  return `<div class="card runpanel">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="status ${st[0]}">${esc(st[1])}</span>
      <span class="muted small">started ${fmt.dt(j.started_at)} · ${fmt.ms(j.elapsed)} so far</span>
      ${j.status === 'running' ? `<button class="danger" data-cancel="${j.id}" style="margin-left:auto">Cancel</button>` : ''}</div>
    <ol class="steps">${steps.map((x, i) => `<li class="${i < j.done ? 'done' : x === j.step ? 'now' : ''}">${esc(x)}${x === j.step && j.progress?.total ? ` <span class="muted small">${j.progress.done} / ${j.progress.total} changes</span><div class="bar"><span style="width:${(j.progress.done / j.progress.total) * 100}%"></span></div>` : ''}</li>`).join('')}</ol>
    <details ${j.status === 'running' ? 'open' : ''}><summary class="muted small">Log</summary><pre>${esc(j.log || '')}</pre></details>
  </div>`;
}

function bindCancel(root, after) {
  root.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api('/api/cancel', { id: Number(b.dataset.cancel) }); } catch (e) { b.insertAdjacentHTML('afterend', `<span class="err"> ${esc(e.message)}</span>`); }
    after();
  }));
}

const tile = (k, v, d) => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

// ---------- checks, shared by the module pages ----------
const checkList = checks => `<ul class="checks-list">${checks.map(c => `<li><span class="status ${c.ok ? 'good' : 'critical'}">${c.ok ? 'pass' : 'fail'}</span> ${c.module ? `<span class="muted">${esc(c.module)} ·</span> ` : ''}<b>${esc(c.check)}</b> <span class="muted small">${esc(c.detail)}</span></li>`).join('')}</ul>`;
const allOk = checks => checks.every(c => c.ok);

// ---------- PR sets ----------
async function pagePrsets() {
  const [{ prsets }, cat] = await Promise.all([api('/api/prsets'), api('/api/catalog')]);
  $app.innerHTML = `<div class="head"><div><h1>PR sets</h1>
    <p class="sub">The PRs an experiment runs, chosen by a stated rule. A PR set is composed as a draft — its PRs and rule can still change — and frozen before any session is spent; only a frozen set can be run, and every experiment that uses it runs the same PRs at the same base.</p></div></div>
    <div class="card wrap"><table><thead><tr><th>PR set</th><th>Status</th><th>Repo</th><th class="num">PRs</th><th>Selection rule</th><th>Graded by</th><th>Checks</th><th>Created</th></tr></thead><tbody>
    ${prsets.map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.tasks)} · hash ${esc(p.hash)}</div></td>
      <td>${(p.status || 'frozen') === 'draft' ? `<span class="status warning">draft</span><div><a href="#" data-edit="${esc(p.name)}">edit</a> · <a href="#" data-freeze="${esc(p.name)}">freeze</a></div>` : `<span class="status good">frozen</span><div class="muted small">${fmt.date(p.frozen_at || p.created_at)}</div>`}</td><td>${esc(p.repo)}<div class="muted small">base ${esc((p.base || '?').slice(0, 10))}</div></td><td class="num">${p.prs.length}</td>
      <td style="white-space:normal;max-width:340px">${esc(p.rule)}</td><td class="small">${[...new Set(p.prs.map(x => x.oracle))].map(esc).join(', ')}</td>
      <td>${allOk(p.checks) ? '<span class="status good">pass</span>' : `<span class="status critical" ${tipAttr(p.checks.filter(c => !c.ok).map(c => esc(c.check + ': ' + c.detail)).join('<br>'))}>${p.checks.filter(c => !c.ok).length} failing</span>`}</td><td>${fmt.date(p.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No PR sets yet.</td></tr>'}
    </tbody></table></div>
    <h2 id="pfh">New PR set</h2>
    <form class="launch card" id="pf">
      <label>Name<input name="name" required placeholder="posthog-hard-oct"></label>
      <label>From task set<select name="tasks">${cat.taskSets.map(t => `<option value="${esc(t.file)}">${esc(t.file)} · ${t.tasks.length}</option>`).join('')}</select></label>
      <label style="grid-column:span 2">Selection rule<input name="rule" required placeholder="every PR in the set merged after 2026-09-20 that changes posthog/ and has tests"></label>
      <label class="full">Description (optional)<input name="description"></label>
      <div class="full"><div class="muted small" style="margin-bottom:4px"><a href="#" id="all">all</a> · <a href="#" id="none">none</a> <span id="tcount"></span></div><div class="tasklist" id="tl"></div></div>
      <div class="full"><button type="submit" name="draft" value="1">Save draft</button> <button class="primary" type="submit" name="freeze" value="1">Freeze</button> <span class="muted small">A draft can be changed; a frozen set never changes — a different selection is a new PR set.</span> <span class="err" id="perr"></span></div>
    </form>`;
  bindTips($app);
  const f = document.getElementById('pf');
  const count = () => { document.getElementById('tcount').textContent = `· ${f.querySelectorAll('input[name=t]:checked').length} selected`; };
  const sync = () => {
    const ts = cat.taskSets.find(t => t.file === f.tasks.value);
    document.getElementById('tl').innerHTML = (ts?.tasks || []).map(t => `<label class="check" title="${esc(t.title || '')}"><input type="checkbox" name="t" value="${esc(t.id)}" checked> <span>${esc(t.pr ? '#' + t.pr : t.id)} <span class="muted">${esc(t.title || '')}</span>${t.tests ? ' <span class="pill">tests</span>' : ''}</span></label>`).join('');
    count();
  };
  f.tasks.addEventListener('change', sync); document.getElementById('tl').addEventListener('change', count);
  document.getElementById('all').onclick = e => { e.preventDefault(); f.querySelectorAll('input[name=t]').forEach(c => { c.checked = true; }); count(); };
  document.getElementById('none').onclick = e => { e.preventDefault(); f.querySelectorAll('input[name=t]').forEach(c => { c.checked = false; }); count(); };
  sync();
  let editing = null;  // the draft being composed, when one was opened
  document.querySelectorAll('[data-edit]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const p = prsets.find(x => x.name === a.dataset.edit);
    editing = p.name;
    document.getElementById('pfh').textContent = `Draft ${p.name}`;
    f.name.value = p.name; f.name.readOnly = true; f.tasks.value = p.tasks; sync();
    f.querySelectorAll('input[name=t]').forEach(c => { c.checked = p.ids.includes(c.value); }); count();
    f.rule.value = p.rule || ''; f.description.value = p.description || '';
    f.scrollIntoView({ behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-freeze]').forEach(a => a.addEventListener('click', async e => {
    e.preventDefault();
    try { await api('/api/prsets/freeze', { name: a.dataset.freeze }); route(); } catch (err) { a.insertAdjacentHTML('afterend', `<span class="err"> ${esc(err.message)}</span>`); }
  }));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const freeze = e.submitter?.name === 'freeze';
    const ids = [...f.querySelectorAll('input[name=t]:checked')].map(c => c.value);
    if (!ids.length) { document.getElementById('perr').textContent = 'Select at least one PR.'; return; }
    const body = { name: f.name.value.trim(), tasks: f.tasks.value, rule: f.rule.value.trim(), description: f.description.value.trim(), ids };
    try {
      if (editing) { await api('/api/prsets/update', body); if (freeze) await api('/api/prsets/freeze', { name: editing }); }
      else await api('/api/prsets', { ...body, draft: !freeze });
      route();
    } catch (err) { document.getElementById('perr').textContent = err.message; }
  });
}

// ---------- caches ----------
async function pageCaches() {
  const [{ caches }, cat] = await Promise.all([api('/api/caches'), api('/api/catalog')]);
  $app.innerHTML = `<div class="head"><div><h1>Caches</h1>
    <p class="sub">What the cache-on arm is served. Each cache is built by the product's own mining (<code>thinker mine-prs --git</code>, then <code>phrase</code> and <code>relink</code>) in a checkout whose history stops at an anchor commit, by the model the agent will run. The receipt records how it was built; an experiment checks it against its PR set before it starts.</p></div></div>
    <div class="card wrap"><table><thead><tr><th>Cache</th><th>Repo</th><th>Anchor</th><th>Mined by</th><th class="num">Notes</th><th>Status</th><th>Fits PR sets</th><th>Built</th></tr></thead><tbody>
    ${caches.map(c => `<tr class="click" data-href="#/cache/${enc(c.name)}"><td><a href="#/cache/${enc(c.name)}"><b>${esc(c.name)}</b></a></td><td>${esc(c.repo)}</td><td>${esc(c.anchor.slice(0, 10))}<div class="muted small">${fmt.date(Date.parse(c.anchor_date))}</div></td>
      <td>${esc(c.model)}<div class="muted small">${esc(c.llm)} · ${c.limit} changes</div></td><td class="num">${c.notes ?? '–'}</td>
      <td>${c.job?.status === 'running' ? statusCell(c.job) : c.status === 'ok' ? '<span class="status good">built</span>' : c.status === 'building' ? '<span class="status serious">stopped</span>' : `<span class="status critical">${esc(c.status)}</span>`}</td>
      <td class="small">${c.fits.map(f => `${f.ok ? '✓' : '✗'} ${esc(f.prset)}`).join('<br>') || '<span class="muted">no PR set for this repo</span>'}</td><td>${fmt.date(c.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No caches built yet.</td></tr>'}
    </tbody></table></div>
    <h2>Build a cache</h2>
    <form class="launch card" id="cf">
      <label>Name<input name="name" required placeholder="posthog-sonnet-anchor-a3b3c36"></label>
      <label>For PR set<select name="prset"><option value="">(none: pick the repo and anchor)</option>${cat.prsets.map(p => `<option value="${esc(p.name)}" data-repo="${esc(p.repo)}" data-base="${esc(p.base || '')}">${esc(p.name)} · ${esc(p.repo)}</option>`).join('')}</select></label>
      <label>Repository<select name="repo">${cat.repos.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
      <label>Anchor commit<input name="anchor" placeholder="the PR set's base"></label>
      <label>Mining agent<select name="llm"><option>claude</option><option>codex</option><option>gemini</option></select></label>
      <label>Mining model<input name="model" required placeholder="the model the agent will run, e.g. sonnet"></label>
      <label>Effort (optional)<input name="effort" placeholder="high"></label>
      <label>Changes to mine<input name="limit" type="number" min="5" max="200" value="60"></label>
      <div class="full"><button class="primary" type="submit">Review build</button> <span class="err" id="cerr"></span></div>
    </form><div id="cplan"></div>`;
  document.querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', e => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  if (caches.some(c => c.job?.status === 'running')) pollTimer = setInterval(() => { if (!document.activeElement?.closest('form')) route(); }, 4000);
  const f = document.getElementById('cf');
  f.prset.addEventListener('change', () => { const o = f.prset.selectedOptions[0]; if (o.dataset.repo) { f.repo.value = o.dataset.repo; f.anchor.value = o.dataset.base; } });
  const req = () => ({ name: f.name.value.trim(), repo: f.repo.value, anchor: f.anchor.value.trim() || 'HEAD', llm: f.llm.value, model: f.model.value.trim(), effort: f.effort.value.trim() || undefined, limit: Number(f.limit.value) });
  f.addEventListener('submit', async e => {
    e.preventDefault(); document.getElementById('cerr').textContent = '';
    let p; try { p = await api('/api/cache/plan', req()); } catch (err) { document.getElementById('cerr').textContent = err.message; return; }
    document.getElementById('cplan').innerHTML = `<div class="card confirm" style="margin-top:14px"><h2 style="margin-top:0">Build ${esc(p.name)}</h2>
      <dl class="kv"><dt>Checkout</dt><dd>bench/repos/${esc(p.repo)} at <code>${esc(p.anchor.slice(0, 12))}</code> — ${esc(p.anchor_subject || '')} (${fmt.dt(Date.parse(p.anchor_date))})</dd>
      <dt>Mining</dt><dd>${esc(p.model)} via ${esc(p.llm)}${p.effort ? `, effort ${esc(p.effort)}` : ''}, ${p.limit} changes from the git history before the anchor</dd>
      <dt>Steps</dt><dd>${p.steps.map(esc).join('<br>')}</dd><dt>Spend</dt><dd>${esc(p.estimate.note)}</dd><dt>Output</dt><dd><code>bench/caches/${esc(p.name)}/</code></dd></dl>
      <p><label class="check"><input type="checkbox" id="cok"> The mining model is the model the experiment's agent will run, and the anchor is at or before the PRs' base.</label></p>
      <button class="primary" id="cgo" disabled>Start the build</button> <span class="err" id="cgerr"></span></div>`;
    const ok = document.getElementById('cok'), go = document.getElementById('cgo');
    ok.onchange = () => { go.disabled = !ok.checked; };
    go.onclick = async () => { go.disabled = true; try { const r = await api('/api/cache/build', { ...req(), confirm: true }); location.hash = `#/cache/${enc(r.name)}`; } catch (err) { document.getElementById('cgerr').textContent = err.message; go.disabled = false; } };
  });
}

async function pageCache(name) {
  const x = await api('/api/cache?name=' + enc(name));
  const c = x.cache;
  $app.innerHTML = `<p class="muted"><a href="#/caches">Caches</a> / ${esc(name)}</p><h1>${esc(name)}</h1>
    <p class="sub">${esc(c.repo)} · anchor <code>${esc(c.anchor.slice(0, 12))}</code> ${esc(c.anchor_subject || '')} · mined by ${esc(c.model)} (${esc(c.llm)}) · ${c.limit} changes</p>
    <div id="live"></div>
    ${c.status !== 'ok' ? `<div class="card confirm" id="resume" hidden>This build did not finish (${esc(c.error || c.status)}). Resuming continues after ${(c.steps_done || []).map(esc).join(', ') || 'nothing'} with the same parameters; the steps already done are not repeated. <button class="primary" id="resumego">Resume the build</button> <span class="err" id="rerr"></span></div>` : ''}
    <div class="tiles">${tile('Status', esc(c.status), c.error ? esc(c.error) : `steps: ${(c.steps_done || []).map(esc).join(', ') || '–'}`)}${tile('Notes', fmt.n(c.notes), `${c.described ?? '–'} described · ${c.sources ? `${c.sources.pr} from PRs` : ''}`)}${tile('Mined', fmt.n(c.usage?.mined), `${fmt.n(c.usage?.saved)} saved`)}${tile('Tokens', fmt.tok(c.usage?.tokens), 'as the product logged them')}</div>
    <h2>Checks</h2><div class="card">${checkList(x.checks)}</div>
    ${x.against.map(a => `<h2>Against PR set ${esc(a.prset)}</h2><div class="card">${checkList(a.checks)}</div>`).join('')}
    <h2>Used by</h2><p>${x.used_by.map(d => `<a href="#/exp/${enc(d)}">${esc(d)}</a>`).join(', ') || '<span class="muted">no experiment yet</span>'}</p>
    <details class="card"><summary>Receipt</summary><pre>${esc(JSON.stringify(c, null, 2))}</pre></details>`;
  const showBuild = j => { const el = document.getElementById('live'); if (!el) return; el.innerHTML = j ? buildPanel(j) : ''; if (j) bindCancel(el, () => route()); };
  const running = x.job?.status === 'running' ? x.job : null;
  showBuild(running);
  if (running) pollTimer = setInterval(async () => {
    const y = await api('/api/cache?name=' + enc(name)).catch(() => null);
    if (!y) return;
    if (y.job?.status !== 'running') { clearInterval(pollTimer); route(); return; }
    showBuild(y.job);
  }, 2000);
  else if (document.getElementById('resume')) {
    document.getElementById('resume').hidden = false;
    document.getElementById('resumego').onclick = async e => {
      e.target.disabled = true;
      try { await api('/api/cache/build', { name: c.name, repo: c.repo, anchor: c.anchor, llm: c.llm, model: c.model, effort: c.effort || undefined, limit: c.limit, resume: true, confirm: true }); route(); }
      catch (err) { document.getElementById('rerr').textContent = err.message; e.target.disabled = false; }
    };
  }
}

// ---------- one session: transcript, with its figures in a sidebar ----------
async function pageSession(id) {
  const x = await api('/api/session?id=' + enc(id));
  const r = x.row, t = x.transcript, st = x.stats, raw = x.raw || {};
  const g = raw.grade || {}, crit = g.criteria?.results || g.results || [];
  const role = r.arm === x.meta.off ? 'cache off' : r.arm === x.meta.on ? 'cache on' : '';
  const kindLabel = { user: 'user', assistant: 'agent', thinking: 'thinking', tool: 'tool', system: 'system' };
  const step = (s, i) => `<div class="step ${s.kind}${s.thinker ? ' thinker' : ''}${s.error ? ' error' : ''}" id="s${i}">
    <div class="shead"><span class="skind">${kindLabel[s.kind] || s.kind}</span>${s.name ? `<b>${esc(s.name)}</b>` : ''}${s.thinker ? ' <span class="pill kind">thinker</span>' : ''}${s.error ? ' <span class="status critical">error</span>' : ''}
      <span class="muted small" style="margin-left:auto">${s.usage ? `${fmt.tok(s.usage.in)} in · ${fmt.tok(s.usage.out)} out · ` : ''}${s.ts ? new Date(s.ts).toLocaleTimeString() : ''} #${i + 1}</span></div>
    ${s.text ? (s.kind === 'thinking' || s.text.length > 1200 ? `<details ${s.kind === 'thinking' || (s.kind === 'system' && !s.thinker) ? '' : 'open'}><summary class="muted small">${s.kind === 'thinking' ? 'thinking' : 'text'} (${s.text.length} chars)</summary><pre>${esc(s.text)}</pre></details>` : `<div class="stext">${esc(s.text)}</div>`) : ''}
    ${s.input ? `<pre class="sin">${esc(s.input)}</pre>` : ''}
    ${s.output ? `<details><summary class="muted small">result (${s.output.length} chars)</summary><pre>${esc(s.output)}</pre></details>` : ''}
  </div>`;
  const filters = ['all', 'agent', 'tools', 'thinker', 'errors'];
  $app.innerHTML = `<p class="muted"><a href="#/exp/${enc(r.run)}">${esc(x.meta.name || r.run)}</a> / ${esc(x.task?.pr ? '#' + x.task.pr : r.task)} / ${esc(r.arm)} · rep ${r.rep}</p>
    <div class="session">
      <div class="smain">
        <h1>${esc(x.task?.pr ? 'PR #' + x.task.pr : r.task)} <span class="pill">${esc(r.arm)}${role ? ' · ' + role : ''}</span></h1>
        <p class="sub">${esc(x.task?.title || '')}</p>
        ${x.partners.length ? `<p class="small">Same PR and rep in the other arms: ${x.partners.map(p => `<a href="#/session/${enc(p.id)}">${esc(p.arm)}</a> <span class="muted">${p.invalid ? 'invalid' : p.pass === 1 ? 'pass' : p.pass === 0 ? 'fail' : ''} · ${fmt.tok(p.in_tokens)} · ${p.tool_calls ?? '–'} calls</span>`).join(' · ')}</p>` : ''}
        ${!t ? `<div class="card confirm">No transcript for this session: it was not archived before the agent CLI removed it${raw.session ? ` (session <code>${esc(raw.session)}</code>)` : ''}.</div>` : `
          <div class="filters"><span class="seg">${filters.map(f => `<button data-f="${f}" class="${f === 'all' ? 'on' : ''}">${f}</button>`).join('')}</span>
          <span class="muted small">${t.steps.length} steps · ${esc(t.format)} transcript · ${(t.bytes / 1e3).toFixed(0)} kB ${t.archived ? '· archived in the run folder' : '· <b>not archived yet</b>'}</span></div>
          <div id="steps">${t.steps.map(step).join('')}</div>`}
        ${x.result ? `<h2>Final message</h2><pre>${esc(x.result)}</pre>` : ''}
        ${x.diff ? `<h2>Diff</h2><pre>${esc(x.diff.slice(0, 60000))}</pre>` : ''}
      </div>
      <aside class="sside card">
        <div class="sblock"><div class="k">Outcome</div><div class="big">${r.invalid ? '<span class="status serious">invalid</span>' : r.pass == null ? (r.score != null ? 'score ' + r.score.toFixed(2) : 'ungraded') : r.pass ? '<span class="status good">pass</span>' : '<span class="status critical">fail</span>'}</div>
          <div class="muted small">${r.invalid ? esc(r.invalid) : r.outcome_source ? `by ${esc(r.outcome_source)}${r.judge ? ' · ' + esc(r.judge) : ''}` : ''}</div></div>
        <dl class="kv side">
          <dt>Model</dt><dd>${esc(r.model || '–')}</dd>
          <dt>Turns</dt><dd>${r.turns ?? '–'}</dd>
          <dt>Wall time</dt><dd>${fmt.ms(r.wall_ms)}</dd>
          <dt>Input tokens</dt><dd>${fmt.tok(r.in_tokens)}</dd>
          <dt class="sub2">fresh</dt><dd>${fmt.tok(r.fresh_in)}</dd><dt class="sub2">cache read</dt><dd>${fmt.tok(r.cache_read)}</dd><dt class="sub2">cache write</dt><dd>${fmt.tok(r.cache_write)}</dd>
          <dt>Output tokens</dt><dd>${fmt.tok(r.out_tokens)}</dd>
          <dt>Spend</dt><dd>${fmt.usd(r.cost)}</dd>
          <dt>Tool calls</dt><dd>${r.tool_calls ?? st?.tool_calls ?? '–'}${st?.tool_errors ? ` <span class="err">(${st.tool_errors} errors)</span>` : ''}</dd>
          <dt>Before first edit</dt><dd>${st?.calls_before_first_edit ?? r.calls_before_edit ?? '–'}</dd>
          <dt>Files read</dt><dd>${r.files_read ?? '–'}</dd>
          <dt>Notes served</dt><dd>${r.injected}${r.thinker_calls ? ` · ${r.thinker_calls} thinker calls` : ''}</dd>
        </dl>
        ${st?.by_tool && Object.keys(st.by_tool).length ? `<div class="sblock"><div class="k">Tools</div>${Object.entries(st.by_tool).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="trow"><span>${esc(k)}</span><span class="tbar"><span style="width:${(v / Math.max(...Object.values(st.by_tool))) * 100}%"></span></span><span class="num">${v}</span></div>`).join('')}</div>` : ''}
        ${raw.tools?.injected?.length ? `<div class="sblock"><div class="k">Served notes</div>${raw.tools.injected.map(n => `<div class="small"><code>${esc(String(n).slice(0, 60))}</code></div>`).join('')}</div>` : ''}
        ${g.reason ? `<div class="sblock"><div class="k">Judge</div><div class="small">${esc(g.reason)}</div></div>` : ''}
        ${crit.length ? `<div class="sblock"><div class="k">Criteria</div>${crit.map(c => `<div class="small">${c.verdict === 'met' ? '✓' : '✗'} ${esc(c.id)} <span class="muted">${esc(String(c.evidence || '').slice(0, 120))}</span></div>`).join('')}</div>` : ''}
        ${g.testTail ? `<div class="sblock"><div class="k">Tests: ${esc(g.tests)}</div><pre class="small">${esc(g.testTail.slice(-600))}</pre></div>` : ''}
        <div class="sblock muted small">${raw.session ? `session <code>${esc(raw.session)}</code><br>` : ''}imported from <code>bench/runs/${esc(r.run)}/${esc(r.file)}</code></div>
      </aside>
    </div>`;
  document.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b));
    const f = b.dataset.f;
    document.querySelectorAll('#steps .step').forEach(el => {
      const show = f === 'all' || (f === 'agent' && el.classList.contains('assistant')) || (f === 'tools' && el.classList.contains('tool')) || (f === 'thinker' && el.classList.contains('thinker')) || (f === 'errors' && el.classList.contains('error'));
      el.hidden = !show;
    });
  }));
}

// ---------- new experiment, built from modules ----------
async function pageNew() {
  const cat = await api('/api/catalog');
  const today = new Date().toISOString().slice(0, 10);
  $app.innerHTML = `<h1>New experiment</h1>
    <p class="sub">An experiment is put together from modules: the question, a frozen <a href="#/prsets">PR set</a>, a mined <a href="#/caches">cache</a>, the arms, the agent and the grader. Every module is checked in the plan, and nothing starts until you have reviewed the plan and confirmed it.</p>
    <form class="launch card" id="f">
      <h3 class="full">1 · Question</h3>
      <label style="grid-column:span 2">What it tests<input name="question" required maxlength="300" placeholder="Does the prompt hook cut exploration for Sonnet on PostHog PRs?"></label>
      <label>Tests a<select name="kind"><option value="behavior">behavior (a cache feature, prompt, wiring)</option><option value="model">model (how one model does with the cache)</option></select></label>
      <label>Name<input name="name" required maxlength="120" placeholder="Prompt hook · Sonnet · PostHog"></label>
      <h3 class="full">2 · PR set</h3>
      <label style="grid-column:span 2">PR set<select name="prset">${cat.prsets.filter(p => (p.status || 'frozen') === 'frozen').map(p => `<option value="${esc(p.name)}" data-repo="${esc(p.repo)}">${esc(p.name)} · ${esc(p.repo)} · ${p.prs.length} PRs</option>`).join('') || '<option value="">no PR sets yet</option>'}</select></label>
      <div class="full muted small" id="prsetinfo"></div>
      <h3 class="full">3 · Cache</h3>
      <label style="grid-column:span 2">Cache served to the cache-on arm<select name="cache"></select></label>
      <div class="full muted small" id="cacheinfo"></div>
      <h3 class="full">4 · Arms</h3>
      <label>Cache off arm<input name="off" required></label>
      <label>Cache on arm<input name="on" required></label>
      <label style="grid-column:span 2">Extra arms (optional)<input name="extra" placeholder="e.g. irrelevant (placebo notes)"></label>
      <h3 class="full">5 · Agent</h3>
      <label>Runner<select name="runner">${Object.entries(cat.runners).map(([k, r]) => `<option value="${k}">${esc(r.label)}</option>`).join('')}</select></label>
      <label>Model<input name="model" required></label>
      <label>Reps per PR × arm<input name="reps" type="number" min="1" max="10" value="2"></label>
      <label>Concurrent sessions<input name="conc" type="number" min="1" max="8" value="2"></label>
      <div class="full checks" id="bools"></div>
      <div class="full checks" id="vals"></div>
      <h3 class="full">6 · Grading</h3>
      <label>Judge model<input name="judge" placeholder="required unless every PR has tests"></label>
      <div class="full muted small" id="gradeinfo"></div>
      <h3 class="full">7 · Output</h3>
      <label>Tag (folder under bench/runs)<input name="tag" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*"></label>
      <div class="full"><button type="submit" class="primary">Review plan</button> <span id="ferr" class="err"></span></div>
    </form>
    <div id="plan"></div>`;
  const f = document.getElementById('f');
  let tagTouched = false;
  const prsetOf = () => cat.prsets.find(p => p.name === f.prset.value);
  if (cat.prsets.some(p => p.status === 'draft')) document.getElementById('prsetinfo').insertAdjacentHTML('afterend', '<div class="full muted small">Drafts are not listed: <a href="#/prsets">freeze a PR set</a> to run it.</div>');
  const autoTag = () => { if (!tagTouched) f.tag.value = `${prsetOf()?.repo || 'x'}-${f.model.value.replace(/[^A-Za-z0-9.]+/g, '-')}-${today}`; };
  const syncPrset = () => {
    const p = prsetOf();
    document.getElementById('prsetinfo').innerHTML = p ? `${esc(p.rule)} · ${esc(p.tasks)} at ${esc((p.base || '?').slice(0, 10))} · ${p.prs.map(x => esc(x.pr ? '#' + x.pr : x.id)).join(', ')}` : '<a href="#/prsets">Create a PR set</a> first.';
    const fit = cat.caches.filter(c => !p || c.repo === p.repo);
    f.cache.innerHTML = fit.map(c => `<option value="${esc(c.name)}">${esc(c.name)} · ${esc(c.model)} · ${c.notes ?? 0} notes · ${esc(c.status)}</option>`).join('') || '<option value="">no cache for this repository</option>';
    const oracles = p ? [...new Set(p.prs.map(x => x.oracle))] : [];
    document.getElementById('gradeinfo').textContent = oracles.length ? (oracles.every(o => o === 'tests') ? 'Every PR has its own tests: graded by them, no judge needed.' : `Graded by a judge (${oracles.join(', ')}): name the judge model; judged numbers compare only with the same judge.`) : '';
    syncCache(); autoTag();
  };
  const syncCache = () => {
    const c = cat.caches.find(x => x.name === f.cache.value);
    document.getElementById('cacheinfo').innerHTML = c ? `mined by <b>${esc(c.model)}</b> (${esc(c.llm)}) at ${esc(c.anchor.slice(0, 10))} · ${c.notes ?? 0} notes · the agent model must match` : '<a href="#/caches">Build a cache</a> for this PR set first.';
    if (c && !f.model.dataset.touched) f.model.value = c.model;
    autoTag();
  };
  const syncRunner = () => {
    const r = cat.runners[f.runner.value];
    [f.off.value, f.on.value] = r.defaultArms.split(',');
    if (!f.model.value) f.model.value = r.defaultModel;
    document.getElementById('bools').innerHTML = r.booleans.map(b => `<label class="check"><input type="checkbox" name="b:${b}" ${b === 'strict-model' ? 'checked' : ''}> --${b}</label>`).join('');
    document.getElementById('vals').innerHTML = r.values.map(v => `<label style="display:grid;gap:3px">--${v}<input name="v:${v}" style="width:160px"></label>`).join('');
  };
  f.prset.addEventListener('change', syncPrset); f.cache.addEventListener('change', syncCache); f.runner.addEventListener('change', syncRunner);
  f.model.addEventListener('input', () => { f.model.dataset.touched = '1'; autoTag(); }); f.tag.addEventListener('input', () => { tagTouched = true; });
  syncRunner(); syncPrset();

  const request = () => ({
    name: f.name.value.trim(), question: f.question.value.trim(), kind: f.kind.value, prset: f.prset.value, cache: f.cache.value,
    runner: f.runner.value, off: f.off.value.trim(), on: f.on.value.trim(), extra: f.extra.value.trim(),
    model: f.model.value.trim(), judge: f.judge.value.trim() || undefined, reps: Number(f.reps.value), conc: Number(f.conc.value), tag: f.tag.value.trim(),
    flags: Object.fromEntries([...f.querySelectorAll('input[name^="b:"]')].map(c => [c.name.slice(2), c.checked])),
    values: Object.fromEntries([...f.querySelectorAll('input[name^="v:"]')].map(c => [c.name.slice(2), c.value.trim()])),
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const ferr = document.getElementById('ferr'); ferr.textContent = '';
    const req = request();
    let p;
    try { p = await api('/api/plan', req); } catch (err) { ferr.textContent = err.message; return; }
    const est = p.estimate, m = p.modules;
    document.getElementById('plan').innerHTML = `<div class="card confirm" style="margin-top:16px">
      <h2 style="margin-top:0">${esc(req.name)}: ${p.sessions} agent session${p.sessions === 1 ? '' : 's'} ${p.blocked ? '<span class="status critical">blocked</span>' : ''}</h2>
      <dl class="kv">
        <dt>Question</dt><dd>${esc(req.question)} <span class="pill kind">${esc(req.kind)}</span></dd>
        <dt>PR set</dt><dd>${esc(m.prset.name)} · ${m.prset.prs} PRs from ${esc(m.prset.tasks)} at ${esc((m.prset.base || '?').slice(0, 10))} — ${esc(m.prset.rule)}</dd>
        <dt>Cache</dt><dd>${esc(m.cache.name)} · ${m.cache.notes} notes mined by ${esc(m.cache.model)} at ${esc(m.cache.anchor.slice(0, 10))}</dd>
        <dt>Arms</dt><dd><b>${esc(m.arms.off)}</b> (cache off) against <b>${esc(m.arms.on)}</b> (cache on)${m.arms.extra.length ? `, plus ${m.arms.extra.map(esc).join(', ')}` : ''}</dd>
        <dt>Agent</dt><dd>${esc(p.model)} via ${esc(p.runner)} · ${p.reps} reps · ${p.conc} at a time</dd>
        <dt>Sessions</dt><dd>${m.prset.prs} PRs × ${p.arms.length} arms × ${p.reps} reps = ${p.expected.length}${p.resumed ? ` · <b>${p.resumed} already on disk, skipped</b>` : ''}</dd>
        <dt>Grading</dt><dd>${esc(p.graded)}</dd>
        <dt>Estimate</dt><dd>${est ? `${fmt.tok(est.in_tokens)} input + ${fmt.tok(est.out_tokens)} output tokens${est.cost != null ? ` · about ${fmt.usd(est.cost)} at list price` : ''} · about ${fmt.ms(est.wall_ms)} <span class="muted">(medians of ${est.n} past results: ${esc(est.basis)}; judge calls not included)</span>` : '<span class="err">no past results for this model, so no estimate</span>'}</dd>
        <dt>Command</dt><dd><code style="word-break:break-all">${esc(p.command)}</code></dd>
      </dl>
      <h3>Checks</h3>${checkList(p.checks)}
      ${p.blocked ? '<p class="err">A check failed: fix the module it names (a new PR set or cache) and review again.</p>' : `
      <p style="margin:14px 0 8px"><label class="check"><input type="checkbox" id="ok"> I have checked the modules, sessions, grader and estimate above.</label></p>
      <button class="primary" id="go" disabled>Start ${p.sessions} session${p.sessions === 1 ? '' : 's'}</button> <span id="gerr" class="err"></span>`}
    </div>`;
    const ok = document.getElementById('ok'), go = document.getElementById('go');
    if (ok) {
      ok.addEventListener('change', () => { go.disabled = !ok.checked || !p.sessions; });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try { const r = await api('/api/launch', { ...req, confirm: true, sessions: p.sessions }); location.hash = `#/exp/${enc(r.tag)}`; }
        catch (err) { document.getElementById('gerr').textContent = err.message; go.disabled = false; }
      });
    }
    document.getElementById('plan').scrollIntoView({ behavior: 'smooth' });
  });
}

route();
