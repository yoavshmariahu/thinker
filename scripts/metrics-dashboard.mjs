#!/usr/bin/env node
// Local Metabase backed by durable Docker volumes; production access is read-only.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const work = path.join(root, '.metrics-work/dashboard');
const stateFile = path.join(work, 'state.json');
const base = 'http://127.0.0.1:3030';
const tunnelPort = 15432;
const host = 'codervibes.cc9u406wsj02.us-east-1.rds.amazonaws.com';
const composeFile = path.join(root, 'infra/metrics/dashboard.compose.yml');
let session;
let state;
function save() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); }
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', 'thinker-dashboard', '-f', composeFile, ...args], {
    encoding: 'utf8', env: { ...process.env, DASHBOARD_DB_PASSWORD: state.dbPassword,
      DASHBOARD_ENCRYPTION_KEY: state.encryptionKey }, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
async function api(route, method = 'GET', body) {
  const response = await fetch(base + '/api' + route, {
    method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Metabase-Session': session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Metabase ${method} ${route}: HTTP ${response.status}${route.endsWith('/query') ? ' ' + (await response.text()).slice(0, 1200) : ''}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
function listening() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: tunnelPort });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function tunnel() {
  if (await listening()) return;
  const log = fs.openSync(path.join(work, 'tunnel.log'), 'a', 0o600);
  const child = spawn('aws', ['--profile', 'yoav', '--region', 'us-east-1', 'ssm', 'start-session',
    '--target', 'i-078f0fd7bd61f4b65', '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters', JSON.stringify({ host: [host], portNumber: ['5432'], localPortNumber: [String(tunnelPort)] })],
  { detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  child.on('error', () => {});
  for (let i = 0; i < 30; i++) {
    if (await listening()) { console.log('Private RDS tunnel ready.'); return; }
    await delay(1000);
  }
  throw new Error(`Database tunnel did not start. Check ${work}/tunnel.log and AWS login.`);
}

const diagnosticQuestions = [
  { name: 'Received reports', display: 'scalar', sql: 'SELECT count(*) AS reports FROM reports' },
  { name: 'Installation IDs (not people)', display: 'scalar', sql: 'SELECT count(*) AS installations FROM v_latest_installs' },
  { name: 'Known devices', display: 'scalar', sql: 'SELECT count(*) AS known_devices FROM v_latest_devices' },
  { name: 'Reporting installations · last 24h', display: 'scalar', sql: "SELECT count(DISTINCT install_id) AS installations FROM reports WHERE received_at >= now() - interval '24 hours'" },
  { name: 'Report arrivals · UTC', display: 'bar', sql: "SELECT date_trunc('hour', received_at AT TIME ZONE 'UTC') AS hour_utc, count(*) AS reports FROM reports GROUP BY 1 ORDER BY 1", settings: { 'graph.dimensions': ['hour_utc'], 'graph.metrics': ['reports'] } },
  { name: 'Platforms · latest installation snapshots', display: 'bar', sql: 'SELECT platform, count(*) AS installations FROM v_latest_installs GROUP BY 1 ORDER BY 2 DESC', settings: { 'graph.dimensions': ['platform'], 'graph.metrics': ['installations'] } },
  { name: 'Usage · latest snapshots', display: 'table', sql: 'SELECT sum(requests_total) AS requests, sum(requests_answered) AS answered, round(100.0 * sum(requests_answered) / nullif(sum(requests_total), 0), 1) AS hit_rate_percent, sum(tokens_served) AS tokens_injected, count(*) FILTER (WHERE requests_total > 0) AS installations_with_requests FROM v_latest_installs' },
  { name: 'Cache inventory · latest snapshots', display: 'table', sql: 'SELECT sum(cache_total_notes) AS notes, round(sum(cache_total_bytes) / 1024.0, 1) AS size_kib, count(*) FILTER (WHERE cache_total_notes > 0) AS installations_with_notes, sum(cache_repositories_count) AS repository_installation_pairs FROM v_latest_installs' },
  { name: 'Note kinds · latest snapshots', display: 'bar', sql: 'SELECT kind, total_notes FROM v_kind_distribution ORDER BY total_notes DESC', settings: { 'graph.dimensions': ['kind'], 'graph.metrics': ['total_notes'] } },
  { name: 'Note assessments · latest snapshots', display: 'bar', sql: "SELECT assessment, sum(amount) AS notes FROM v_latest_installs CROSS JOIN LATERAL (VALUES ('Confirmed', assessed_confirmed), ('Contradicted', assessed_contradicted), ('Unused', assessed_unused), ('Pending', assessed_pending)) AS a(assessment, amount) GROUP BY assessment ORDER BY notes DESC", settings: { 'graph.dimensions': ['assessment'], 'graph.metrics': ['notes'] } },
  { name: 'Learning · latest snapshots', display: 'table', sql: 'SELECT sum(sessions_distilled) AS sessions_distilled, sum(new_notes) AS new_notes, sum(notes_merged) AS notes_merged, sum(prs_mined) AS prs_mined, sum(stale_verified) AS stale_notes_verified FROM v_latest_installs' },
  { name: 'Savings estimates · latest snapshots', display: 'table', sql: 'SELECT sum(calls_avoided) AS estimated_reads_avoided, sum(tokens_avoided) AS estimated_tokens_avoided, sum(tokens_served) AS tokens_injected, sum(net_tokens_saved) AS estimated_net_tokens_saved FROM v_latest_installs' },
  { name: 'Feedback · latest snapshots', display: 'table', sql: 'SELECT sum(feedback_useful) AS useful, sum(feedback_not_useful) AS not_useful, sum(feedback_corrections) AS corrections FROM v_latest_installs' },
  { name: 'Versions · latest installation snapshots', display: 'bar', sql: "SELECT coalesce(version, 'unknown') AS version, count(*) AS installations FROM v_latest_installs GROUP BY 1 ORDER BY 2 DESC", settings: { 'graph.dimensions': ['version'], 'graph.metrics': ['installations'] } },
  { name: 'Data freshness and device coverage', display: 'table', sql: 'SELECT max(received_at) AS latest_arrival, max(timestamp) AS latest_client_report, count(*) FILTER (WHERE device_id IS NULL) AS installations_without_device_id, min(period_hours) AS shortest_snapshot_hours, max(period_hours) AS longest_snapshot_hours FROM v_latest_installs' },
  { name: 'Latest installation snapshots', display: 'table', fullWidth: true, sql: 'SELECT install_id, device_id, timestamp, platform, version, period_hours, cache_total_notes, requests_total, requests_answered, sessions_distilled FROM v_latest_installs ORDER BY timestamp DESC' },
  { name: 'Snapshot patterns · inspect potential test data', display: 'table', sql: 'SELECT cache_total_notes, requests_total, tokens_served, assessed_confirmed, tokens_avoided, sessions_distilled, count(*) AS installations FROM v_latest_installs GROUP BY 1,2,3,4,5,6 ORDER BY count(*) DESC' },
  { name: 'Upload types', display: 'bar', sql: "SELECT CASE WHEN event IS NULL OR event IN ('undefined', '') THEN 'Unknown' ELSE event END AS upload_type, count(*) AS uploads FROM reports GROUP BY 1 ORDER BY 2 DESC", settings: { 'graph.dimensions': ['upload_type'], 'graph.metrics': ['uploads'] } },
  { name: 'Waitlist emails', display: 'table', fullWidth: true, sql: "SELECT raw_json->>'email' AS email, min(timestamp) AS first_signup, max(timestamp) AS latest_signup, count(*) AS submissions FROM reports WHERE event = 'waitlist' AND nullif(raw_json->>'email', '') IS NOT NULL GROUP BY 1 ORDER BY first_signup DESC" },
  { name: 'Latest telemetry · SQL starter', display: 'table', sql: 'SELECT timestamp, event, platform, version, install_id, device_id, requests_total, cache_total_notes FROM reports ORDER BY timestamp DESC LIMIT 100' }
];

const performanceQuestions = [
  { name: 'Cache requests', display: 'scalar', sql: 'SELECT sum(requests_total) AS cache_requests FROM v_latest_installs', description: 'Orientation and lookup requests in the latest snapshot per installation. Does not count late file notes.' },
  { name: 'Cache hit rate (%)', display: 'scalar', sql: 'SELECT round(100.0 * sum(requests_answered) / nullif(sum(requests_total), 0), 1) AS hit_rate_percent FROM v_latest_installs', description: 'Share of cache requests that returned at least one note. Weighted by request count. A hit does not prove the note was useful.' },
  { name: 'Assessed notes confirmed useful (%)', display: 'scalar', sql: 'SELECT round(100.0 * sum(assessed_confirmed) / nullif(sum(assessed_confirmed + assessed_contradicted + assessed_unused), 0), 1) AS useful_percent FROM v_latest_installs', description: 'Confirmed / (confirmed + contradicted + unused). Pending assessments are excluded. Based on the distiller reading agent traces, not an independent accuracy benchmark.' },
  { name: 'Estimated tokens saved before distillation cost', display: 'scalar', sql: 'SELECT sum(net_tokens_saved) AS estimated_tokens_saved FROM v_latest_installs', description: 'Estimated file-reading tokens avoided minus note tokens injected. Does not subtract model tokens used to build or maintain the cache; not measured token or dollar savings.' },
  { name: 'Cache requests with and without a hit', display: 'bar', sql: "SELECT outcome, sum(amount) AS requests FROM v_latest_installs CROSS JOIN LATERAL (VALUES ('Returned notes', requests_answered), ('No notes returned', requests_total - requests_answered)) AS r(outcome, amount) GROUP BY outcome", settings: { 'graph.dimensions': ['outcome'], 'graph.metrics': ['requests'] } },
  { name: 'Distillation runs', display: 'scalar', sql: 'SELECT sum(sessions_distilled) AS runs FROM v_latest_installs', description: 'Recorded distillation completions. A session can be distilled incrementally more than once; these are runs, not distinct sessions.' },
  { name: 'New notes from distillation', display: 'scalar', sql: 'SELECT sum(new_notes) AS new_notes FROM v_latest_installs' },
  { name: 'Existing notes merged during distillation', display: 'scalar', sql: 'SELECT sum(notes_merged) AS notes_merged FROM v_latest_installs' },
  { name: 'Note changes per distillation run', display: 'scalar', sql: 'SELECT round(sum(new_notes + notes_merged)::numeric / nullif(sum(sessions_distilled), 0), 2) AS note_changes_per_run FROM v_latest_installs', description: '(New notes + merges) / recorded distillation runs. A run with no note changes may still assess existing notes. This does not measure runtime or success rate.' },
  { name: 'Distillation output by installation', display: 'table', sql: 'SELECT install_id, timestamp AS snapshot_time, sessions_distilled AS distillation_runs, new_notes, notes_merged, round((new_notes + notes_merged)::numeric / nullif(sessions_distilled, 0), 2) AS note_changes_per_run FROM v_latest_installs WHERE sessions_distilled > 0 OR new_notes > 0 OR notes_merged > 0 ORDER BY new_notes + notes_merged DESC' }
];
const distillField = name => `(CASE WHEN jsonb_typeof(raw_json #> '{distillation,${name}}') = 'number' THEN (raw_json #>> '{distillation,${name}}')::numeric END)`;
const distillSum = name => `sum(${distillField(name)})`;
const costQuestions = [
  { name: 'Distillation reported cost (USD)', display: 'scalar', sql: `SELECT ${distillSum('reportedCostUsd')} AS reported_cost_usd FROM v_latest_installs`, description: 'Sum of provider-reported distillation model costs, including failed attempts and retries. Missing provider prices remain unknown; this may be a partial cost.' },
  { name: 'Average distillation duration (seconds)', display: 'scalar', sql: `SELECT round(${distillSum('durationMs')} / nullif(${distillSum('durationSamples')}, 0) / 1000, 2) AS average_seconds FROM v_latest_installs`, description: 'Wall time from model invocation through note persistence, including retries and handled failures. Abruptly killed processes have no outcome and are excluded.' },
  { name: 'Distillation failure rate (%)', display: 'scalar', sql: `SELECT round(100 * ${distillSum('failed')} / nullif(${distillSum('attempts')}, 0), 1) AS failure_percent FROM v_latest_installs`, description: 'Failed whole runs / all instrumented runs. Provider retries that eventually succeed are not failed runs. Older completions without instrumentation are excluded.' },
  { name: 'Failed distillation runs', display: 'scalar', sql: `SELECT ${distillSum('failed')} AS failed_runs FROM v_latest_installs` },
  { name: 'Distillation measurement coverage', display: 'table', sql: `SELECT count(*) FILTER (WHERE raw_json #>> '{distillation,schemaVersion}' = '1') AS installations_with_instrumentation, ${distillSum('attempts')} AS measured_runs, ${distillSum('legacySuccessfulRuns')} AS older_completions_without_outcomes, ${distillSum('durationSamples')} AS timed_runs, ${distillSum('costKnownCalls')} AS model_calls_with_cost, ${distillSum('costUnknownCalls')} AS model_calls_without_cost, ${distillSum('modelFailedCalls')} AS failed_model_attempts FROM v_latest_installs` }
];
performanceQuestions.push(...costQuestions);
const questions = [...diagnosticQuestions, ...performanceQuestions];
const performanceCardNames = [...performanceQuestions.map(q => q.name), 'Note assessments · latest snapshots', 'Savings estimates · latest snapshots'];

const filterDefs = [
  ['platform', 'Platform', "coalesce(platform, 'unknown')"],
  ['version', 'Version', "coalesce(version, 'unknown')"],
  ['device_id', 'Device ID', "coalesce(device_id, 'Unknown')"],
  ['event', 'Report type', "CASE WHEN event IS NULL OR event IN ('undefined', '') THEN 'Unknown' ELSE event END"]
];
function dataset(question, database) {
  const where = 'WHERE 1=1 ' + filterDefs.map(([id, , expression]) => `[[AND ${expression} = {{${id}}}]]`).join(' ');
  const ctes = ['v_latest_installs', 'v_latest_devices', 'reports'].map(table => `filtered_${table} AS (SELECT * FROM ${table} ${where})`).join(', ');
  let sql = question.sql;
  if (question.name === 'Note kinds · latest snapshots') sql = "SELECT k.key AS kind, sum(k.value::bigint) AS total_notes FROM v_latest_installs CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(raw_json #> '{cacheSize,kinds}') = 'object' THEN raw_json #> '{cacheSize,kinds}' ELSE '{}'::jsonb END) k GROUP BY 1 ORDER BY 2 DESC";
  sql = sql.replace(/\b(FROM|JOIN)\s+(v_latest_installs|v_latest_devices|reports)\b/gi, '$1 filtered_$2');
  return { database, type: 'native', native: { query: `WITH ${ctes}\n${sql}`, 'template-tags': Object.fromEntries(filterDefs.map(([id, name]) =>
    [id, { id, name: id, 'display-name': name, type: 'text', required: false }])) } };
}
function mappings(cardId) { return filterDefs.map(([id]) => ({ parameter_id: id, card_id: cardId, target: ['variable', ['template-tag', id]] })); }

async function provision() {
  const properties = await api('/session/properties');
  if (properties['setup-token']) {
    const result = await api('/setup', 'POST', { token: properties['setup-token'],
      user: { first_name: 'Thinker', last_name: 'Admin', email: state.email, password: state.password },
      prefs: { site_name: 'Thinker metrics', allow_tracking: false } });
    session = result.id;
  } else session = (await api('/session', 'POST', { username: state.email, password: state.password })).id;

  const secret = JSON.parse(JSON.parse(execFileSync('aws', ['--profile', 'yoav', '--region', 'us-east-1',
    'secretsmanager', 'get-secret-value', '--secret-id', 'thinker/metrics/reader', '--output', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).SecretString);
  const database = { name: 'Thinker telemetry (read-only)', engine: 'postgres', is_full_sync: false,
    details: { host, port: tunnelPort, dbname: secret.dbname, user: secret.username, password: secret.password,
      ssl: true, 'ssl-mode': 'verify-full', 'additional-options': 'sslmode=verify-full&sslrootcert=/certs/rds.pem' } };
  const databases = await api('/database');
  const existing = (databases.data || databases).find(db => db.name === database.name);
  const db = existing ? await api(`/database/${existing.id}`, 'PUT', database) : await api('/database', 'POST', database);
  state.databaseId = db.id; save();

  const test = await api('/dataset', 'POST', { database: db.id, type: 'native',
    native: { query: "SELECT current_user, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls, count(*) AS reports FROM reports", 'template-tags': {} } });
  if (test.status !== 'completed' || test.data.rows[0][1] !== true || test.data.rows[0][0] !== secret.username) {
    throw new Error('Read-only telemetry connection/TLS verification failed');
  }
  console.log(`Read-only TLS query passed: ${test.data.rows[0][2]} reports.`);
  if (!state.collectionId) {
    state.collectionId = (await api('/collection', 'POST', { name: 'Thinker metrics', description: 'Live PostgreSQL queries. Installation IDs are not people; historical reports may include test data.' })).id;
    save();
  }
  state.cards ||= {};
  for (const question of questions) {
    const existingId = state.cards[question.name];
    if (existingId && state.cardVersion === 4) continue;
    const card = await api(existingId ? `/card/${existingId}` : '/card', existingId ? 'PUT' : 'POST', { name: question.name, display: question.display, description: question.description || null,
      collection_id: state.collectionId, visualization_settings: question.settings || {},
      dataset_query: dataset(question, db.id) });
    state.cards[question.name] = card.id; save();
  }
  state.cardVersion = 4; save();
  if (!state.dashboardId) {
    state.dashboardId = (await api('/dashboard', 'POST', { name: 'Thinker telemetry', collection_id: state.collectionId,
      description: 'Live reports, installation activity, and data quality. Installation IDs are not people. Older telemetry may contain test data. Usage fields are rolling snapshots; do not sum all reports.' })).id;
    save();
  }
  if (!state.diagnosticsId) {
    state.diagnosticsId = (await api('/dashboard', 'POST', { name: 'Telemetry diagnostics', collection_id: state.collectionId,
      description: 'A report is one telemetry upload, usually covering the prior 24 hours. Uploads and installation IDs are not user counts. These tables help inspect data coverage and potential test fixtures.' })).id;
    save();
  }
  if (!state.waitlistId) {
    state.waitlistId = (await api('/dashboard', 'POST', { name: 'Waitlist', collection_id: state.collectionId,
      description: 'Email addresses submitted to the Thinker waitlist, with first and latest signup times. Export the table to CSV using its download menu.' })).id;
    save();
  }
    const filterValues = await api('/dataset', 'POST', { database: db.id, type: 'native', native: {
      query: "SELECT DISTINCT platform, version, coalesce(device_id, 'Unknown') AS device_id, CASE WHEN event IS NULL OR event IN ('undefined', '') THEN 'Unknown' ELSE event END AS event FROM reports", 'template-tags': {} } });
    if (filterValues.status !== 'completed') throw new Error('Could not load dashboard filter choices');
    const parameters = filterDefs.map(([id, name], index) => ({ id, name, slug: id, type: 'string/=',
      isMultiSelect: false, sectionId: 'string', values_query_type: 'list', values_source_type: 'static-list',
      values_source_config: { values: [...new Set(filterValues.data.rows.map(row => row[index] ?? 'unknown'))].sort().map(value => [value, value]) } }));
  if (state.dashboardVersion !== 4) {
    const cards = [{ id: -1, row: 0, col: 0, size_x: 24, size_y: 3, card_id: null,
      visualization_settings: { virtual_card: { display: 'text' }, text: '## Thinker overview\nLive PostgreSQL data · read-only connection · use the refresh control for the latest reports.\n\n**Read these totals carefully:** Installation IDs are not people. Historical reports may include test data. Usage, cache, learning, and savings cards sum the latest snapshot per installation; they are not lifetime totals and may overlap across installations on the same device. Savings are estimates. Missing device IDs are unknown, not zero users.' } }];
    let row = 7, col = 0;
    diagnosticQuestions.slice(0, -1).forEach((q, i) => {
      if (i < 4) {
        cards.push({ id: -(i + 2), card_id: state.cards[q.name], row: 3, col: i * 6, size_x: 6, size_y: 4, parameter_mappings: [] });
        return;
      }
      if (q.fullWidth && col) { row += 8; col = 0; }
      cards.push({ id: -(i + 2), card_id: state.cards[q.name], row, col, size_x: q.fullWidth ? 24 : 12, size_y: 8, parameter_mappings: [] });
      if (q.fullWidth || col) { row += 8; col = 0; } else col = 12;
    });
    for (const card of cards) if (card.card_id) card.parameter_mappings = mappings(card.card_id);
    await api(`/dashboard/${state.diagnosticsId}`, 'PUT', { dashcards: cards, parameters });
    const performanceCards = [];
    const text = (row, height, content) => performanceCards.push({ id: -(performanceCards.length + 1), card_id: null,
      row, col: 0, size_x: 24, size_y: height, visualization_settings: { virtual_card: { display: 'text' }, text: content } });
    const metric = (name, row, col, width, height) => performanceCards.push({ id: -(performanceCards.length + 1),
      card_id: state.cards[name], row, col, size_x: width, size_y: height, parameter_mappings: mappings(state.cards[name]) });
    text(0, 4, `## Cache & distillation performance\nEach metric uses the latest daily activity snapshot from each installation. These are snapshots, not lifetime totals.\n\n**Data quality:** Current telemetry contains patterns matching test fixtures. The values below include that data and should not be treated as validated production performance. Installations may overlap on the same machine. [Inspect data quality](/dashboard/${state.diagnosticsId}).`);
    text(4, 2, '## Is the cache helping?\nA hit means notes were returned. Confirmed usefulness means the distiller saw the agent use the note without a contradiction.');
    performanceQuestions.slice(0, 4).forEach((q, i) => metric(q.name, 6, i * 6, 6, 4));
    metric('Cache requests with and without a hit', 10, 0, 12, 7);
    metric('Note assessments · latest snapshots', 10, 12, 12, 7);
    metric('Savings estimates · latest snapshots', 17, 0, 24, 6);
    text(23, 3, '## Is distillation producing knowledge?\nDistillation turns agent sessions into reusable notes. A session can be processed in several runs. Note changes per run measures output, not speed or accuracy.');
    performanceQuestions.slice(5, 9).forEach((q, i) => metric(q.name, 26, i * 6, 6, 4));
    metric('Distillation output by installation', 30, 0, 24, 8);
    text(38, 3, '## Distillation cost, duration & reliability\nAvailable from updated clients. Older uploads show no value. Reported cost includes retries and may be partial when a model provider does not return prices. Failure rate covers whole instrumented runs; abrupt process kills cannot report an outcome.');
    costQuestions.slice(0, 4).forEach((q, i) => metric(q.name, 41, i * 6, 6, 4));
    metric('Distillation measurement coverage', 45, 0, 24, 7);
    text(52, 3, `Filters apply to the latest snapshot per installation for performance cards; they do not select a historical snapshot of a previous version. Device ID **Unknown** means the client did not send an ID.\n\nA **report** is a telemetry upload: install, daily activity update, waitlist signup, or Unknown for older untyped uploads. [View all waitlist emails](/dashboard/${state.waitlistId}) · [Inspect uploads and data quality](/dashboard/${state.diagnosticsId}). Cache response latency and measured end-to-end speedup are not collected.`);
    await api(`/dashboard/${state.dashboardId}`, 'PUT', { name: 'Cache & distillation performance',
      description: 'Cache hit rate, usefulness, estimated savings, distillation output, cost, duration and failures. Latest installation snapshots; historical telemetry may contain test data. New measurements require updated clients.', dashcards: performanceCards, parameters });
    const waitlistCard = state.cards['Waitlist emails'];
    await api(`/dashboard/${state.waitlistId}`, 'PUT', { parameters, dashcards: [{ id: -1, card_id: waitlistCard,
      row: 0, col: 0, size_x: 24, size_y: 12, parameter_mappings: mappings(waitlistCard) }] });
    state.dashboardVersion = 4; save();
  } else {
    // Refresh choices for new device IDs/versions without rearranging user cards.
    for (const id of [state.dashboardId, state.diagnosticsId, state.waitlistId]) {
      const dashboard = await api(`/dashboard/${id}`);
      await api(`/dashboard/${id}`, 'PUT', { parameters: [...parameters,
        ...dashboard.parameters.filter(p => !filterDefs.some(([key]) => key === p.id))] });
    }
  }
  console.log(`Dashboard: http://localhost:3030/dashboard/${state.dashboardId}`);
  console.log(`Waitlist: http://localhost:3030/dashboard/${state.waitlistId}`);
  console.log(`SQL editor: http://localhost:3030/question#?db=${db.id}&type=native`);
  console.log(`Login: ${state.email}\nPassword: stored in ${stateFile} (password field).`);
}

async function verify() {
  session = (await api('/session', 'POST', { username: state.email, password: state.password })).id;
  const dashboard = await api(`/dashboard/${state.dashboardId}`);
  for (const [id] of filterDefs) {
    if (!dashboard.parameters.some(p => p.id === id)) throw new Error(`Missing dashboard filter: ${id}`);
    if (dashboard.dashcards.some(card => card.card_id && !card.parameter_mappings.some(p => p.parameter_id === id))) {
      throw new Error(`Unmapped dashboard filter: ${id}`);
    }
    const result = await api(`/card/${state.cards['Installation IDs (not people)']}/query`, 'POST', {
      parameters: [{ id, type: 'string/=', target: ['variable', ['template-tag', id]], value: ['__thinker_no_matching_value__'] }]
    });
    if (result.status !== 'completed' || result.data.rows[0][0] !== 0) throw new Error(`Filter did not restrict data: ${id}`);
  }
  console.log('PASS: platform, version, device ID, and report-type filters restrict results.');
  if (performanceCardNames.some(name => !dashboard.dashcards.some(card => card.card_id === state.cards[name]))) {
    throw new Error('Starter dashboard is missing cards');
  }
  for (const [name, id] of Object.entries(state.cards)) {
    const result = await api(`/card/${id}/query`, 'POST', {});
    if (result.status !== 'completed') throw new Error(`Saved query failed: ${name}`);
    console.log(`PASS: ${name} (${result.data.rows.length} rows)`);
  }
  const privileges = await api('/dataset', 'POST', { database: state.databaseId, type: 'native', native: {
    query: "SELECT current_user, has_table_privilege(current_user, 'public.reports', 'SELECT') AS can_read, has_table_privilege(current_user, 'public.reports', 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls", 'template-tags': {} } });
  const row = privileges.data?.rows?.[0];
  if (privileges.status !== 'completed' || !row?.[1] || row[2] || !row[3]) throw new Error('Read-only/TLS privileges check failed');
  console.log('PASS: read-only database privileges, TLS, and all dashboard queries.');
}

async function main() {
  const command = process.argv[2] || 'start';
  if (!['start', 'stop', 'status', 'login', 'verify', 'tunnel'].includes(command)) throw new Error('Usage: node scripts/metrics-dashboard.mjs [start|stop|status|login|verify|tunnel]');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  fs.chmodSync(work, 0o700);
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile));
  else {
    if (command !== 'start' && command !== 'tunnel') throw new Error('Dashboard has not been set up. Run start first.');
    state = { email: 'admin@thinker.local', password: randomBytes(24).toString('base64url') + 'aA1!',
      dbPassword: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') }; save();
  }
  if (command === 'stop') { console.log(compose('stop')); return; }
  if (command === 'status') { console.log(compose('ps')); return; }
  if (command === 'login') { console.log(`Email: ${state.email}\nPassword: ${state.password}`); return; }
  if (command === 'verify') { await verify(); return; }
  if (command === 'tunnel') {
    if (await listening()) { console.log(`Private RDS tunnel is already listening on port ${tunnelPort}.`); return; }
    await tunnel();
    return;
  }
  await tunnel();
  console.log('Starting local Metabase and its dashboard storage…');
  compose('up', '-d');
  const cert = await fetch('https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem', { signal: AbortSignal.timeout(30000) });
  if (!cert.ok) throw new Error('Could not download RDS CA certificate');
  const certPath = path.join(work, 'rds.pem');
  fs.writeFileSync(certPath, await cert.text());
  execFileSync('docker', ['cp', certPath, compose('ps', '-q', 'metabase') + ':/certs/rds.pem'], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await api('/health')).status === 'ok') { ready = true; break; } } catch {}
    if (i % 15 === 0) console.log('Waiting for Metabase startup…');
    await delay(2000);
  }
  if (!ready) throw new Error('Metabase did not become healthy; inspect Docker container logs.');
  await provision();
}
main().catch(error => {
  // Child-process errors can include credentials: never echo their argv/output.
  console.error(error.cmd || error.spawnargs ? 'External command failed; check Docker, AWS login, and tunnel status.' : error.message);
  process.exitCode = 1;
});
