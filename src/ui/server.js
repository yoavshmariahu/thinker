// `thinker ui`: a local page for the person, on this machine only. Two views: how the cache has been
// used (usage.js:summarize, in tokens, never dollars) and the desired behaviors of the system, where
// the ones waiting for a decision can be accepted, edited or discarded (behavior-workbench.js).
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
import { behaviorSessionPrompt } from '../setup/define.js';
import { execFileSync } from 'node:child_process';
import { pendingBehaviors, activeBehaviors, acceptPending, discardPending, editBehavior, draftFromDescription, acceptDraft } from '../behavior-workbench.js';

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

export function createUiServer(store, { token = crypto.randomBytes(16).toString('hex'), model, draftFn = draftFromDescription } = {}) {
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
  let port = 0;
  const server = http.createServer(async (req, res) => {
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
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const days = Number(url.searchParams.get('days')) || undefined;
        return json(res, 200, usageView(store, { days, scope: url.searchParams.get('scope') || 'here' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/behaviors') {
        return json(res, 200, { repo: repoName(store.repo), active: activeBehaviors(store), pending: pendingBehaviors(store) });
      }
      if (req.method === 'GET' && url.pathname === '/api/behaviors/session-prompt') return json(res, 200, { prompt: behaviorSessionPrompt(store) });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const b = await readBody(req);
      let r;
      if (url.pathname === '/api/behaviors/accept') r = acceptPending(store, b.id, { mutability: b.mutability || 'mutable', edit: b.title || b.body ? { title: b.title, body: b.body } : null });
      else if (url.pathname === '/api/behaviors/discard') r = discardPending(store, b.id);
      else if (url.pathname === '/api/behaviors/edit') r = editBehavior(store, b.id, { title: b.title, body: b.body, mutability: b.mutability });
      else if (url.pathname === '/api/behaviors/describe') r = { draft: await draftFn(store, String(b.text || ''), { model }) };
      else if (url.pathname === '/api/behaviors/create') r = acceptDraft(store, { title: b.title, body: b.body, deps: b.deps || [], answers: [] }, { mutability: b.mutability || 'mutable' });
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
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}
