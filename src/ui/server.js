// `thinker ui`: a local page for the person, on this machine only. Three views: how the cache has been
// used (usage.js:summarize, in tokens, never dollars), the notes in the cache, which can be archived or
// restored (ops.js:archiveNotes), and the desired behaviors of the system, where the ones waiting for
// a decision can be accepted, edited or discarded (behavior-workbench.js).
//
// Every view is for one repository, picked at the top of the page (`?repo=` its id, as the log names
// it), or for all of them (`?repo=all`): the repositories are the ones in the machine's log with a
// checkout still set up, and only those can be named, so the page cannot be pointed at a path.
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
import { summarize, readLog } from '../usage.js';
import { Store, repoId, isScratchCheckout } from '../store.js';
import { execFileSync } from 'node:child_process';
import { refresh, archiveNotes } from '../ops.js';
import { isBehavior } from '../behavior.js';
import { pendingBehaviors, activeBehaviors, acceptPending, discardPending, editBehavior } from '../behavior-workbench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4848;

// Only what the page shows: counts and tokens. The provider-reported cost stays out (no dollars).
export function usageView(store, { days, scope = 'here' } = {}) {
  const u = summarize(store, { days, all: scope !== 'here' });
  const tok = o => o ? { calls: o.calls || 0, tokens: o.totalTokens || 0, failed: o.failed || 0 } : { calls: 0, tokens: 0, failed: 0 };
  return {
    scope: u.scope, from: u.from, to: u.to, days: days || null,
    requests: u.requests || 0, answered: u.answered || 0, sessions: u.sessions || 0,
    servings: u.servings || {}, notesServed: u.notesServed || 0, notesInCache: store.list().filter(n => n.status !== 'invalid').length,
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
      status: n.status === 'invalid' ? 'retired' : n.archived ? 'archived' : n.status === 'stale' ? 'stale' : 'fresh',
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

// The repositories the page can show: this one, and every origin in the machine's log with a checkout
// that is still set up (a .thinker folder), scratch checkouts aside. A repository with several
// checkouts (clones, worktrees) is read from this one if it is among them, else the one holding the
// most notes.
export function machineRepos(store) {
  const here = repoId(store.repo), byOrigin = new Map([[here, new Set([store.repo])]]);
  let events = []; try { events = readLog(store, { all: true }); } catch {}
  const seen = new Set([store.repo]);
  for (const e of events) {
    if (!e.repo || !path.isAbsolute(e.repo) || seen.has(e.repo)) continue;
    seen.add(e.repo);
    // a git checkout that was set up (not the home folder, whose .thinker is the app's own)
    if (isScratchCheckout(e.repo) || !fs.existsSync(path.join(e.repo, '.git')) || !fs.existsSync(path.join(e.repo, '.thinker'))) continue;
    const origin = repoId(e.repo); // as it is now: the line may predate the origin, and a worktree shares it
    if (!byOrigin.has(origin)) byOrigin.set(origin, new Set());
    byOrigin.get(origin).add(e.repo);
  }
  const count = c => { try { return new Store(c, { readonly: true }).list().length; } catch { return -1; } };
  const out = [];
  for (const [id, checkouts] of byOrigin) {
    const scored = [...checkouts].map(c => [c, c === store.repo ? Infinity : count(c)]).filter(([, n]) => n >= 0).sort((a, b) => b[1] - a[1]);
    if (!scored.length) continue;
    const checkout = scored[0][0];
    out.push({ id, name: /^[^/]+\.[a-z]+\/[^/]/.test(id) ? String(id).replace(/^[^/]+\.[a-z]+\//, '') : path.basename(checkout), checkout, current: id === here });
  }
  return out.sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
}

// The repository as people name it: owner/name from its origin, else the checkout's folder.
function repoName(repo) {
  try {
    const u = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(u);
    if (m) return m[1];
  } catch {}
  return path.basename(repo);
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

export function createUiServer(store, { token = crypto.randomBytes(16).toString('hex') } = {}) {
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
  let port = 0, known = null, lastRequest = Date.now();
  const repos = () => known ||= machineRepos(store);
  const opened = new Map([[store.repo, store]]);
  const open = checkout => { if (!opened.has(checkout)) opened.set(checkout, new Store(checkout)); return opened.get(checkout); };
  // '' is this repository; an id must be one machineRepos listed
  const entry = id => !id ? repos().find(r => r.current) || { id: repoId(store.repo), name: repoName(store.repo), checkout: store.repo, current: true } : repos().find(r => r.id === id);
  const storeFor = id => { const r = id === 'all' ? null : entry(id); return r ? open(r.checkout) : null; };
  const storesFor = id => {
    if (id === 'all') return repos().flatMap(r => { try { return [[r, open(r.checkout)]]; } catch { return []; } });
    const r = entry(id); return r ? [[r, open(r.checkout)]] : null;
  };
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
      if (req.method === 'GET' && url.pathname === '/api/repos') { known = machineRepos(store); return json(res, 200, { repos: known }); }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const days = Number(url.searchParams.get('days')) || undefined;
        if (want === 'all') return json(res, 200, usageView(store, { days, scope: 'all' }));
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
      const st = storeFor(String(b.repo || ''));
      if (!st) return json(res, 400, { error: 'unknown repository' });
      let r;
      if (url.pathname === '/api/behaviors/accept') r = acceptPending(st, b.id, { mutability: b.mutability || 'mutable', edit: b.title || b.body ? { title: b.title, body: b.body } : null });
      else if (url.pathname === '/api/behaviors/discard') r = discardPending(st, b.id);
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
    close: () => new Promise(r => server.close(r)),
    idleMs: () => Date.now() - lastRequest,
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}
