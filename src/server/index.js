// The HTTP API of the central cache. JSON in and out, a bearer token on everything but /health.
//
//   GET    /health
//   GET    /v1/whoami
//   GET    /v1/repos                               admin   every repository and its state
//   PUT    /v1/repos/:repo            {clone?}     admin   register a repository (or set its clone url)
//   GET    /v1/repos/:repo                         read    state: head, notes, sessions, whether it distills
//   GET    /v1/repos/:repo/notes?since=N           read    notes changed since cursor N, and tombstones
//   GET    /v1/repos/:repo/notes/:id               read    one note
//   POST   /v1/repos/:repo/notes      {items}      write   push notes: [{op: put|del, base?, note}]
//   POST   /v1/repos/:repo/sessions/:session {client?, events}   write   stream a session's events
//   POST   /v1/repos/:repo/prs        {number, ...} write   a merged pull request to distill
//   POST   /v1/repos/:repo/fetch                   admin   fetch the checkout now
//   GET    /v1/tokens, POST /v1/tokens {name, repos?, scopes?}, DELETE /v1/tokens/:name   admin
//
// :repo is the repository id, github.com/owner/repo, URL-encoded as one segment.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repos, REPO_ID, SESSION_ID } from './repos.js';
import { Tokens, allows, bearer } from './auth.js';
import { Worker } from './worker.js';
import { nearDuplicate } from '../share.js';
import { provider } from '../llm.js';

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version; } catch { return '0'; } })();
const LIMITS = { notes: 8 << 20, sessions: 16 << 20, prs: 8 << 20, default: 1 << 20 };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, `body over ${limit} bytes`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

export function createServer({ data, adminToken, log = () => {}, worker: workerOpts = {}, startWorker = true } = {}) {
  fs.mkdirSync(data, { recursive: true });
  const repos = new Repos(data);
  const tokens = new Tokens(data, { adminToken });
  const worker = new Worker(repos, { log, ...workerOpts });
  if (startWorker) worker.start();
  const distills = repo => repo.isCloned() && worker.hasModel();

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' }); res.end(text); };
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, version: VERSION, repos: repos.list().length, model: worker.hasModel() ? (provider() || 'test') : null });
    if (parts[0] !== 'v1') throw new HttpError(404, 'not found');
    const who = tokens.identify(bearer(req));
    if (!who) throw new HttpError(401, 'a valid bearer token is required');
    const need = (scope, repoId) => { if (!allows(who, scope, repoId)) throw new HttpError(403, `token ${who.name} may not ${scope}${repoId ? ' ' + repoId : ''}`); };
    const [, kind, repoId, sub, subId] = parts;
    const by = who.name;

    if (kind === 'whoami' && req.method === 'GET') return send(200, { name: who.name, repos: who.repos, scopes: who.scopes });

    if (kind === 'tokens') {
      need('admin');
      if (req.method === 'GET' && !repoId) return send(200, { tokens: tokens.list() });
      if (req.method === 'POST' && !repoId) { const b = await readBody(req, LIMITS.default); try { return send(201, tokens.create({ name: b.name, repos: b.repos, scopes: b.scopes })); } catch (e) { throw new HttpError(400, e.message); } }
      if (req.method === 'DELETE' && repoId) return send(200, { revoked: tokens.revoke(repoId) });
      throw new HttpError(405, 'method not allowed');
    }

    if (kind !== 'repos') throw new HttpError(404, 'not found');
    if (!repoId) { if (req.method !== 'GET') throw new HttpError(405, 'method not allowed'); need('admin'); return send(200, { repos: repos.list().map(r => ({ ...r.status(), distills: distills(r) })) }); }
    if (!REPO_ID.test(repoId)) throw new HttpError(400, 'invalid repository id (github.com/owner/repo)');

    if (!sub && req.method === 'PUT') {
      need('admin');
      const b = await readBody(req, LIMITS.default);
      if (b.clone !== undefined && !/^(https?:\/\/|git@|file:\/\/|ssh:\/\/)\S+$/.test(String(b.clone))) throw new HttpError(400, 'clone: a git url');
      const repo = repos.get(repoId, { create: true, clone: b.clone });
      let fetched = null;
      if (b.fetch !== false) fetched = await worker.ensureCheckout(repo, { force: true });
      return send(200, { ...repo.status(), fetched, distills: distills(repo) });
    }
    const repo = repos.get(repoId);
    if (!repo) throw new HttpError(404, `unknown repository ${repoId}; an admin registers it with PUT /v1/repos/${encodeURIComponent(repoId)}`);

    if (!sub) { if (req.method !== 'GET') throw new HttpError(405, 'method not allowed'); need('read', repoId); return send(200, { ...repo.status(), distills: distills(repo) }); }

    if (sub === 'fetch' && req.method === 'POST') { need('admin'); const ok = await worker.ensureCheckout(repo, { force: true }); return send(200, { ...repo.status(), fetched: ok }); }

    if (sub === 'notes') {
      if (req.method === 'GET') {
        need('read', repoId);
        if (subId) { const n = repo.note(subId); if (!n) throw new HttpError(404, 'no such note'); return send(200, { note: n, seq: repo.meta().seq || 0 }); }
        const since = Number(url.searchParams.get('since')) || 0;
        return send(200, { ...repo.changes(since), distills: distills(repo) });
      }
      if (req.method === 'POST' && !subId) {
        need('write', repoId);
        const b = await readBody(req, LIMITS.notes);
        if (!Array.isArray(b.items)) throw new HttpError(400, 'items: a list of {op, base?, note}');
        if (b.items.length > 500) throw new HttpError(400, 'at most 500 items per request');
        const { result, seq } = await repo.locked(() => repo.upsert(b.items, { by, nearDuplicate }));
        return send(200, { results: result, seq });
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (sub === 'sessions' && subId && req.method === 'POST') {
      need('write', repoId);
      if (!SESSION_ID.test(subId)) throw new HttpError(400, 'invalid session id');
      const b = await readBody(req, LIMITS.sessions);
      if (!Array.isArray(b.events)) throw new HttpError(400, 'events: a list');
      const r = repo.appendSession(subId, b.events, { by, client: typeof b.client === 'string' ? b.client.slice(0, 40) : undefined });
      return send(200, { ...r, distills: distills(repo) });
    }

    if (sub === 'prs' && req.method === 'POST' && !subId) {
      need('write', repoId);
      const b = await readBody(req, LIMITS.prs);
      const number = Number(b.number);
      if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'number: the pull request number');
      if (typeof b.title !== 'string' || !b.title.trim()) throw new HttpError(400, 'title: required');
      if (typeof b.diff !== 'string' || !b.diff.trim()) throw new HttpError(400, 'diff: the unified diff of the pull request');
      const pr = { number, title: b.title.slice(0, 500), body: String(b.body || '').slice(0, 20000), mergedAt: String(b.mergedAt || new Date().toISOString()), mergeCommit: /^[a-f0-9]{7,64}$/.test(String(b.mergeCommit || '')) ? b.mergeCommit : null, additions: Number(b.additions) || 0, files: Array.isArray(b.files) ? b.files.filter(f => typeof f === 'string').slice(0, 500) : [], diff: b.diff.slice(0, 60000), comments: Array.isArray(b.comments) ? b.comments.filter(c => typeof c === 'string').slice(0, 12) : [], by };
      return send(202, { ...repo.queuePr(pr), distills: distills(repo) });
    }
    throw new HttpError(404, 'not found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('http', `${req.method} ${req.url}: ${e.stack || e.message}`);
      if (res.headersSent) { res.end(); return; }
      const text = JSON.stringify({ error: status === 500 ? 'internal error' : e.message });
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  server.requestTimeout = 120_000;
  server.repos = repos; server.tokens = tokens; server.worker = worker;
  const close = () => new Promise(resolve => { worker.stop(); server.close(() => resolve()); });
  return { server, repos, tokens, worker, close };
}

export function listen({ host = '127.0.0.1', port = 8787, ...opts }) {
  const s = createServer(opts);
  return new Promise((resolve, reject) => { s.server.once('error', reject); s.server.listen(port, host, () => resolve({ ...s, address: s.server.address() })); });
}
