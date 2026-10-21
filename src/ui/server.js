// `thinker ui`: a local page for the person, on this machine only. Three views: how the cache has been
// used (usage.js:summarize, in tokens, never dollars), filtered by repository; the caches on the
// machine (machine.js), one card per repository with what runs against it (activity.js) and, inside
// one, its notes (archive or restore, ops.js:archiveNotes) and the desired behaviors of the system,
// where the ones waiting for a decision can be accepted, edited or discarded (behavior-workbench.js).
// The warm-up page that queued cache builds here was removed on 2026-10-21: caches grow from the sessions.
//
// The page is machine-wide: it needs no repository, and a repository is named by its id (as the log
// names it) so the page cannot be pointed at a path.
//
// It listens on 127.0.0.1 alone. Every API call carries a token minted for this run, which the page
// gets from the URL it was opened with, and the Host header must name this server, so another page
// in the browser (or a DNS rebinding) can neither read the cache nor change a behavior.
import { harnessView, harnessSavings, harnessOn, scheduleHarnessSuggestion, undoHarness, switchOffNow, setHarnessSettings } from '../harness.js';
import { contextView, mergeViews, switchSources, setOutputCompression } from '../context-view.js';
import { judgeRecent } from '../instruction-value.js';
import { setCore } from '../instructions-core.js';
import { previewEdit, applyEdit } from '../instruction-edit.js';
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
import { discoverRepos, cacheStats, displayName } from '../machine.js';
import { activity, cancelActivity } from '../activity.js';
import { thinkerHome } from '../update.js';
import { isDisabledRepo } from '../repo-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4848;

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
    holdout: u.holdout ? { served: u.holdout.served, heldOut: u.holdout.heldOut, sessions: u.holdout.sessions || 0, enough: !!u.holdout.enough, deltaPct: u.holdout.deltaPct || {}, saved: u.holdout.saved || {} } : null,
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

export function createUiServer(store, { token = crypto.randomBytes(16).toString('hex'), home = thinkerHome(), transcriptsHome, cliPath = path.join(HERE, '..', 'cli.js') } = {}) {
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
  let port = 0, known = null, lastRequest = Date.now();
  const repos = () => known ||= machineRepos(store, { home: transcriptsHome });
  const opened = new Map();
  const open = checkout => { if (!opened.has(checkout)) opened.set(checkout, new Store(checkout)); return opened.get(checkout); };
  // '' is this repository (when it is one); an id must be one machineRepos listed
  const entry = id => !id ? repos().find(r => r.current) : repos().find(r => r.id === id);
  const storeFor = id => { const r = id === 'all' ? null : entry(id); return r ? open(r.checkout) : null; };
  const storesFor = id => {
    if (id === 'all') return repos().flatMap(r => { try { return [[r, open(r.checkout)]]; } catch { return []; } });
    const r = entry(id); return r ? [[r, open(r.checkout)]] : null;
  };
  const withStats = r => {
    let pending = 0; try { pending = pendingBehaviors(open(r.checkout)).length; } catch {}
    return { ...r, stats: cacheStats(r.checkout), pending };
  };
  const harnessCache = new Map();
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
      if (req.method === 'GET' && url.pathname === '/api/repos') { known = machineRepos(store, { home: transcriptsHome }); return json(res, 200, { repos: known.map(withStats) }); }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const byRepo = {};
        for (const r of repos()) byRepo[r.id] = activity(path.join(r.checkout, '.thinker'));
        return json(res, 200, { repos: byRepo });
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
      // what Claude Code loads into every session here and what switching it off saved (harness.js:harnessView, as `thinker harness`)
      if (req.method === 'GET' && url.pathname === '/api/harness') {
        if (want === 'all') return json(res, 200, { repos: repos().flatMap(r => { try { const st = open(r.checkout); if (!harnessOn(st)) return []; const sv = harnessSavings(st); return sv.sources.length ? [{ repo: r.id, repoName: r.name, saved: sv }] : []; } catch { return []; } }) });
        const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' });
        // it reads every transcript of the window (seconds on a busy repository): kept a minute, dropped on an action
        const k = `${one.repo}:${Number(url.searchParams.get('days')) || 30}`, hit = harnessCache.get(k);
        if (hit && Date.now() - hit.at < 60_000) return json(res, 200, hit.view);
        const view = harnessView(one, { days: Number(url.searchParams.get('days')) || 30 });
        harnessCache.set(k, { at: Date.now(), view });
        return json(res, 200, view);
      }
      // where the context goes in one repository (context-view.js:contextView, as `thinker context`), kept a minute like the harness
      if (req.method === 'GET' && url.pathname === '/api/context') {
        const d = Number(url.searchParams.get('days')) || 30, k = `context:${want}:${d}`, hit = harnessCache.get(k);
        if (hit && Date.now() - hit.at < 60_000) return json(res, 200, hit.view);
        let view;
        // every repository on the machine, merged (context-view.js:mergeViews); a repository that fails to read is left out
        if (want === 'all') view = mergeViews(repos().flatMap(r => { try { return [{ repo: r.id, name: r.name, view: contextView(open(r.checkout), { days: d }) }]; } catch { return []; } }));
        else { const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' }); view = contextView(one, { days: d }); }
        harnessCache.set(k, { at: Date.now(), view });
        return json(res, 200, view);
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
      if (url.pathname === '/api/activity/cancel') {
        const r0 = entry(String(b.repo || '')); if (!r0) return json(res, 400, { error: 'unknown repository' });
        const r = cancelActivity(path.join(r0.checkout, '.thinker'), Number(b.pid));
        return r.error ? json(res, 400, r) : json(res, 200, r);
      }
      const st = storeFor(String(b.repo || ''));
      if (!st) return json(res, 400, { error: 'unknown repository' });
      let r;
      if (url.pathname.startsWith('/api/harness/') || url.pathname.startsWith('/api/context/')) harnessCache.clear();
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
      // the page's door to `thinker harness --suggest` and `--undo`: the same functions, for the repository it shows
      else if (url.pathname === '/api/harness/suggest') { const picks = scheduleHarnessSuggestion(st, { force: true }); r = picks?.length ? { queued: picks.length } : { error: 'nothing here is worth switching off' }; }
      else if (url.pathname === '/api/harness/undo') r = { said: undoHarness(st, { names: Array.isArray(b.names) ? b.names : null }) };
      else if (url.pathname === '/api/harness/off') r = Array.isArray(b.labels) && b.labels.length ? { said: switchOffNow(st, b.labels.join(','), { via: 'ui', any: true }) } : { error: 'nothing chosen' };
      // `thinker instructions --core "<Title>, …"` (a list) and `--off` (null)
      else if (url.pathname === '/api/context/core') { const keep = Array.isArray(b.keep) ? b.keep.map(String).filter(Boolean) : null; const c = setCore(st, keep?.length ? keep : null); r = c.state === 'theirs' ? { error: 'AGENTS.override.md here is not thinker\'s; nothing written' } : { said: keep?.length ? `Kept ${c.kept?.length ?? keep.length} sections for this checkout` : 'Agents here read the whole file again' }; }
      // `thinker instructions --remove|--compress <id>` (the diff) and `--apply` (written to the working tree)
      else if (url.pathname === '/api/context/edit') { const x = await previewEdit(st, Array.isArray(b.ids) ? b.ids : String(b.id || ''), b.action === 'compress' ? 'compress' : 'remove'); if (x.error) r = x; else return json(res, 200, { ok: true, preview: x }); }
      else if (url.pathname === '/api/context/apply') r = applyEdit(st, String(b.id || ''));
      // `thinker context --switch-off <labels> [--builtin]` / `--switch-on <keys>` and `--output-compression <tools> --level`
      else if (url.pathname === '/api/context/switch') r = { said: switchSources(st, { labels: Array.isArray(b.labels) ? b.labels : [], keys: Array.isArray(b.keys) ? b.keys : [], on: !!b.on, builtin: !!b.builtin }) };
      else if (url.pathname === '/api/context/compression') r = { said: setOutputCompression(st, Array.isArray(b.tools) ? b.tools : [], ['high', 'moderate'].includes(b.level) ? b.level : 'off') };
      // `thinker context --judge n`, in the background: model calls, through the person's agent or the desktop session
      else if (url.pathname === '/api/context/judge') { const n = Math.min(20, Math.max(1, Number(b.n) || 5)); judgeRecent(st, { n }).then(x => { harnessCache.clear(); st.log({ op: 'instruction-value', via: 'ui', judged: x.judged }); }).catch(e => st.log({ op: 'instruction-value', via: 'ui', failed: String(e.message || e).slice(0, 160) })); r = { said: `Judging ${n} sessions in the background` }; }
      else if (url.pathname === '/api/harness/settings') { const v = k => typeof b[k] === 'boolean' ? b[k] : undefined; r = { said: JSON.stringify(setHarnessSettings(st, { recurring: v('recurring') ?? v('weekly'), recall: v('recall'), suggestions: v('suggestions') })) }; }
      else if (url.pathname === '/api/behaviors/edit') r = editBehavior(st, b.id, { title: b.title, body: b.body, mutability: b.mutability });
      else return json(res, 404, { error: 'not found' });
      if (r?.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, id: r?.note?.id, draft: r?.draft, queued: r?.queued, said: r?.said });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e).split('\n')[0].slice(0, 300) });
    }
  });
  return {
    server, token,
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
    idleMs: () => Date.now() - lastRequest,
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}
