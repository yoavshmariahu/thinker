#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_BUCKET = 's3://thinker-metrics-442899048927/metrics/';
export const DEFAULT_DB_PATH = path.join(
  process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'),
  'metrics.db'
);

export function initDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for high concurrency and performance
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  // Schema definition
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      file_key TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      event TEXT,
      version TEXT,
      platform TEXT,
      timestamp TEXT NOT NULL,
      period_hours INTEGER,
      cache_total_notes INTEGER DEFAULT 0,
      cache_total_bytes INTEGER DEFAULT 0,
      cache_repositories_count INTEGER DEFAULT 0,
      requests_total INTEGER DEFAULT 0,
      requests_answered INTEGER DEFAULT 0,
      hit_rate REAL DEFAULT 0,
      servings_prompt INTEGER DEFAULT 0,
      servings_file INTEGER DEFAULT 0,
      servings_lookup INTEGER DEFAULT 0,
      tokens_served INTEGER DEFAULT 0,
      assessed_confirmed INTEGER DEFAULT 0,
      assessed_contradicted INTEGER DEFAULT 0,
      assessed_unused INTEGER DEFAULT 0,
      assessed_pending INTEGER DEFAULT 0,
      confirmation_rate REAL DEFAULT 0,
      calls_avoided INTEGER DEFAULT 0,
      tokens_avoided INTEGER DEFAULT 0,
      net_tokens_saved INTEGER DEFAULT 0,
      feedback_useful INTEGER DEFAULT 0,
      feedback_not_useful INTEGER DEFAULT 0,
      feedback_corrections INTEGER DEFAULT 0,
      sessions_distilled INTEGER DEFAULT 0,
      new_notes INTEGER DEFAULT 0,
      notes_merged INTEGER DEFAULT 0,
      prs_mined INTEGER DEFAULT 0,
      stale_verified INTEGER DEFAULT 0,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS cache_kinds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_key TEXT NOT NULL,
      install_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      FOREIGN KEY (file_key) REFERENCES reports(file_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reports_install ON reports(install_id);
    CREATE INDEX IF NOT EXISTS idx_reports_ts ON reports(timestamp);
    CREATE INDEX IF NOT EXISTS idx_reports_event ON reports(event);
    CREATE INDEX IF NOT EXISTS idx_reports_platform ON reports(platform);
    CREATE INDEX IF NOT EXISTS idx_kinds_file_key ON cache_kinds(file_key);
    CREATE INDEX IF NOT EXISTS idx_kinds_kind ON cache_kinds(kind);

    DROP VIEW IF EXISTS v_latest_installs;
    CREATE VIEW v_latest_installs AS
    SELECT r.*
    FROM reports r
    JOIN (
      SELECT install_id, MAX(timestamp) AS max_ts
      FROM reports
      GROUP BY install_id
    ) latest ON r.install_id = latest.install_id AND r.timestamp = latest.max_ts;

    DROP VIEW IF EXISTS v_active_installs;
    CREATE VIEW v_active_installs AS
    SELECT *
    FROM v_latest_installs
    WHERE requests_total > 0 OR cache_total_notes > 0 OR sessions_distilled > 0;

    DROP VIEW IF EXISTS v_hourly_volume;
    CREATE VIEW v_hourly_volume AS
    SELECT SUBSTR(timestamp, 1, 13) || ':00:00Z' AS hour_utc,
           COUNT(*) AS reports_count,
           COUNT(DISTINCT install_id) AS unique_installs,
           SUM(requests_total) AS total_requests,
           SUM(tokens_served) AS total_tokens_served
    FROM reports
    GROUP BY hour_utc
    ORDER BY hour_utc ASC;

    DROP VIEW IF EXISTS v_kind_distribution;
    CREATE VIEW v_kind_distribution AS
    SELECT k.kind,
           SUM(k.count) AS total_notes,
           COUNT(DISTINCT k.install_id) AS installs_count
    FROM cache_kinds k
    JOIN v_latest_installs l ON k.file_key = l.file_key
    GROUP BY k.kind
    ORDER BY total_notes DESC;
  `);

  return db;
}

export function ingestJsonFiles(db, filesWithKeys) {
  const insertReport = db.prepare(`
    INSERT OR REPLACE INTO reports (
      file_key, install_id, event, version, platform, timestamp, period_hours,
      cache_total_notes, cache_total_bytes, cache_repositories_count,
      requests_total, requests_answered, hit_rate,
      servings_prompt, servings_file, servings_lookup, tokens_served,
      assessed_confirmed, assessed_contradicted, assessed_unused, assessed_pending, confirmation_rate,
      calls_avoided, tokens_avoided, net_tokens_saved,
      feedback_useful, feedback_not_useful, feedback_corrections,
      sessions_distilled, new_notes, notes_merged, prs_mined, stale_verified,
      raw_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?
    )
  `);

  const deleteKinds = db.prepare(`DELETE FROM cache_kinds WHERE file_key = ?`);
  const insertKind = db.prepare(`
    INSERT INTO cache_kinds (file_key, install_id, kind, count)
    VALUES (?, ?, ?, ?)
  `);

  let ingested = 0;
  let skipped = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const { key, filePath, content } of filesWithKeys) {
      try {
        const text = content !== undefined ? content : fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(text);

        const cs = data.cacheSize || {};
        const eff = data.effectiveness || {};
        const srv = eff.servings || {};
        const ass = eff.assessed || {};
        const sav = eff.estimatedSavings || {};
        const fb = eff.feedback || {};
        const lc = eff.lifecycle || {};

        insertReport.run(
          key,
          data.installId || 'unknown',
          data.event || 'undefined',
          data.version || 'unknown',
          data.platform || 'unknown',
          data.timestamp || new Date().toISOString(),
          data.periodHours || 24,
          cs.totalNotes || 0,
          cs.totalBytes || 0,
          cs.repositoriesCount || 0,
          eff.requestsTotal || 0,
          eff.requestsAnswered || 0,
          eff.hitRate || 0,
          srv.prompt || 0,
          srv.file || 0,
          srv.lookup || 0,
          eff.tokensServed || 0,
          ass.confirmed || 0,
          ass.contradicted || 0,
          ass.unused || 0,
          ass.pending || 0,
          ass.confirmationRate || 0,
          sav.callsAvoided || 0,
          sav.tokensAvoided || 0,
          sav.netTokensSaved || 0,
          fb.useful || 0,
          fb.notUseful || 0,
          fb.corrections || 0,
          lc.sessionsDistilled || 0,
          lc.newNotes || 0,
          lc.notesMerged || 0,
          lc.prsMined || 0,
          lc.staleVerified || 0,
          text
        );

        deleteKinds.run(key);
        if (cs.kinds && typeof cs.kinds === 'object') {
          for (const [kind, count] of Object.entries(cs.kinds)) {
            insertKind.run(key, data.installId || 'unknown', kind, count);
          }
        }

        ingested++;
      } catch (err) {
        skipped++;
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { ingested, skipped };
}

export function syncAndIngest({
  bucket = DEFAULT_BUCKET,
  dbPath = DEFAULT_DB_PATH,
  localCacheDir = null,
} = {}) {
  const db = initDb(dbPath);
  const cacheDir = localCacheDir || path.join(path.dirname(dbPath), 's3_metrics_cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  // Sync from S3 if aws cli is available
  try {
    execFileSync('aws', ['s3', 'sync', bucket, cacheDir], { stdio: 'pipe' });
  } catch (err) {
    // If AWS CLI fails, proceed with whatever is in cacheDir
  }

  // Find all JSON files in cacheDir
  const filesWithKeys = [];
  function scan(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else if (ent.isFile() && ent.name.endsWith('.json')) {
        const rel = path.relative(cacheDir, full);
        filesWithKeys.push({ key: rel, filePath: full });
      }
    }
  }
  scan(cacheDir);

  const stats = ingestJsonFiles(db, filesWithKeys);
  return { ...stats, totalFiles: filesWithKeys.length, dbPath };
}

// Interactive web client HTML
const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thinker Metrics Explorer</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-dim: #94a3b8;
      --cyan: #38bdf8;
      --accent: #0284c7;
      --code-bg: #090d16;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      padding: 12px 20px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand span { color: var(--cyan); }
    .badge {
      font-size: 0.75rem;
      background: rgba(56, 189, 248, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 2px 8px;
      border-radius: 9999px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: #0369a1; }
    button.secondary {
      background: #334155;
      color: var(--text);
    }
    button.secondary:hover { background: #475569; }
    .container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .sidebar {
      width: 280px;
      background: #111827;
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 16px;
    }
    .section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin-bottom: 8px;
      font-weight: 700;
    }
    .query-item {
      padding: 8px 10px;
      border-radius: 6px;
      background: #1f2937;
      border: 1px solid #374151;
      margin-bottom: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      transition: border-color 0.15s ease;
    }
    .query-item:hover {
      border-color: var(--cyan);
      background: #273549;
    }
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 16px;
      gap: 12px;
    }
    .editor-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    textarea {
      width: 100%;
      height: 90px;
      box-sizing: border-box;
      background: var(--code-bg);
      color: #38bdf8;
      border: none;
      padding: 12px;
      font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem;
      resize: vertical;
      outline: none;
    }
    .editor-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: #162032;
      border-top: 1px solid var(--border);
    }
    .results-card {
      flex: 1;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .results-bar {
      padding: 8px 16px;
      background: #162032;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
      color: var(--text-dim);
    }
    .table-wrap {
      flex: 1;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      font-family: ui-monospace, Menlo, monospace;
    }
    th, td {
      padding: 8px 12px;
      border-bottom: 1px solid #293548;
      text-align: left;
      white-space: nowrap;
    }
    th {
      background: #131c2e;
      position: sticky;
      top: 0;
      color: var(--cyan);
      font-weight: 600;
      z-index: 1;
    }
    tr:hover { background: #26334d; }
    .status-msg {
      font-size: 0.85rem;
      color: #10b981;
    }
    .error-msg {
      font-size: 0.85rem;
      color: #f43f5e;
      padding: 12px;
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.3);
      border-radius: 6px;
      margin: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      🧠 <span>thinker</span> SQLite Metrics Server
      <div class="badge" id="stats-badge">Loading...</div>
    </div>
    <div class="header-actions">
      <button class="secondary" onclick="syncFromS3()">↻ Sync S3</button>
      <button class="secondary" onclick="exportCSV()">Export CSV</button>
      <button onclick="runQuery()">▶ Execute (Ctrl+Enter)</button>
    </div>
  </header>
  <div class="container">
    <div class="sidebar">
      <div class="section-title">Saved Queries</div>
      <div class="query-item" onclick="setQuery('SELECT * FROM v_latest_installs ORDER BY timestamp DESC LIMIT 50;')">
        <strong>Latest per Install</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">Most recent state per installId</div>
      </div>
      <div class="query-item" onclick="setQuery('SELECT install_id, platform, cache_total_notes, requests_total, assessed_confirmed, net_tokens_saved, timestamp FROM v_active_installs ORDER BY requests_total DESC;')">
        <strong>Active Installs</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">Installs with requests or cached notes</div>
      </div>
      <div class="query-item" onclick="setQuery('SELECT kind, total_notes, installs_count FROM v_kind_distribution;')">
        <strong>Note Kinds Distribution</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">Breakdown of note types across installs</div>
      </div>
      <div class="query-item" onclick="setQuery('SELECT * FROM v_hourly_volume;')">
        <strong>Hourly Volume</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">Ingestion activity by hour UTC</div>
      </div>
      <div class="query-item" onclick="setQuery('SELECT platform, version, COUNT(DISTINCT install_id) as installs, SUM(requests_total) as reqs, SUM(calls_avoided) as avoided, SUM(net_tokens_saved) as tokens_saved FROM v_latest_installs GROUP BY platform, version;')">
        <strong>Savings Aggregate</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">Total tokens and calls saved by platform</div>
      </div>
      <div class="query-item" onclick="setQuery('SELECT file_key, install_id, event, platform, timestamp, requests_total, cache_total_notes FROM reports ORDER BY timestamp DESC LIMIT 100;')">
        <strong>Raw Reports</strong>
        <div style="color:var(--text-dim); font-size:0.7rem;">All 300+ ingestion payloads</div>
      </div>

      <div class="section-title" style="margin-top:20px;">Tables & Views</div>
      <div style="font-size:0.8rem; line-height:1.6; color:var(--text-dim);">
        <div>📊 <code>reports</code></div>
        <div>🏷️ <code>cache_kinds</code></div>
        <div>👁️ <code>v_latest_installs</code></div>
        <div>👁️ <code>v_active_installs</code></div>
        <div>👁️ <code>v_kind_distribution</code></div>
        <div>👁️ <code>v_hourly_volume</code></div>
      </div>
    </div>
    <div class="main">
      <div class="editor-card">
        <textarea id="sql-input">SELECT * FROM v_active_installs ORDER BY requests_total DESC;</textarea>
        <div class="editor-bar">
          <span style="font-size:0.8rem; color:var(--text-dim);">Tip: Click a saved query on the left or edit directly.</span>
          <button onclick="runQuery()">Run SQL</button>
        </div>
      </div>
      <div class="results-card">
        <div class="results-bar">
          <span id="results-count">Results</span>
          <span id="exec-time"></span>
        </div>
        <div class="table-wrap" id="table-wrap">
          <div style="padding:20px; color:var(--text-dim);">Running query...</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentRows = [];
    let currentCols = [];

    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stats-badge').textContent = 
          data.totalReports + ' reports | ' + data.uniqueInstalls + ' installs';
      } catch (err) {}
    }

    function setQuery(sql) {
      document.getElementById('sql-input').value = sql;
      runQuery();
    }

    async function syncFromS3() {
      const badge = document.getElementById('stats-badge');
      badge.textContent = 'Syncing S3...';
      try {
        const res = await fetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        alert('Sync complete: ' + data.ingested + ' records ingested.');
        loadStats();
        runQuery();
      } catch (err) {
        alert('Sync error: ' + err.message);
      }
    }

    async function runQuery() {
      const sql = document.getElementById('sql-input').value.trim();
      const wrap = document.getElementById('table-wrap');
      const timeEl = document.getElementById('exec-time');
      const countEl = document.getElementById('results-count');

      wrap.innerHTML = '<div style="padding:20px; color:var(--text-dim);">Executing query...</div>';
      timeEl.textContent = '';

      const t0 = performance.now();
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql })
        });
        const data = await res.json();
        const duration = Math.round(performance.now() - t0);

        if (data.error) {
          wrap.innerHTML = '<div class="error-msg"><strong>Error:</strong> ' + data.error + '</div>';
          countEl.textContent = 'Query failed';
          return;
        }

        currentCols = data.columns || [];
        currentRows = data.rows || [];

        timeEl.textContent = duration + ' ms';
        countEl.textContent = currentRows.length + ' row' + (currentRows.length === 1 ? '' : 's');

        if (!currentRows.length) {
          wrap.innerHTML = '<div style="padding:20px; color:var(--text-dim);">No rows returned.</div>';
          return;
        }

        let html = '<table><thead><tr>';
        for (const col of currentCols) {
          html += '<th>' + col + '</th>';
        }
        html += '</tr></thead><tbody>';

        for (const row of currentRows) {
          html += '<tr>';
          for (const col of currentCols) {
            let val = row[col];
            if (val === null || val === undefined) val = '<span style="color:#64748b">null</span>';
            else if (typeof val === 'object') val = JSON.stringify(val);
            html += '<td>' + String(val) + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        wrap.innerHTML = html;
      } catch (err) {
        wrap.innerHTML = '<div class="error-msg">' + err.message + '</div>';
      }
    }

    function exportCSV() {
      if (!currentRows.length || !currentCols.length) return alert('No data to export');
      const header = currentCols.join(',');
      const rows = currentRows.map(r => 
        currentCols.map(c => {
          let val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
          if (val.includes(',') || val.includes('"') || val.includes('\\n')) {
            val = '"' + val.replace(/"/g, '""') + '"';
          }
          return val;
        }).join(',')
      );
      const csv = [header, ...rows].join('\\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'thinker_metrics_' + Date.now() + '.csv';
      a.click();
    }

    document.getElementById('sql-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        runQuery();
      }
    });

    window.addEventListener('DOMContentLoaded', () => {
      loadStats();
      runQuery();
    });
  </script>
</body>
</html>
`;

export function startServer({
  port = 4100,
  dbPath = DEFAULT_DB_PATH,
} = {}) {
  const db = initDb(dbPath);

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(WEB_UI_HTML);
      }
      return;
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      try {
        const row = db.prepare(`
          SELECT COUNT(*) as totalReports,
                 COUNT(DISTINCT install_id) as uniqueInstalls,
                 SUM(requests_total) as totalRequests,
                 SUM(net_tokens_saved) as totalNetTokensSaved
          FROM reports
        `).get();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(row));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      try {
        const stats = syncAndIngest({ dbPath });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/query') {
      const handleQuery = (sql) => {
        if (!sql || typeof sql !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'SQL query string required' }));
          return;
        }

        const t0 = performance.now();
        try {
          const stmt = db.prepare(sql);
          let rows = [];
          if (stmt.all) {
            rows = stmt.all();
          } else {
            rows = stmt.run ? [stmt.run()] : [];
          }
          const executionTimeMs = Math.round((performance.now() - t0) * 100) / 100;
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sql,
            columns,
            rows,
            count: rows.length,
            executionTimeMs
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, sql }));
        }
      };

      if (req.method === 'GET') {
        const sql = parsed.searchParams.get('sql') || 'SELECT * FROM v_latest_installs LIMIT 20;';
        handleQuery(sql);
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            handleQuery(data.sql);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({ server, port: actualPort, dbPath, url: `http://127.0.0.1:${actualPort}` });
    });
    server.on('error', reject);
  });
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'serve';

  let dbPath = DEFAULT_DB_PATH;
  let port = 4100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) dbPath = path.resolve(args[++i]);
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
  }

  if (cmd === 'ingest' || cmd === 'sync') {
    console.log(`Syncing and ingesting S3 metrics into SQLite (${dbPath})...`);
    const res = syncAndIngest({ dbPath });
    console.log(`Done! Ingested ${res.ingested} records (${res.skipped} skipped) from ${res.totalFiles} files.`);
  } else if (cmd === 'query') {
    const sql = args[1] || 'SELECT * FROM v_latest_installs LIMIT 10;';
    const db = initDb(dbPath);
    console.log(`Executing: ${sql}`);
    const rows = db.prepare(sql).all();
    console.table(rows);
  } else if (cmd === 'serve') {
    // Ingest first if db doesn't exist
    if (!fs.existsSync(dbPath)) {
      console.log(`Database does not exist. Initializing and ingesting from S3...`);
      syncAndIngest({ dbPath });
    }
    startServer({ port, dbPath }).then(({ url }) => {
      console.log(`\n🚀 Thinker SQLite Metrics Server running at: ${url}`);
      console.log(`📊 Database: ${dbPath}`);
      console.log(`💡 Web UI available at: ${url}`);
      console.log(`🔌 API endpoint: ${url}/api/query (POST {"sql": "..."} or GET ?sql=...)`);
      console.log(`Press Ctrl+C to stop.`);
    }).catch(err => {
      console.error(`Failed to start server:`, err);
      process.exit(1);
    });
  } else {
    console.log(`Usage: node scripts/metrics-db.js [serve|ingest|query] [--db path] [--port 4100]`);
  }
}
