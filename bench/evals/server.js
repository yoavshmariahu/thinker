#!/usr/bin/env node
// Artemis, the evals platform: every benchmark experiment, each compared cache off against cache
// on, per-PR history across experiments, live progress, and launching new experiments. Local only: it binds 127.0.0.1 and starts agent
// sessions, so it is never exposed.
//
//   artemis-up    (scripts/artemis-up; by hand: PORT=$(~/.claude/bin/claude-port reserve thinker artemis) npm run artemis)
//   node bench/evals/server.js [--port N] [--bench <dir with runs/ tasks/ repos/>] [--db <file>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB, env, lockServer } from './db.js';
import { takeSnapshot, listLocal, s3Uri } from './snapshot.js';
import { ingest, taskInfo } from './ingest.js';
import { armSummary, METRICS } from './stats.js';
import { readMeta, resolveMeta, writeMeta, compare } from './experiment.js';
import { catalog, plan, launch, launchCache, cancel, jobsView } from './jobs.js';
import { listPrsets, createPrset, updatePrset, freezePrset, readPrset, checkPrset } from './prsets.js';
import { importTaskFiles, importTaskSet, setAcceptance, getTaskSet, listTaskSets, taskSetVersions, tasksetName } from './tasksets.js';
const summary = s => ({ name: s.name, repo: s.repo, base: s.base, version: s.version, hash: s.hash, tasks: s.tasks.length, unchanged: Boolean(s.unchanged), change: s.change });
import { listCaches, readReceipt, planCache, checkCache } from './caches.js';
import { listArms, defineArm } from './arms.js';
import { archiveAll, readTranscript, stepStats } from './transcripts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BENCH = path.resolve(flag('bench', env('BENCH') || path.join(HERE, '..')));
const DB_FILE = path.resolve(flag('db', env('DB') || DEFAULT_DB));
const PORT = Number(flag('port', process.env.PORT));
const SCAN_MS = 15_000;

export function createApp({ bench = BENCH, dbFile = DB_FILE, snapshots = true } = {}) {
  const db = openDb(dbFile);
  let lastScan = 0, scanning = false;
  // a result's own record: kept in the database when it was imported
  const rawOf = r => db.record(r.id);
  // store transcripts in the database in the background, before the agent CLIs clean them up
  const tried = new Set();
  let archiving = false, archiveStats = { archived: 0, missing: 0, flagged: 0 };
  const archive = async () => {
    if (archiving) return; archiving = true;
    try {
      const r = await archiveAll(db, path.join(bench, 'runs'), { tried });
      archiveStats = { archived: archiveStats.archived + r.archived, missing: archiveStats.missing + r.missing, flagged: archiveStats.flagged + r.flagged };
    } catch (e) { console.error('transcript archive failed', e.message); } finally { archiving = false; }
  };
  const scan = (force = false) => { if (scanning) return; scanning = true; try { ingest(db, bench, { force }); lastScan = Date.now(); } finally { scanning = false; } archive(); };
  // task set files the database does not hold yet are imported once (tasksets.js); the database is read from then on
  { const t = importTaskFiles(bench, db); if (t.done.length) console.log(`imported task sets: ${t.done.join(', ')}`); for (const f of t.failed) console.error(`task set not imported: ${f}`); }
  scan();
  const timer = setInterval(() => { try { scan(); } catch (e) { console.error('scan failed', e.message); } }, SCAN_MS);
  timer.unref();
  // a recoverable snapshot a day (snapshot.js), taken while the app runs; none for an in-memory database
  let lastSnapshot = null;
  const snapshotDue = () => {
    if (dbFile === ':memory:' || !snapshots) return;
    const newest = listLocal()[0];
    if (newest && Date.now() - newest.at < 24 * 3600e3) return;
    try { lastSnapshot = takeSnapshot(dbFile); console.log(`snapshot ${lastSnapshot.file}${lastSnapshot.uploaded ? ' → ' + lastSnapshot.uploaded : ''}`); }
    catch (e) { lastSnapshot = { error: e.message, at: Date.now() }; console.error('snapshot failed', e.message); }
  };
  const snapTimer = setInterval(snapshotDue, 3600e3); snapTimer.unref();
  setTimeout(snapshotDue, 5000).unref();

  const rowsOf = (sql, ...p) => db.all(sql, ...p);
  const info = () => taskInfo(bench, db);
  const armsOf = dir => rowsOf('SELECT DISTINCT arm FROM results WHERE run = ?', dir).map(r => r.arm);
  // the comparison of one experiment, cached until its results or its definition change
  const cache = new Map();
  const experiment = (run, onOverride, tasks = info()) => {
    const stored = readMeta(db, run.dir);
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
  const runs = () => rowsOf('SELECT * FROM runs ORDER BY coalesce(first_at, scanned_mtime) DESC').filter(r => r.results > 0 || readMeta(db, r.dir));

  // each experiment's and cache's job: the running one, else the latest — the entity shows its own progress
  const jobsByTag = kind => {
    const m = new Map();
    for (const j of jobsView(db, bench)) {
      if ((j.kind || 'experiment') !== kind) continue;
      const prev = m.get(j.tag);
      if (!prev || (j.status === 'running' && prev.status !== 'running') || (prev.status !== 'running' && j.started_at > prev.started_at)) m.set(j.tag, j);
    }
    return m;
  };

  const api = {
    'GET /api/experiments': () => {
      const tasks = info();
      const jobs = jobsByTag('experiment');
      const list = runs().map(run => {
        const { meta, cmp } = experiment(run, null, tasks);
        return {
          dir: run.dir, repo: run.repo, runner: run.runner, models: run.models, first_at: run.first_at, last_at: run.last_at,
          results: run.results, invalid: run.invalid, meta,
          prs: cmp ? cmp.prs.length : new Set(rowsOf('SELECT DISTINCT task FROM results WHERE run = ?', run.dir).map(r => r.task)).size,
          cmp: cmp && { off: cmp.offSide, on: cmp.onSide, pairs: cmp.pairs, served: cmp.served, delta: cmp.delta, counts: cmp.counts, graders: cmp.graders },
          job: jobs.get(run.dir) || null,
        };
      });
      const totals = db.get(`SELECT count(*) results, sum(invalid IS NOT NULL) invalid, count(DISTINCT task) tasks FROM results`);
      return { experiments: list, totals, scanned_at: lastScan, bench, metrics: METRICS, transcripts: archiveStats,
        store: { db: dbFile, snapshot: listLocal()[0] || null, last: lastSnapshot, s3: s3Uri() } };
    },
    'GET /api/experiment': q => {
      const run = db.get('SELECT * FROM runs WHERE dir = ?', q.get('dir'));
      if (!run && readReceipt(db, q.get('dir'))) throw Object.assign(httpError(404, 'that is a cache, not an experiment'), { redirect: `#/cache/${encodeURIComponent(q.get('dir'))}` });
      if (!run) throw httpError(404, 'no such experiment');
      const { meta, rows, cmp } = experiment(run, q.get('on'));
      // every other arm against the cache-off arm, the cache-on arm first
      const all = meta.off ? [meta.on, ...meta.others].filter(Boolean).map(a => compare(rows, meta.off, a, info())) : [];
      return {
        run, meta, cmp, all, metrics: METRICS, arms: armSummary(rows), job: jobsByTag('experiment').get(run.dir) || null,
        invalid: rows.filter(r => r.invalid).map(r => ({ id: r.id, task: r.task, arm: r.arm, rep: r.rep, reason: r.invalid })),
      };
    },
    'POST /api/experiment': body => {
      const dir = String(body.dir || '');
      if (!db.get('SELECT dir FROM runs WHERE dir = ?', dir)) throw httpError(404, 'no such experiment');
      return { meta: writeMeta(db, dir, body, armsOf(dir)) };
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
      const t = readTranscript(db, path.join(bench, 'runs'), r, raw);
      const meta = resolveMeta(readMeta(db, r.run), armsOf(r.run));
      // the same PR and rep in the experiment's other arms, to step across
      const partners = db.all('SELECT id, arm, pass, in_tokens, tool_calls, invalid FROM results WHERE run = ? AND task = ? AND rep = ? AND id != ?', r.run, r.task, r.rep, r.id);
      const { diff, result, ...rest } = raw || {};
      return { row: r, raw: rest, diff: diff || null, result: result || null, task: info().get(r.task) || null, meta: { name: meta.name, off: meta.off, on: meta.on },
        transcript: t ? { format: t.format, archived: t.archived, bytes: t.bytes, steps: t.steps, flags: t.flags } : null, stats: t ? stepStats(t.steps) : null, partners };
    },
    // one PR set: its PRs as the task set version it froze has them, and how often each has run
    'GET /api/prset': q => {
      const p = readPrset(db, q.get('name'));
      if (!p) throw httpError(404, 'no such PR set');
      const ts = getTaskSet(db, p.tasks, { hash: p.taskset_hash || null }) || (!p.taskset_hash ? getTaskSet(db, p.tasks) : null);
      const runs = new Map(db.all('SELECT task, count(DISTINCT run) n FROM results WHERE invalid IS NULL GROUP BY task').map(r => [r.task, r.n]));
      const used = db.all('SELECT dir, definition FROM runs WHERE definition IS NOT NULL').filter(r => { try { return JSON.parse(r.definition)?.modules?.prset?.name === p.name; } catch { return false; } }).map(r => r.dir);
      const prs = p.prs.map(x => { const t = ts?.tasks.find(y => y.id === x.id);
        return { ...x, title: x.title || t?.goldTitle || null, tests: Boolean(t?.testCmd), acceptance: (t?.acceptance || []).length, gold_diff_bytes: t?.goldDiffText?.length ?? null, in_taskset: Boolean(t), experiments: runs.get(x.id) || 0 }; });
      return { prset: { ...p, prs }, checks: checkPrset(bench, p, db), taskset: ts && { name: ts.name, version: ts.version, hash: ts.hash, from: ts.from }, used_by: used };
    },
    'GET /api/prsets': () => ({ prsets: listPrsets(db).map(s => ({ ...s, checks: checkPrset(bench, s, db) })) }),
    'POST /api/prsets': body => ({ prset: createPrset(bench, db, body) }),
    'POST /api/prsets/update': body => ({ prset: updatePrset(bench, db, String(body.name || ''), body) }),
    'POST /api/prsets/freeze': body => ({ prset: freezePrset(bench, db, String(body.name || '')) }),
    'GET /api/caches': () => {
      const prsets = listPrsets(db);
      const jobs = jobsByTag('cache');
      return { caches: listCaches(db).map(c => ({ ...c, job: jobs.get(c.name) || null, fits: prsets.filter(p => p.repo === c.repo).map(p => ({ prset: p.name, ok: checkCache(bench, c, p).every(x => x.ok) })) })) };
    },
    'GET /api/cache': q => {
      const c = readReceipt(db, q.get('name'));
      if (!c) throw httpError(404, 'no such cache');
      const used = runs().filter(r => readMeta(db, r.dir)?.modules?.cache?.name === c.name).map(r => r.dir);
      return { cache: c, job: jobsByTag('cache').get(c.name) || null, checks: checkCache(bench, c), against: listPrsets(db).filter(p => p.repo === c.repo).map(p => ({ prset: p.name, checks: checkCache(bench, c, p) })), used_by: used };
    },
    'POST /api/cache/plan': body => planCache(body, bench, db),
    'POST /api/cache/build': body => {
      if (body.confirm !== true) throw httpError(400, 'a cache build must be confirmed');
      const p = planCache(body, bench, db);
      return { id: launchCache(p, { benchDir: bench, db }), name: p.name };
    },
    // one PR across every experiment that ran it, cache off against cache on
    'GET /api/pr': q => {
      const id = q.get('id'), tasks = info();
      const exps = runs().filter(run => db.get('SELECT 1 FROM results WHERE run = ? AND task = ?', run.dir, id)).map(run => {
        const { meta, cmp } = experiment(run, null, tasks);
        return { dir: run.dir, models: run.models, first_at: run.first_at, meta, pr: cmp?.prs.find(p => p.task === id) || null };
      });
      // the task itself, as each task set that holds it has it now (the request, how it is graded, its criteria)
      const holders = listTaskSets(db).filter(ts => ts.tasks.some(t => t.id === id));
      const t = holders[0]?.tasks.find(x => x.id === id) || null;
      const task = t && { request: String(t.prompt || '').replace(/^Implement the following change[^\n]*\n\n/, ''), testCmd: t.testCmd || null, testFiles: t.testFiles || [], area: t.area || null,
        mergeCommit: t.mergeCommit || null, mergedAt: t.mergedAt || null, acceptance: t.acceptance || [], gold_diff_bytes: t.goldDiffText?.length ?? null,
        tasksets: holders.map(ts => ({ name: ts.name, version: ts.version })), prsets: listPrsets(db).filter(p => (p.ids || []).includes(id)).map(p => p.name) };
      return { task: id, info: tasks.get(id) || null, spec: task, experiments: exps };
    },
    // every PR Artemis holds: each task of each task set, with the experiments that ran it (none yet is a row too)
    'GET /api/prs': () => {
      const tasks = info(), by = new Map();
      const sets = listTaskSets(db), inPrsets = new Map();
      for (const p of listPrsets(db)) for (const id of p.ids || []) inPrsets.set(id, [...(inPrsets.get(id) || []), p.name]);
      for (const ts of sets) for (const t of ts.tasks) {
        const a = by.get(t.id) || { task: t.id, repo: ts.repo, title: tasks.get(t.id)?.title || t.goldTitle || null, pr: String(t.id).match(/^PR(\d+)/)?.[1] || null, experiments: 0, off: [0, 0], on: [0, 0], gained: 0, lost: 0, d_in: [], tasksets: [], prsets: inPrsets.get(t.id) || [] };
        a.tasksets.push(ts.name); by.set(t.id, a);
      }
      for (const run of runs()) {
        const { meta, cmp } = experiment(run, null, tasks);
        if (!cmp) continue;
        for (const p of cmp.prs) {
          const a = by.get(p.task) || { task: p.task, repo: tasks.get(p.task)?.repo || run.repo, title: p.title, pr: p.pr, experiments: 0, off: [0, 0], on: [0, 0], gained: 0, lost: 0, d_in: [], tasksets: [], prsets: inPrsets.get(p.task) || [] };
          a.experiments++; a.off[0] += p.off.passed; a.off[1] += p.off.graded; a.on[0] += p.on.passed; a.on[1] += p.on.graded;
          if (p.change === 'gained') a.gained++; if (p.change === 'lost') a.lost++;
          if (p.d_in_tokens != null && p.off.in_tokens) a.d_in.push(p.d_in_tokens / p.off.in_tokens);
          by.set(p.task, a);
        }
      }
      return { rows: [...by.values()].map(({ d_in, ...a }) => ({ ...a, d_in_share: d_in.length ? d_in.reduce((x, y) => x + y, 0) / d_in.length : null })) };
    },
    'GET /api/arms': () => ({ arms: listArms(db) }),
    'POST /api/arms': body => ({ arm: defineArm(db, body) }),
    'GET /api/catalog': () => catalog(bench, db),
    // task sets (tasksets.js): imported from a file or a git ref, versioned; acceptance criteria per task
    'GET /api/tasksets': () => ({ tasksets: listTaskSets(db).map(s => ({ name: s.name, repo: s.repo, base: s.base, version: s.version, hash: s.hash, from: s.from, change: s.change, tasks: s.tasks.length,
      with_acceptance: s.tasks.filter(t => t.acceptance?.length).length, prsets: listPrsets(db).filter(p => tasksetName(p.tasks) === s.name).map(p => p.name) })) }),
    'GET /api/taskset': q => {
      const s = getTaskSet(db, q.get('name'), { version: q.get('version') || null });
      if (!s) throw httpError(404, 'no such task set');
      return { taskset: { ...s, tasks: s.tasks.map(({ goldDiffText, ...t }) => ({ ...t, gold_diff_bytes: goldDiffText?.length ?? null })) }, versions: taskSetVersions(db, s.name) };
    },
    'POST /api/tasksets/import': body => ({ taskset: summary(importTaskSet(bench, db, { name: body.name, file: body.file, ref: body.ref, repo: body.repo })) }),
    'POST /api/taskset/acceptance': body => ({ taskset: summary(setAcceptance(db, String(body.name || ''), String(body.task || ''), body.acceptance)) }),
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
    // re-import one run's files over its sessions in the database (after a regrade rewrote them)
    'POST /api/reimport': body => { const dir = String(body.dir || ''); if (!db.get('SELECT 1 FROM runs WHERE dir = ?', dir)) throw httpError(404, 'no such experiment'); return { changed: ingest(db, bench, { force: true, only: dir }) }; },
    'POST /api/snapshot': () => { lastSnapshot = takeSnapshot(dbFile); return lastSnapshot; },
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
    } catch (e) { send(res, e.status || 500, { error: e.message, ...(e.redirect ? { redirect: e.redirect } : {}) }); }
  });
  return { server, db, close: () => { clearInterval(timer); clearInterval(snapTimer); server.close(); server.closeAllConnections(); db.raw.close(); } };
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

// the page's own version: a page loaded before the app was updated sees a different one and offers a reload
const VERSION = String(Math.max(...fs.readdirSync(path.join(HERE, 'public')).map(f => fs.statSync(path.join(HERE, 'public', f)).mtimeMs)) | 0);
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-evals-version': VERSION });
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
  if (!PORT) { console.error('Set a port: artemis-up, or PORT=$(~/.claude/bin/claude-port reserve thinker artemis) npm run artemis'); process.exit(2); }
  // one Artemis per database, however it was started (artemis-up, npm run artemis, an agent)
  const { held } = lockServer(PORT, DB_FILE);
  if (held) { console.error(`Artemis is already running on this database: http://127.0.0.1:${held.port} (pid ${held.pid}). Not starting a second one.`); process.exit(1); }
  const { server } = createApp();
  server.on('error', e => { console.error(`Artemis could not listen on ${PORT}: ${e.message}`); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => console.log(`Artemis: http://127.0.0.1:${PORT}  (database ${DB_FILE}; runner hand-off ${path.join(BENCH, 'runs')})`));
}
