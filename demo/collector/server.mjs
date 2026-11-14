// The demo collector: a sink for thinker's session events, a SQLite database, and the fleet page over it.
//
// What it is for. thinker ships one event per session (`src/events.js`), priced on the machine by the one
// door the Report and `thinker prs` read. This is the smallest honest thing that receives them: an HTTP
// endpoint, a table, and a page that is one row a machine -- which is how a company running thinker inside
// its own coding agent sees per-machine figures it could not see before.
//
// Three rules it is built on, each one a mistake already made in this project's own dashboards:
//
//  1. **An event is an upsert, never an addition.** A session's clearing figure settles a few turns after
//     the cut, so the same session arrives again carrying more. The primary key is (install, session) and a
//     later event replaces an earlier one; adding two would double a session's saving.
//  2. **A rate is a ratio of sums.** Every figure on the page divides one sum by another. A mean of
//     per-session rates reads a three-prompt session like a forty-prompt one -- on the machine this project
//     was built for, $13.93 against the true $5.97.
//  3. **No dollar is computed here.** `prices.js` on the machine is the only door for turning tokens into
//     money. This file sums dollars that arrived and divides them by counts; it never multiplies a token by
//     a rate, and a session whose model had no list price is counted as a session and in no dollar figure.
//
// Needs Node 22.5+ for `node:sqlite`. Demo tooling: it is not part of the installed tool and ships in no
// release (`scripts/pack.sh` carries `src/` alone).
//
//   node demo/collector/server.mjs --port 8787 --db /tmp/fleet.db
//   curl -X POST --data-binary @events.jsonl http://127.0.0.1:8787/v1/sessions
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MANAGED, sanitize } from '../../src/managed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const PORT = Number(arg('port', process.env.PORT || 8787));
const DB_PATH = arg('db', process.env.FLEET_DB || path.join(HERE, 'fleet.db'));
const MAX_BODY = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Store

export function openDb(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    create table if not exists sessions (
      install       text not null,
      session       text not null,
      at            text not null,
      first_at      text,
      last_at       text,
      client        text,
      model         text,
      policy        text,
      version       text,
      prompts       integer not null default 0,
      tokens        integer,
      cleared       integer not null default 0,
      reread_reads  integer not null default 0,
      reread_tokens integer not null default 0,
      saved         real not null default 0,
      rewrite       real not null default 0,
      reread        real not null default 0,
      net           real not null default 0,
      spend         real,
      priced        integer not null default 0,
      cuts          integer not null default 0,
      calls_cleared integer not null default 0,
      results       integer not null default 0,
      decisions     text not null default '{}',
      raw           text not null,
      primary key (install, session)
    );
    create index if not exists sessions_at on sessions (at);

    -- One policy for the fleet, not one per machine: id is pinned to 1. What an operator sets here is what
    -- every machine reporting in is told, and "at" is the only ordering there is -- newest wins, the same
    -- rule a session event is taken by.
    create table if not exists settings (
      id     integer primary key check (id = 1),
      config text not null default '{}',
      at     text,
      by     text
    );

    -- What each machine says it is actually running, off its own event. Nothing here is set by anybody;
    -- it is the fleet's answer to "did it take", a machine at a time.
    create table if not exists installs (
      install text primary key,
      values_ text not null default '{}',
      at      text
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Control: one set of settings, for the whole fleet.
//
// Not per machine. A fleet is run to one policy -- when to cut, whether to delegate -- and a page offering
// that policy once is a page an operator can read; eleven controls a machine, times a fleet, is a surface
// nobody audits. A machine's own page says what it is running, which is the only per-machine question.
//
// The description of what may be set is thinker's own (src/managed.js), not a copy here: the page offers
// exactly the settings a machine will honour, each coerced by the same function the machine coerces it with,
// so a control that does nothing cannot be drawn.

// The control surface as the page receives it: everything but the coercion function itself, which is the
// machine's business. Drawn once -- the page's form and thinker's allow-list are one list, not two.
const SCHEMA = MANAGED.map(({ path: p, type, label, unit, help, min, max, step, dflt }) =>
  ({ path: p, type, label, unit, help, min, max, step, dflt }));

export function getSettings(db) {
  const row = db.prepare('select config, at, by from settings where id = 1').get();
  if (!row) return { config: {}, at: null, by: null };
  let config = {}; try { config = JSON.parse(row.config) || {}; } catch { config = {}; }
  return { config, at: row.at ?? null, by: row.by ?? null };
}

// Set the fleet's settings. Only the settings an operator has actually moved are stored, so a page nobody
// has touched pushes nothing: a machine's own configuration stands until somebody decides otherwise, and
// opening this page does not quietly adopt four defaults on everyone's behalf.
export function setSettings(db, raw, { by = 'dashboard', now = new Date() } = {}) {
  const { config, dropped } = sanitize(raw);
  const current = getSettings(db);
  // Nothing changed is not a new time: a machine must not be told to take again what it is already running.
  if (JSON.stringify(config) === JSON.stringify(current.config)) return { ...current, dropped, changed: false };
  const at = now.toISOString();
  db.prepare(`insert into settings (id, config, at, by) values (1,?,?,?)
    on conflict(id) do update set config = excluded.config, at = excluded.at, by = excluded.by`)
    .run(JSON.stringify(config), at, by);
  return { ...getSettings(db), dropped, changed: true };
}

// What each machine says it is running. `pending` is the settings set here that this machine's own last word
// disagrees with -- the honest answer to "did it take", since only the machine can say so.
export function running(db, install) {
  const row = db.prepare('select values_, at from installs where install = ?').get(install);
  let values = {}; try { values = JSON.parse(row?.values_ || '{}') || {}; } catch { values = {}; }
  const wanted = getSettings(db).config;
  const pending = MANAGED
    .map(m => m.path)
    .filter(p => {
      const want = p.split('.').reduce((v, k) => (v == null ? v : v[k]), wanted);
      return want !== undefined && want !== null && values[p] !== want;
    });
  return { values, at: row?.at ?? null, pending };
}

// What every machine is running, for the settings page: how many agree with what is set here, and how many
// have not reported since. One line, because the question is only ever "has the fleet taken it".
export function fleetRunning(db) {
  const rows = db.prepare('select install from installs').all();
  const out = { machines: rows.length, pending: 0 };
  for (const r of rows) if (running(db, r.install).pending.length) out.pending++;
  return out;
}

// What a machine said it was running, taken off its own event.
function noteSeen(db, install, values, at) {
  if (!values || typeof values !== 'object') return;
  db.prepare(`insert into installs (install, values_, at) values (?,?,?)
    on conflict(install) do update set values_ = excluded.values_, at = excluded.at`)
    .run(install, JSON.stringify(values), at || new Date().toISOString());
}

const num = v => (Number.isFinite(v) ? v : null);
const int = v => (Number.isFinite(v) ? Math.round(v) : 0);

// One event in. Returns 'inserted' | 'updated' | 'stale' | 'rejected'.
export function putEvent(db, ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.install !== 'string' || typeof ev.session !== 'string') return 'rejected';
  if (typeof ev.at !== 'string' || Number.isNaN(Date.parse(ev.at))) return 'rejected';
  const cost = ev.cost || {};
  const d = ev.decisions && typeof ev.decisions === 'object' ? ev.decisions : {};
  // The upsert's `where` is rule 1: an event older than the one already stored is dropped, so events that
  // arrive out of order (a spool draining behind a live session) cannot walk a figure backwards.
  const stmt = db.prepare(`
    insert into sessions (install, session, at, first_at, last_at, client, model, policy, version, prompts, tokens,
      cleared, reread_reads, reread_tokens, saved, rewrite, reread, net, spend, priced,
      cuts, calls_cleared, results, decisions, raw)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(install, session) do update set
      at = excluded.at, first_at = excluded.first_at, last_at = excluded.last_at,
      client = excluded.client, model = excluded.model, policy = excluded.policy, version = excluded.version,
      prompts = excluded.prompts, tokens = excluded.tokens, cleared = excluded.cleared,
      reread_reads = excluded.reread_reads, reread_tokens = excluded.reread_tokens,
      saved = excluded.saved, rewrite = excluded.rewrite, reread = excluded.reread, net = excluded.net,
      spend = excluded.spend, priced = excluded.priced,
      cuts = excluded.cuts, calls_cleared = excluded.calls_cleared, results = excluded.results,
      decisions = excluded.decisions, raw = excluded.raw
    where excluded.at >= sessions.at
  `);
  const before = db.prepare('select at from sessions where install = ? and session = ?').get(ev.install, ev.session);
  stmt.run(ev.install, ev.session, ev.at, ev.firstAt ?? null, ev.lastAt ?? null,
    ev.client ?? null, ev.model ?? null, ev.policy ?? null, ev.version ?? null, int(ev.prompts), num(ev.tokens),
    int(ev.cleared), int(ev.rereads?.reads), int(ev.rereads?.tokens),
    cost.saved ?? 0, cost.rewrite ?? 0, cost.reread ?? 0, cost.net ?? 0,
    num(cost.spend), cost.priced ? 1 : 0,
    int(d.cuts), int(d.callsCleared), int(d.results), JSON.stringify(d), JSON.stringify(ev));
  if (ev.managed?.values) noteSeen(db, ev.install, ev.managed.values, ev.at);
  if (!before) return 'inserted';
  return ev.at >= before.at ? 'updated' : 'stale';
}

const GROUPS = { client: 'client', model: 'model', install: 'install', policy: 'policy' };

// The fleet, grouped by one of the session's own columns above. Every rate is taken here from the sums,
// never from a row's own rate.
export function fleet(db, { by = 'client', days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const dim = `coalesce(nullif(${GROUPS[by] || GROUPS.client}, ''), '(none)')`;
  const params = [since];
  const sql = `
    select ${dim} as dim,
      count(*)                                            as sessions,
      count(distinct install)                             as installs,
      sum(prompts)                                        as prompts,
      sum(coalesce(tokens, 0))                            as tokens,
      sum(cleared)                                        as cleared,
      sum(case when cleared > 0 then 1 else 0 end)        as clearedSessions,
      sum(reread_reads)                                   as rereads,
      sum(cuts)                                           as cuts,
      sum(calls_cleared)                                  as callsCleared,
      sum(results)                                        as results,
      sum(saved)                                          as saved,
      sum(rewrite)                                        as rewrite,
      sum(reread)                                         as reread,
      sum(net)                                            as net,
      sum(case when spend is not null then spend else 0 end)   as spend,
      sum(case when spend is not null then 1 else 0 end)       as spendSessions,
      sum(case when spend is not null then prompts else 0 end) as spendPrompts
    from sessions where at >= ? group by dim order by net desc, sessions desc`;
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, ...rates(r) }));
  const total = rows.reduce((a, r) => {
    for (const k of ['sessions', 'prompts', 'tokens', 'cleared', 'clearedSessions', 'rereads', 'cuts', 'callsCleared', 'results', 'saved', 'rewrite', 'reread', 'net', 'spend', 'spendSessions', 'spendPrompts']) a[k] = (a[k] || 0) + (r[k] || 0);
    return a;
  }, { dim: 'All', installs: new Set() });
  total.installs = db.prepare(`select count(distinct install) n from sessions where at >= ?`).get(since).n;
  return { by, days, since, rows, total: { ...total, ...rates(total) } };
}

// The derived figures, each a ratio of two sums. `null` rather than 0 where the denominator is empty: a
// fleet with no priced session has no cost per session, and saying $0.00 would be a lie about the data.
function rates(r) {
  const div = (a, b) => (b > 0 ? a / b : null);
  return {
    netPerSession: div(r.net, r.sessions),
    spendPerSession: div(r.spend, r.spendSessions),
    spendPerPrompt: div(r.spend, r.spendPrompts),
    clearedShare: div(r.clearedSessions, r.sessions),
    // what the clearing returned against what the fleet spent, over the sessions that could be priced
    netShareOfSpend: div(r.net, r.spend),
    unpricedSessions: r.sessions - r.spendSessions,
  };
}

// ---------------------------------------------------------------------------
// The machines. This is the view the fleet is actually read in: one row a machine, its own stats beside it.
// A group-by roll-up answers "which customer costs what"; this answers "which machine is behaving unlike
// the others", which is the first question anybody asks of a fleet and the one a roll-up hides.
//
// What a machine *is* comes from its newest session, not from the window: version, client and model all
// change under a long-lived install, and the current answer is the one a fleet view owes the reader.
export function machines(db, { days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const rows = db.prepare(`
    select install,
      min(first_at)                                       as firstAt,
      max(at)                                             as lastAt,
      count(*)                                            as sessions,
      count(distinct client)                              as clients,
      sum(prompts)                                        as prompts,
      sum(coalesce(tokens, 0))                            as tokens,
      sum(cleared)                                        as cleared,
      sum(case when cleared > 0 then 1 else 0 end)        as clearedSessions,
      sum(reread_reads)                                   as rereads,
      sum(cuts)                                           as cuts,
      sum(calls_cleared)                                  as callsCleared,
      sum(results)                                        as results,
      sum(saved)                                          as saved,
      sum(rewrite)                                        as rewrite,
      sum(reread)                                         as reread,
      sum(net)                                            as net,
      sum(case when spend is not null then spend else 0 end)   as spend,
      sum(case when spend is not null then 1 else 0 end)       as spendSessions,
      sum(case when spend is not null then prompts else 0 end) as spendPrompts
    from sessions where at >= ? group by install order by spend desc, sessions desc`).all(since);
  const newest = db.prepare(`select version, client, model, policy from sessions
    where install = ? order by at desc limit 1`);
  return rows.map(r => {
    const n = newest.get(r.install) || {};
    return {
      ...r, ...rates(r),
      version: n.version || null,
      client: n.client || null,
      model: n.model || null,
      policy: n.policy || null,
    };
  });
}

// ---------------------------------------------------------------------------
// What thinker decided, and why. The depth behind the headline: each cut with what it took out and under
// which policy, the reasons it cut nothing (`cutting.js:decideCut`'s own branches), and which tools' results
// left the prompt. A refusal is as interesting as a cut -- "below-trigger on most requests" says those
// sessions are short, which is the honest reading of a small saving rather than a fault.
export function decisions(db, { days = 30, now = Date.now(), limit = 40 } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const rows = db.prepare(`select install, session, model, decisions from sessions
    where at >= ? and decisions != '{}' order by at desc limit 400`).all(since);
  const refusals = {};
  const tools = new Map();
  const cuts = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decisions); } catch { continue; }
    for (const [reason, n] of Object.entries(d.refusals || {})) refusals[reason] = (refusals[reason] || 0) + n;
    for (const t of d.tools || []) {
      const cur = tools.get(t.name) || { name: t.name, calls: 0, tokens: 0 };
      cur.calls += t.calls || 0; cur.tokens += t.tokens || 0;
      tools.set(t.name, cur);
    }
    for (const c of d.rows || []) {
      cuts.push({ ...c, install: r.install, session: r.session, model: c.model || r.model || null });
    }
  }
  cuts.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    cuts: cuts.slice(0, limit),
    refusals: Object.entries(refusals).sort((a, b) => b[1] - a[1]).map(([reason, calls]) => ({ reason, calls })),
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
  };
}

// The sessions a trend can be drawn for, newest first, the ones a cut happened in before the rest: those
// are the ones worth opening, since a cut only reads as anything against the line it changed.
export function plottable(db, { days = 30, now = Date.now(), limit = 40 } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  return db.prepare(`select install, session, at, client, model, cuts, prompts, cleared, net, spend, priced
    from sessions where at >= ? and json_array_length(json_extract(decisions, '$.series')) > 1
    order by cuts > 0 desc, at desc limit ?`).all(since, limit);
}

// One session's own trend: the per-call series the machine sent, with the row it belongs to.
export function sessionTrend(db, { install, session }) {
  const r = db.prepare(`select install, session, at, client, model, decisions, prompts, tokens, cleared,
    cuts, calls_cleared as callsCleared, results, net, saved, rewrite, reread, spend, priced
    from sessions where install = ? and session = ?`).get(install, session);
  if (!r) return null;
  let d = {}; try { d = JSON.parse(r.decisions || '{}'); } catch { d = {}; }
  return { ...r, decisions: d };
}

export function recent(db, { limit = 200 } = {}) {
  return db.prepare(`select install, session, at, first_at as firstAt, client, model, version, prompts, tokens,
    cleared, cuts, calls_cleared as callsCleared, results, net, saved, rewrite, reread, spend, priced,
    json_array_length(json_extract(decisions, '$.series')) as calls
    from sessions order by at desc limit ?`).all(limit);
}

// ---------------------------------------------------------------------------
// Server

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

export function createServer(db) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = fs.readFileSync(path.join(HERE, 'ui.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
      return res.end(page);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, db: DB_PATH });
    if (req.method === 'GET' && url.pathname === '/api/fleet') {
      const by = url.searchParams.get('by') || 'client';
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
      return json(res, 200, {
        ...fleet(db, { by, days }),
        machines: machines(db, { days }),
        decisions: decisions(db, { days }),
        plottable: plottable(db, { days }),
        dimensions: Object.keys(GROUPS),
        recent: recent(db),
      });
    }
    // The fleet's settings, with the surface thinker itself describes: the page draws its form from this
    // and nothing else.
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, { settings: SCHEMA, control: getSettings(db), fleet: fleetRunning(db) });
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { json(res, 413, { error: 'too large' }); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => {
        if (res.writableEnded) return;
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'not JSON' }); }
        const out = setSettings(db, body?.config, { by: 'dashboard' });
        return json(res, 200, { ...out, fleet: fleetRunning(db) });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/machine') {
      const install = url.searchParams.get('install');
      if (!install) return json(res, 400, { error: 'install required' });
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
      const row = machines(db, { days }).find(m => m.install === install) || null;
      return json(res, 200, { machine: row, running: running(db, install), settings: SCHEMA, control: getSettings(db) });
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const row = sessionTrend(db, { install: url.searchParams.get('install'), session: url.searchParams.get('session') });
      return row ? json(res, 200, row) : json(res, 404, { error: 'no such session' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { json(res, 413, { error: 'too large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        const counts = { inserted: 0, updated: 0, stale: 0, rejected: 0 };
        let install = null;
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
          const text = line.trim();
          if (!text) continue;
          let ev; try { ev = JSON.parse(text); } catch { counts.rejected++; continue; }
          const verdict = putEvent(db, ev);
          counts[verdict]++;
          if (verdict !== 'rejected') install = ev.install;
        }
        // The answer carries what the fleet should be running (managed.js applies it, newest `at` winning).
        // A fleet nobody has set is told nothing at all, so it pays no attention cost.
        const control = install ? getSettings(db) : null;
        json(res, 202, { status: 'accepted', ...counts, ...(control?.at ? { managed: { at: control.at, config: control.config } } : {}) });
      });
      return;
    }
    return json(res, 404, { error: 'not found' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const db = openDb(DB_PATH);
  createServer(db).listen(PORT, '0.0.0.0', () => {
    console.log(`thinker fleet collector on http://127.0.0.1:${PORT}  (db: ${DB_PATH})`);
    console.log(`  events:  POST /v1/sessions   (newline-delimited JSON)`);
    console.log(`  page:    GET  /`);
  });
}
