#!/usr/bin/env node
// The evals app: every benchmark experiment under bench/runs, each compared cache off against cache
// on, per-PR history across experiments, live progress, and launching new experiments. Local only: it binds 127.0.0.1 and starts agent
// sessions, so it is never exposed.
//
//   PORT=$(~/.claude/bin/claude-port reserve thinker evals) npm run evals
//   node bench/evals/server.js [--port N] [--bench <dir with runs/ tasks/ repos/>] [--db <file>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { ingest, taskInfo } from './ingest.js';
import { armSummary, METRICS } from './stats.js';
import { readMeta, resolveMeta, writeMeta, compare } from './experiment.js';
import { catalog, plan, launch, launchCache, cancel, jobsView } from './jobs.js';
import { listPrsets, createPrset, readPrset, checkPrset } from './prsets.js';
import { listCaches, readReceipt, planCache, checkCache } from './caches.js';
import { archiveAll, readTranscript, stepStats } from './transcripts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BENCH = path.resolve(flag('bench', process.env.EVALS_BENCH || path.join(HERE, '..')));
const DB_FILE = path.resolve(flag('db', process.env.EVALS_DB || path.join(BENCH, 'evals', 'evals.db')));
const PORT = Number(flag('port', process.env.PORT));
const SCAN_MS = 15_000;

export function createApp({ bench = BENCH, dbFile = DB_FILE } = {}) {
  const db = openDb(dbFile);
  let lastScan = 0, scanning = false;
  // a result's own record, from its file (or its entry in summary.json)
  const rawOf = r => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(bench, 'runs', r.run, r.file), 'utf8'));
      return Array.isArray(j) ? j.find(x => `${r.run}/${x.id}` === r.id) || null : j;
    } catch { return null; }
  };
  // copy transcripts into the run folders in the background, before the agent CLIs clean them up
  const tried = new Set();
  let archiving = false, archiveStats = { archived: 0, missing: 0 };
  const archive = async () => {
    if (archiving) return; archiving = true;
    try {
      const r = await archiveAll(path.join(bench, 'runs'), db.all('SELECT id, run, file FROM results'), rawOf, { tried });
      archiveStats = { archived: archiveStats.archived + r.archived, missing: archiveStats.missing + r.missing };
    } catch (e) { console.error('transcript archive failed', e.message); } finally { archiving = false; }
  };
  const scan = (force = false) => { if (scanning) return; scanning = true; try { ingest(db, bench, { force }); lastScan = Date.now(); } finally { scanning = false; } archive(); };
  scan();
  const timer = setInterval(() => { try { scan(); } catch (e) { console.error('scan failed', e.message); } }, SCAN_MS);
  timer.unref();

  const rowsOf = (sql, ...p) => db.all(sql, ...p);
  const info = () => taskInfo(bench);
  const armsOf = dir => rowsOf('SELECT DISTINCT arm FROM results WHERE run = ?', dir).map(r => r.arm);
  // the comparison of one experiment, cached until its results or its definition change
  const cache = new Map();
  const experiment = (run, onOverride, tasks = info()) => {
    const stored = readMeta(bench, run.dir);
    const arms = (run.arms || '').split(',').filter(Boolean);
    const meta = resolveMeta(stored, arms);
    const on = onOverride && arms.includes(onOverride) && onOverride !== meta.off ? onOverride : meta.on;
    const key = `${run.dir}|${run.scanned_mtime}|${JSON.stringify(stored)}|${on}`;
    if (!cache.has(key)) {
      if (cache.size > 500) cache.clear();
      const rows = rowsOf('SELECT * FROM results WHERE run = ?', run.dir);
      cache.set(key, { meta: { ...meta, on, others: arms.filter(a => a !== meta.off && a !== on) }, rows, cmp: meta.off && on ? compare(rows, meta.off, on, tasks) : null });
    }
    return cache.get(key);
  };
  // a launched experiment is listed from its definition, before its first result lands
  const runs = () => rowsOf('SELECT * FROM runs ORDER BY coalesce(first_at, scanned_mtime) DESC').filter(r => r.results > 0 || readMeta(bench, r.dir));

  const api = {
    'GET /api/experiments': () => {
      const tasks = info();
      const list = runs().map(run => {
        const { meta, cmp } = experiment(run, null, tasks);
        return {
          dir: run.dir, repo: run.repo, runner: run.runner, models: run.models, first_at: run.first_at, last_at: run.last_at,
          results: run.results, invalid: run.invalid, meta,
          prs: cmp ? cmp.prs.length : new Set(rowsOf('SELECT DISTINCT task FROM results WHERE run = ?', run.dir).map(r => r.task)).size,
          cmp: cmp && { off: cmp.offSide, on: cmp.onSide, pairs: cmp.pairs, served: cmp.served, delta: cmp.delta, counts: cmp.counts, graders: cmp.graders },
        };
      });
      const totals = db.get(`SELECT count(*) results, sum(invalid IS NOT NULL) invalid, count(DISTINCT task) tasks FROM results`);
      return { experiments: list, totals, scanned_at: lastScan, bench, metrics: METRICS, transcripts: archiveStats };
    },
    'GET /api/experiment': q => {
      const run = db.get('SELECT * FROM runs WHERE dir = ?', q.get('dir'));
      if (!run) throw httpError(404, 'no such experiment');
      const { meta, rows, cmp } = experiment(run, q.get('on'));
      // every other arm against the cache-off arm, the cache-on arm first
      const all = meta.off ? [meta.on, ...meta.others].filter(Boolean).map(a => compare(rows, meta.off, a, info())) : [];
      return {
        run, meta, cmp, all, metrics: METRICS, arms: armSummary(rows),
        invalid: rows.filter(r => r.invalid).map(r => ({ id: r.id, task: r.task, arm: r.arm, rep: r.rep, reason: r.invalid })),
      };
    },
    'POST /api/experiment': body => {
      const dir = String(body.dir || '');
      if (!db.get('SELECT dir FROM runs WHERE dir = ?', dir)) throw httpError(404, 'no such experiment');
      return { meta: writeMeta(bench, dir, body, armsOf(dir)) };
    },
    'GET /api/result': q => {
      const r = db.get('SELECT * FROM results WHERE id = ?', q.get('id'));
      if (!r) throw httpError(404, 'no such result');
      return { row: r, raw: rawOf(r), task: info().get(r.task) || null };
    },
    // one session: its record, its transcript as steps, and the figures for the sidebar
    'GET /api/session': q => {
      const r = db.get('SELECT * FROM results WHERE id = ?', q.get('id'));
      if (!r) throw httpError(404, 'no such session');
      const raw = rawOf(r);
      const t = readTranscript(path.join(bench, 'runs'), r, raw);
      const meta = resolveMeta(readMeta(bench, r.run), armsOf(r.run));
      // the same PR and rep in the experiment's other arms, to step across
      const partners = db.all('SELECT id, arm, pass, in_tokens, tool_calls, invalid FROM results WHERE run = ? AND task = ? AND rep = ? AND id != ?', r.run, r.task, r.rep, r.id);
      const { diff, result, ...rest } = raw || {};
      return { row: r, raw: rest, diff: diff || null, result: result || null, task: info().get(r.task) || null, meta: { name: meta.name, off: meta.off, on: meta.on },
        transcript: t ? { format: t.format, archived: t.archived, bytes: t.bytes, steps: t.steps } : null, stats: t ? stepStats(t.steps) : null, partners };
    },
    'GET /api/prsets': () => ({ prsets: listPrsets(bench).map(s => ({ ...s, checks: checkPrset(bench, s) })) }),
    'POST /api/prsets': body => ({ prset: createPrset(bench, body) }),
    'GET /api/caches': () => {
      const prsets = listPrsets(bench);
      return { caches: listCaches(bench).map(c => ({ ...c, fits: prsets.filter(p => p.repo === c.repo).map(p => ({ prset: p.name, ok: checkCache(bench, c, p).every(x => x.ok) })) })) };
    },
    'GET /api/cache': q => {
      const c = readReceipt(bench, q.get('name'));
      if (!c) throw httpError(404, 'no such cache');
      const used = runs().filter(r => readMeta(bench, r.dir)?.modules?.cache?.name === c.name).map(r => r.dir);
      return { cache: c, checks: checkCache(bench, c), against: listPrsets(bench).filter(p => p.repo === c.repo).map(p => ({ prset: p.name, checks: checkCache(bench, c, p) })), used_by: used };
    },
    'POST /api/cache/plan': body => planCache(body, bench),
    'POST /api/cache/build': body => {
      if (body.confirm !== true) throw httpError(400, 'a cache build must be confirmed');
      const p = planCache(body, bench);
      return { id: launchCache(p, { benchDir: bench, db }), name: p.name };
    },
    // one PR across every experiment that ran it, cache off against cache on
    'GET /api/pr': q => {
      const id = q.get('id'), tasks = info();
      const exps = runs().filter(run => db.get('SELECT 1 FROM results WHERE run = ? AND task = ?', run.dir, id)).map(run => {
        const { meta, cmp } = experiment(run, null, tasks);
        return { dir: run.dir, models: run.models, first_at: run.first_at, meta, pr: cmp?.prs.find(p => p.task === id) || null };
      });
      return { task: id, info: tasks.get(id) || null, experiments: exps };
    },
    'GET /api/prs': () => {
      const tasks = info(), by = new Map();
      for (const run of runs()) {
        const { meta, cmp } = experiment(run, null, tasks);
        if (!cmp) continue;
        for (const p of cmp.prs) {
          const a = by.get(p.task) || { task: p.task, repo: tasks.get(p.task)?.repo || run.repo, title: p.title, pr: p.pr, experiments: 0, off: [0, 0], on: [0, 0], gained: 0, lost: 0, d_in: [] };
          a.experiments++; a.off[0] += p.off.passed; a.off[1] += p.off.graded; a.on[0] += p.on.passed; a.on[1] += p.on.graded;
          if (p.change === 'gained') a.gained++; if (p.change === 'lost') a.lost++;
          if (p.d_in_tokens != null && p.off.in_tokens) a.d_in.push(p.d_in_tokens / p.off.in_tokens);
          by.set(p.task, a);
        }
      }
      return { rows: [...by.values()].map(({ d_in, ...a }) => ({ ...a, d_in_share: d_in.length ? d_in.reduce((x, y) => x + y, 0) / d_in.length : null })) };
    },
    'GET /api/catalog': () => catalog(bench),
    'GET /api/jobs': () => ({ jobs: jobsView(db, bench) }),
    'POST /api/plan': body => plan(body, { benchDir: bench, db }),
    'POST /api/launch': body => {
      if (body.confirm !== true) throw httpError(400, 'a launch must be confirmed');
      const p = plan(body, { benchDir: bench, db });
      if (p.blocked) throw httpError(409, 'the plan fails its checks: ' + p.checks.filter(c => !c.ok).map(c => `${c.module}: ${c.check} (${c.detail})`).join('; '));
      if (!p.sessions) throw httpError(400, 'nothing to run: every result for this tag is already on disk');
      // the confirmed plan must be the one priced: refuse when the request changed underneath it
      if (body.sessions !== p.sessions) throw httpError(409, 'the plan changed since it was shown; review it again');
      const id = launch(p, { benchDir: bench, db });
      scan();
      return { id, tag: p.tag };
    },
    'POST /api/cancel': body => { cancel(db, Number(body.id)); return { ok: true }; },
    'POST /api/rescan': () => { scan(true); return { ok: true, scanned_at: lastScan }; },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const handler = api[`${req.method} ${url.pathname}`];
      // DNS rebinding: a page on another name resolving to 127.0.0.1 must not reach the API
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host || '')) throw httpError(403, 'unexpected Host');
      if (handler) {
        // a launch starts agent sessions: accept it only from this app's own page
        if (req.method === 'POST' && !sameOrigin(req)) throw httpError(403, 'cross-origin request refused');
        const body = req.method === 'POST' ? await readBody(req) : null;
        return send(res, 200, await handler(req.method === 'POST' ? body : url.searchParams));
      }
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, e.status || 500, { error: e.message }); }
  });
  return { server, db, close: () => { clearInterval(timer); server.close(); server.closeAllConnections(); db.raw.close(); } };
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return req.headers['content-type']?.startsWith('application/json');
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpError(400, 'body is not JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, p) {
  const pub = path.join(HERE, 'public');
  const file = path.normalize(path.join(pub, p === '/' ? 'index.html' : p));
  if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!PORT) { console.error('Set a port: PORT=$(~/.claude/bin/claude-port reserve thinker evals) npm run evals'); process.exit(2); }
  const { server } = createApp();
  server.listen(PORT, '127.0.0.1', () => console.log(`evals: http://127.0.0.1:${PORT}  (runs from ${path.join(BENCH, 'runs')}, index ${DB_FILE})`));
}
