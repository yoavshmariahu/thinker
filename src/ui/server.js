// `thinker ui`: a local page for the person, on this machine only. Three views: how the cache has been
// used (usage.js:summarize, in tokens, never dollars), filtered by repository; the caches on the
// machine (machine.js), one card per repository with what runs against it (activity.js) and, inside
// one, its notes (archive or restore, ops.js:archiveNotes) and the desired behaviors of the system,
// where the ones waiting for a decision can be accepted, edited or discarded (behavior-workbench.js);
// and the warm-up page, where the repositories the agents have worked in are picked for a cache
// build, which runs here as a detached `thinker setup --build` per repository, one at a time.
//
// The page is machine-wide: it needs no repository, and a repository is named by its id (as the log
// names it) so the page cannot be pointed at a path.
//
// It listens on 127.0.0.1 alone. Every API call carries a token minted for this run, which the page
// gets from the URL it was opened with, and the Host header must name this server, so another page
// in the browser (or a DNS rebinding) can neither read the cache nor change a behavior.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize } from '../usage.js';
import { Store, repoId, isGitCheckout } from '../store.js';
import { refresh, archiveNotes } from '../ops.js';
import { reviewSkill } from '../skills.js';
import { isBehavior } from '../behavior.js';
import { pendingBehaviors, activeBehaviors, acceptPending, discardPending, editBehavior } from '../behavior-workbench.js';
import { discoverRepos, warmupCandidates, cacheStats, displayName } from '../machine.js';
import { activity, cancelActivity, alive, latestBatch, batchEta } from '../activity.js';
import { thinkerHome } from '../update.js';
import { BUILD_AGENTS, buildAgent, checkAgentAuth, getAgentDisplayName } from '../setup/agents.js';
import { DEPTHS, DEFAULT_DEPTH } from '../setup/estimate.js';
import { resolveModel, findBin, BINS, DEFAULT_DISTILL_MODEL } from '../llm.js';
import { isDisabledRepo, setRepoDisabled } from '../repo-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4848;
export const TIERS = ['haiku', 'sonnet', 'opus'];

// Only what the page shows: counts and tokens. The provider-reported cost stays out (no dollars).
export function usageView(store, { days, scope = 'here', notesInCache } = {}) {
  const u = summarize(store, { days, all: scope !== 'here' });
  const tok = o => o ? { calls: o.calls || 0, tokens: o.totalTokens || 0, failed: o.failed || 0 } : { calls: 0, tokens: 0, failed: 0 };
  const count = () => { try { return store.list().filter(n => n.status !== 'invalid').length; } catch { return 0; } };
  return {
    scope: u.scope, from: u.from, to: u.to, days: days || null,
    requests: u.requests || 0, answered: u.answered || 0, sessions: u.sessions || 0,
    servings: u.servings || {}, notesServed: u.notesServed || 0, notesInCache: notesInCache ?? count(),
    tokensServed: u.tokensServed || 0,
    assessed: u.assessed || {}, learned: u.learned || {}, verified: u.verified || {},
    spending: { ...tok(u.spending), byPhase: Object.fromEntries(Object.entries(u.spending?.byPhase || {}).map(([k, v]) => [k, tok(v)])) },
    saved: { tokens: u.saved?.tokens || 0, servings: u.saved?.servings || 0, calls: u.saved?.calls || 0 },
    holdout: u.holdout ? { served: u.holdout.served, heldOut: u.holdout.heldOut, enough: !!u.holdout.enough, deltaPct: u.holdout.deltaPct || {} } : null,
    repos: (u.repos || []).map(r => ({ repo: r.repo, requests: r.requests || 0, served: r.served || 0, learned: r.learned || 0, notes: r.notes || 0, tokens: r.spending?.totalTokens || 0 })),
    top: (u.top || []).filter(t => t.title && t.title !== '(removed)').slice(0, 8).map(t => ({ id: t.id, title: t.title, served: t.served, repo: t.repo })),
  };
}

// The notes in the cache, behaviors aside (they have their own view). Staleness is recomputed against
// the working tree but not written: a GET leaves the cache as it was.
export function cacheView(store) {
  let notes = []; try { notes = refresh(store, store.list().filter(n => !isBehavior(n)), { persist: false }); } catch {}
  return {
    notes: notes.map(n => ({
      id: n.id, title: n.title, kind: n.kind, body: n.body || '',
      status: n.status === 'invalid' ? 'retired' : n.status === 'broken' ? 'broken' : n.archived ? 'archived' : n.status === 'stale' ? 'stale' : 'fresh',
      // a skill card (skills.js): the file it stands for, and what the audit or a session found wrong with it
      skill: n.kind === 'skill' ? { name: n.skill?.name || '', file: n.skill?.file || '' } : null,
      broken: n.status === 'broken' && n.broken ? { at: n.broken.at || null, reason: n.broken.reason || '', source: n.broken.source || '', issues: (n.broken.issues || []).map(i => ({ claim: i.claim || '', actual: i.actual || '', pointer: i.pointer || '' })) } : null,
      archived: n.archived ? { at: n.archived.at, reason: n.archived.reason } : null,
      changed: n.status === 'stale' ? (n.stale?.changed || []).map(c => typeof c === 'string' ? c : `${c.path}${c.symbol ? ':' + c.symbol : ''}${c.reason ? ' (' + c.reason + ')' : ''}`) : [],
      invalidReason: n.status === 'invalid' ? n.invalidReason || '' : '',
      pointers: (n.deps || []).map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''}`),
      source: n.source?.ref || n.source?.type || '', scope: store.isShared(n.id) ? 'repo' : 'local',
      confidence: n.confidence ?? 0.7, uses: n.uses || 0, lastUsed: n.lastUsed || null,
      created: n.created || null, verified: n.verified || null,
    })),
  };
}

// The repositories with a cache on this machine: this one, and every checkout the agents' transcripts
// or the machine's log name that has a .thinker folder. A repository with several checkouts (clones,
// worktrees) is read from the one holding the most notes, this one when they tie.
export function machineRepos(store, { home } = {}) {
  const here = isGitCheckout(store.repo) && store.exists() ? store.repo : null;
  const byOrigin = new Map();
  const add = c => { const o = repoId(c); if (!byOrigin.has(o)) byOrigin.set(o, new Set()); byOrigin.get(o).add(c); };
  if (here) add(here);
  let found = []; try { found = discoverRepos(store, { home }); } catch {}
  for (const r of found) for (const c of r.checkouts) if (fs.existsSync(path.join(c, '.thinker'))) add(c);
  const count = c => { try { return new Store(c, { readonly: true }).list().length; } catch { return -1; } };
  const out = [];
  for (const [id, checkouts] of byOrigin) {
    const scored = [...checkouts].map(c => [c, count(c)]).filter(([, n]) => n >= 0).sort((a, b) => b[1] - a[1] || (b[0] === here) - (a[0] === here));
    if (!scored.length) continue;
    const checkout = scored[0][0];
    out.push({ id, name: displayName(id, checkout), checkout, current: checkout === here, disabled: isDisabledRepo(checkout) });
  }
  return out.sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

// Where a running warm-up build is: a fraction of the whole and the seconds left, for the page's bar.
// A build has three stages (setup/steps.js:stepBuildCache): the design documents, the mining batch,
// then linking, phrasings and behavior drafts. The mining batch has a count and a measured pace (its
// file under the repository's .thinker/state); the other two have only a time budget, so during them
// the bar creeps towards the stage's end and the ETA counts the budget down. `estimateSeconds` is the
// mining estimate the page showed when the build was queued.
const DOCS_SECONDS = 45, FINISH_SECONDS = 75;
export function jobProgress(j, { now = Date.now() } = {}) {
  const started = Date.parse(j.started) || now, elapsed = (now - started) / 1000;
  const mineSec = Math.max(30, Number(j.estimateSeconds) || 0);
  const total = DOCS_SECONDS + mineSec + FINISH_SECONDS;
  const creep = (t, budget) => Math.min(0.95, Math.max(0, t) / budget);
  const batch = latestBatch(path.join(j.checkout, '.thinker'), 'pr-mining', started - 2000);
  let done, left, stage, current = '';
  if (!batch) {
    stage = 'reading the design documents';
    done = DOCS_SECONDS * creep(elapsed, DOCS_SECONDS);
    left = Math.max(5, DOCS_SECONDS - elapsed) + mineSec + FINISH_SECONDS;
  } else if (!batch.done) {
    const frac = batch.total ? Math.min(1, batch.completed / batch.total) : 0, inStage = (now - batch.startedMs) / 1000;
    const eta = batchEta(batch, batch.startedMs, now);
    stage = `mining ${batch.completed}/${batch.total} PRs`; current = batch.current;
    done = DOCS_SECONDS + mineSec * frac;
    left = (eta ?? Math.max(5, mineSec - inStage)) + FINISH_SECONDS;
  } else {
    const inStage = (now - (Date.parse(batch.ended) || batch.startedMs)) / 1000;
    stage = 'linking notes, search phrasings and behavior drafts';
    done = DOCS_SECONDS + mineSec + FINISH_SECONDS * creep(inStage, FINISH_SECONDS);
    left = Math.max(5, FINISH_SECONDS - inStage);
  }
  return { fraction: Math.min(0.99, done / total), etaSeconds: Math.round(left), stage, current, saved: batch?.saved || 0 };
}

// The warm-up builds: one detached `thinker setup --build` per repository, one at a time (they all
// run through the same agent login), remembered in THINKER_HOME/state/warmup.json so the page shows
// them after this server restarts. A running job carries its `progress` (jobProgress).
export function warmupJobs({ home, cliPath, spawnFn = spawn, onChange = () => {} }) {
  const file = path.join(home, 'state', 'warmup.json');
  let jobs = []; try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs || []; } catch {}
  // a job an earlier server started cannot be waited on (`orphan`): it is running while its process is
  for (const j of jobs) { if (j.status === 'running') { j.orphan = true; if (!alive(j.pid)) { j.status = 'done'; j.ended = new Date().toISOString(); } } else if (j.status === 'queued') j.status = 'cancelled'; }
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ jobs: jobs.slice(-50) }, null, 2)); } catch {} onChange(); };
  const settle = () => { let changed = false; for (const j of jobs) if (j.status === 'running' && j.orphan && !alive(j.pid)) { j.status = 'done'; j.ended = new Date().toISOString(); changed = true; } if (changed) { save(); pump(); } };
  const pump = () => {
    for (const j of jobs) if (j.status === 'running' && j.orphan && !alive(j.pid)) { j.status = 'done'; j.ended = new Date().toISOString(); }
    if (jobs.some(j => j.status === 'running')) return;
    const next = jobs.find(j => j.status === 'queued'); if (!next) return;
    const args = [cliPath, 'setup', '--build', '--yes', '--no-ui', '--no-benchmark', '--depth', next.depth, '--repo', next.checkout];
    args.push(...(next.directories?.length ? ['--directories', next.directories.join(',')] : ['--full-repo']));
    if (next.model) args.push('--model', next.model);
    let child;
    try {
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      const log = fs.openSync(path.join(home, 'state', `warmup-${next.name.replace(/\W+/g, '-')}.log`), 'a');
      child = spawnFn(process.execPath, args, { cwd: next.checkout, detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...(next.agent ? { THINKER_LLM: next.agent } : {}), THINKER_INSTALLER: '1' } });
    } catch (e) { next.status = 'failed'; next.error = e.message; next.ended = new Date().toISOString(); save(); return pump(); }
    next.status = 'running'; next.pid = child.pid; next.started = new Date().toISOString(); save();
    child.on('exit', code => { if (next.status === 'running') next.status = code === 0 ? 'done' : 'failed'; next.code = code; next.ended = new Date().toISOString(); save(); pump(); });
    child.on('error', e => { next.status = 'failed'; next.error = e.message; next.ended = new Date().toISOString(); save(); pump(); });
    child.unref();
  };
  return {
    list: () => { settle(); return jobs.map(j => ({ ...j, ...(j.status === 'running' ? { progress: jobProgress(j) } : {}) })); },
    active: () => { settle(); return jobs.some(j => j.status === 'queued' || j.status === 'running'); },
    add(list) {
      const added = [];
      for (const r of list) {
        if (jobs.some(j => j.checkout === r.checkout && (j.status === 'queued' || j.status === 'running'))) continue;
        const j = { id: crypto.randomBytes(6).toString('hex'), checkout: r.checkout, name: r.name, depth: r.depth, directories: r.directories || null, agent: r.agent || null, model: r.model || null, estimateSeconds: r.estimateSeconds || 0, status: 'queued', queued: new Date().toISOString() };
        jobs.push(j); added.push(j);
      }
      save(); pump();
      return added;
    },
    cancel(id) {
      const j = jobs.find(x => x.id === id); if (!j) return { error: 'no such job' };
      if (j.status === 'queued') { j.status = 'cancelled'; j.ended = new Date().toISOString(); save(); return { ok: true }; }
      if (j.status !== 'running') return { error: 'the job is not running' };
      j.status = 'cancelled'; j.ended = new Date().toISOString();
      try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
      save(); if (j.orphan) pump();
      return { ok: true };
    },
    // a batch stopped from its repository's card was a job's, when the pids match
    stopped(pid) { const j = jobs.find(x => x.status === 'running' && x.pid === pid); if (j) { j.status = 'cancelled'; j.ended = new Date().toISOString(); save(); if (j.orphan) pump(); } },
  };
}

export function createUiServer(store, { token = crypto.randomBytes(16).toString('hex'), home = thinkerHome(), transcriptsHome, cliPath = path.join(HERE, '..', 'cli.js'), spawnFn = spawn } = {}) {
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
  let port = 0, known = null, lastRequest = Date.now();
  const repos = () => known ||= machineRepos(store, { home: transcriptsHome });
  const opened = new Map();
  const open = checkout => { if (!opened.has(checkout)) opened.set(checkout, new Store(checkout)); return opened.get(checkout); };
  const jobs = warmupJobs({ home, cliPath, spawnFn, onChange: () => { known = null; } });
  // '' is this repository (when it is one); an id must be one machineRepos listed
  const entry = id => !id ? repos().find(r => r.current) : repos().find(r => r.id === id);
  const storeFor = id => { const r = id === 'all' ? null : entry(id); return r ? open(r.checkout) : null; };
  const storesFor = id => {
    if (id === 'all') return repos().flatMap(r => { try { return [[r, open(r.checkout)]]; } catch { return []; } });
    const r = entry(id); return r ? [[r, open(r.checkout)]] : null;
  };
  const withStats = r => {
    let pending = 0; try { pending = pendingBehaviors(open(r.checkout)).length; } catch {}
    return { ...r, stats: cacheStats(r.checkout), pending, job: jobs.list().filter(j => j.checkout === r.checkout).pop() || null };
  };
  let candidates = null, agents = null;
  const server = http.createServer(async (req, res) => {
    lastRequest = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'wrong host' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      return res.end(page);
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    const given = String(req.headers['x-thinker-token'] || '');
    if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 401, { error: 'bad token' });
    try {
      // which repository: '' (this one), 'all', or one of machineRepos by id
      const want = String(url.searchParams.get('repo') || '');
      if (req.method === 'GET' && url.pathname === '/api/repos') { known = machineRepos(store, { home: transcriptsHome }); return json(res, 200, { repos: known.map(withStats), jobs: jobs.list() }); }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const byRepo = {};
        for (const r of repos()) byRepo[r.id] = activity(path.join(r.checkout, '.thinker'));
        return json(res, 200, { repos: byRepo, jobs: jobs.list() });
      }
      if (req.method === 'GET' && url.pathname === '/api/machine') {
        candidates = warmupCandidates(store, { home: transcriptsHome });
        return json(res, 200, { repos: candidates, tiers: TIERS, defaultTier: DEFAULT_DISTILL_MODEL, jobs: jobs.list() });
      }
      // the agent CLIs a build can run through, with whether each is signed in: asking each takes seconds, so
      // once per server
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        agents ||= BUILD_AGENTS.filter(a => findBin(BINS[a])).map(a => { const auth = checkAgentAuth(a); return { agent: a, name: getAgentDisplayName(a, findBin(BINS[a])), authenticated: !!auth.authenticated, details: auth.details || '', loginCmd: auth.loginCmd, models: TIERS.map(t => ({ tier: t, model: resolveModel(a, t) })) }; });
        return json(res, 200, { agents, defaultAgent: buildAgent(), tiers: TIERS, defaultTier: DEFAULT_DISTILL_MODEL });
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const days = Number(url.searchParams.get('days')) || undefined;
        if (want === 'all') { const notesInCache = repos().reduce((a, r) => a + (cacheStats(r.checkout)?.notes || 0), 0); return json(res, 200, usageView(store, { days, scope: 'all', notesInCache })); }
        const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' });
        return json(res, 200, usageView(one, { days, scope: 'here' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/cache') {
        const stores = storesFor(want); if (!stores) return json(res, 400, { error: 'unknown repository' });
        return json(res, 200, { notes: stores.flatMap(([r, st]) => cacheView(st).notes.map(n => ({ ...n, repo: r.id, repoName: r.name }))) });
      }
      if (req.method === 'GET' && url.pathname === '/api/behaviors') {
        const stores = storesFor(want); if (!stores) return json(res, 400, { error: 'unknown repository' });
        const tag = r => b => ({ ...b, repo: r.id, repoName: r.name });
        return json(res, 200, {
          active: stores.flatMap(([r, st]) => activeBehaviors(st).map(tag(r))),
          pending: stores.flatMap(([r, st]) => pendingBehaviors(st).map(tag(r))),
        });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const b = await readBody(req);
      if (url.pathname === '/api/warmup') {
        // only repositories the machine page listed, by checkout, and only the depths a build has
        candidates ||= warmupCandidates(store, { home: transcriptsHome });
        const agent = b.agent && BUILD_AGENTS.includes(b.agent) ? b.agent : null;
        const tier = TIERS.includes(b.tier) ? b.tier : null;
        const list = [];
        for (const r of Array.isArray(b.repos) ? b.repos : []) {
          const c = candidates.find(x => x.checkout === r.checkout); if (!c) return json(res, 400, { error: `not a repository on this machine: ${r.checkout}` });
          if (isDisabledRepo(c.checkout)) return json(res, 400, { error: `thinker is switched off for ${c.name}; turn it on first` });
          const depth = DEPTHS.includes(r.depth) ? r.depth : DEFAULT_DEPTH;
          const dirs = Array.isArray(r.directories) ? r.directories.filter(d => c.dirs.includes(d)) : [];
          list.push({ checkout: c.checkout, name: c.name, depth, directories: dirs.length ? dirs : null, agent, model: tier, estimateSeconds: c.estimates[depth]?.seconds || 0 });
        }
        if (!list.length) return json(res, 400, { error: 'no repositories selected' });
        return json(res, 200, { ok: true, jobs: jobs.add(list) });
      }
      // the switch (repo-switch.js): off for a repository with sensitive content, by a checkout the page listed
      if (url.pathname === '/api/repos/switch') {
        candidates ||= warmupCandidates(store, { home: transcriptsHome });
        const c = candidates.find(x => x.checkout === b.checkout) || repos().find(x => x.checkout === b.checkout);
        if (!c) return json(res, 400, { error: `not a repository on this machine: ${b.checkout}` });
        if (b.disabled && jobs.list().some(j => j.checkout === c.checkout && (j.status === 'queued' || j.status === 'running'))) return json(res, 400, { error: 'a warm-up of this repository is queued or running; stop it first' });
        setRepoDisabled(c.checkout, { disabled: !!b.disabled, name: c.name });
        known = null; candidates = null;
        return json(res, 200, { ok: true, checkout: c.checkout, disabled: !!b.disabled, hasCache: fs.existsSync(path.join(c.checkout, '.thinker')) });
      }
      if (url.pathname === '/api/warmup/cancel') { const r = jobs.cancel(String(b.id || '')); return r.error ? json(res, 400, r) : json(res, 200, r); }
      if (url.pathname === '/api/activity/cancel') {
        const r0 = entry(String(b.repo || '')); if (!r0) return json(res, 400, { error: 'unknown repository' });
        const r = cancelActivity(path.join(r0.checkout, '.thinker'), Number(b.pid));
        if (r.ok) jobs.stopped(Number(b.pid));
        return r.error ? json(res, 400, r) : json(res, 200, r);
      }
      const st = storeFor(String(b.repo || ''));
      if (!st) return json(res, 400, { error: 'unknown repository' });
      let r;
      if (url.pathname === '/api/behaviors/accept') r = acceptPending(st, b.id, { mutability: b.mutability || 'mutable', edit: b.title || b.body ? { title: b.title, body: b.body } : null });
      else if (url.pathname === '/api/behaviors/discard') r = discardPending(st, b.id);
      else if (url.pathname === '/api/cache/review') {
        // a person looked at a skill found out of date: back into serving and audit (skills.js:reviewSkill)
        const n = st.get(b.id);
        if (!n) r = { error: 'no such note' }; else r = reviewSkill(st, b.id);
      }
      else if (url.pathname === '/api/cache/archive' || url.pathname === '/api/cache/restore') {
        const n = st.get(b.id), restore = url.pathname.endsWith('restore');
        if (!n || isBehavior(n)) r = { error: 'no such note' };
        else if (!archiveNotes(st, { ids: [b.id], restore }).length) r = { error: restore ? 'the note is not archived' : 'the note is already archived' };
      }
      else if (url.pathname === '/api/behaviors/edit') r = editBehavior(st, b.id, { title: b.title, body: b.body, mutability: b.mutability });
      else return json(res, 404, { error: 'not found' });
      if (r?.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, id: r?.note?.id, draft: r?.draft });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e).split('\n')[0].slice(0, 300) });
    }
  });
  return {
    server, token, jobs,
    listen(want = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        const tryPort = p => {
          server.once('error', e => { if (e.code === 'EADDRINUSE' && p !== 0) tryPort(0); else reject(e); });
          server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve({ port, url: `http://127.0.0.1:${port}/#t=${token}` }); });
        };
        tryPort(want);
      });
    },
    // the browser keeps connections open; Ctrl+C must not wait for them
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
    // a build queued here keeps the server up until it is started: the queue lives in this process
    idleMs: () => jobs.active() ? 0 : Date.now() - lastRequest,
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}
