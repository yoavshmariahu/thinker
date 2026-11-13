// The demo collector: a sink for thinker's session events, a SQLite database, and the fleet page over it.
//
// What it is for. thinker ships one event per session (`src/events.js`), priced on the machine by the one
// door the Report and `thinker prs` read. This is the smallest honest thing that receives them: an HTTP
// endpoint, a table, and a page that groups by the labels an operator set -- which is how a company running
// thinker inside its own coding agent sees per-customer and per-agent figures it could not see before.
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
      labels        text not null default '{}',
      raw           text not null,
      primary key (install, session)
    );
    create index if not exists sessions_at on sessions (at);
  `);
  return db;
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
      cuts, calls_cleared, results, decisions, labels, raw)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(install, session) do update set
      at = excluded.at, first_at = excluded.first_at, last_at = excluded.last_at,
      client = excluded.client, model = excluded.model, policy = excluded.policy, version = excluded.version,
      prompts = excluded.prompts, tokens = excluded.tokens, cleared = excluded.cleared,
      reread_reads = excluded.reread_reads, reread_tokens = excluded.reread_tokens,
      saved = excluded.saved, rewrite = excluded.rewrite, reread = excluded.reread, net = excluded.net,
      spend = excluded.spend, priced = excluded.priced,
      cuts = excluded.cuts, calls_cleared = excluded.calls_cleared, results = excluded.results,
      decisions = excluded.decisions, labels = excluded.labels, raw = excluded.raw
    where excluded.at >= sessions.at
  `);
  const before = db.prepare('select at from sessions where install = ? and session = ?').get(ev.install, ev.session);
  stmt.run(ev.install, ev.session, ev.at, ev.firstAt ?? null, ev.lastAt ?? null,
    ev.client ?? null, ev.model ?? null, ev.policy ?? null, ev.version ?? null, int(ev.prompts), num(ev.tokens),
    int(ev.cleared), int(ev.rereads?.reads), int(ev.rereads?.tokens),
    cost.saved ?? 0, cost.rewrite ?? 0, cost.reread ?? 0, cost.net ?? 0,
    num(cost.spend), cost.priced ? 1 : 0,
    int(d.cuts), int(d.callsCleared), int(d.results), JSON.stringify(d),
    JSON.stringify(ev.labels || {}), JSON.stringify(ev));
  if (!before) return 'inserted';
  return ev.at >= before.at ? 'updated' : 'stale';
}

// Which label keys the fleet has sent, so the page offers the real dimensions and not a guess.
export function labelKeys(db) {
  const rows = db.prepare(`select distinct key from sessions, json_each(sessions.labels) order by key`).all();
  return rows.map(r => r.key);
}

const GROUPS = { client: 'client', model: 'model', install: 'install', policy: 'policy' };

// The fleet, grouped. `by` is a label key, or one of the session's own columns above. Every rate is taken
// here from the sums, never from a row's own rate.
export function fleet(db, { by = 'client', days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const dim = GROUPS[by] ? `coalesce(nullif(${GROUPS[by]}, ''), '(none)')` : `coalesce(json_extract(labels, '$.' || ?), '(unlabelled)')`;
  const params = GROUPS[by] ? [since] : [by, since];
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
// What a machine *is* comes from its newest session, not from the window: labels, version, client and model
// all change under a long-lived install, and the current answer is the one a fleet view owes the reader.
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
  const newest = db.prepare(`select labels, version, client, model, policy from sessions
    where install = ? order by at desc limit 1`);
  return rows.map(r => {
    const n = newest.get(r.install) || {};
    return {
      ...r, ...rates(r),
      labels: JSON.parse(n.labels || '{}'),
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
  const rows = db.prepare(`select install, session, labels, model, decisions from sessions
    where at >= ? and decisions != '{}' order by at desc limit 400`).all(since);
  const refusals = {};
  const tools = new Map();
  const cuts = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decisions); } catch { continue; }
    const labels = JSON.parse(r.labels || '{}');
    for (const [reason, n] of Object.entries(d.refusals || {})) refusals[reason] = (refusals[reason] || 0) + n;
    for (const t of d.tools || []) {
      const cur = tools.get(t.name) || { name: t.name, calls: 0, tokens: 0 };
      cur.calls += t.calls || 0; cur.tokens += t.tokens || 0;
      tools.set(t.name, cur);
    }
    for (const c of d.rows || []) {
      cuts.push({ ...c, install: r.install, session: r.session, labels, model: c.model || r.model || null });
    }
  }
  cuts.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    cuts: cuts.slice(0, limit),
    refusals: Object.entries(refusals).sort((a, b) => b[1] - a[1]).map(([reason, calls]) => ({ reason, calls })),
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
  };
}

export function recent(db, { limit = 50 } = {}) {
  return db.prepare(`select install, session, at, client, model, version, prompts, tokens, cleared, net, spend, priced, labels
    from sessions order by at desc limit ?`).all(limit)
    .map(r => ({ ...r, labels: JSON.parse(r.labels || '{}') }));
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
        dimensions: [...Object.keys(GROUPS), ...labelKeys(db)],
        recent: recent(db),
      });
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
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
          const text = line.trim();
          if (!text) continue;
          let ev; try { ev = JSON.parse(text); } catch { counts.rejected++; continue; }
          counts[putEvent(db, ev)]++;
        }
        json(res, 202, { status: 'accepted', ...counts });
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
