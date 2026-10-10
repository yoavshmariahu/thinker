import { isTestMode } from './test-mode.js';
// Hourly telemetry for Thinker: collects high-level cache effectiveness and cache size metrics.
// Pseudonymous: no prompt text, note bodies, file paths, code symbols,
// or repository URLs are ever collected or transmitted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome, DAY_MS } from './update.js';
import { summarize, readLog, holdoutOf } from './usage.js';
import { Store, findRepoRoot } from './store.js';
import { getDeviceId } from './device.js';
import { detectClients } from './clients.js';
import { deliveryMetrics } from './delivery-telemetry.js';

export const HOUR_MS = 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://khsky10r4l.execute-api.us-east-1.amazonaws.com/metrics';

export function isTestTelemetryBlocked(endpoint, env = process.env) {
  if (!isTestMode(env) && !env.NODE_TEST_CONTEXT) return false;
  try {
    const url = new URL(endpoint);
    return !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return true; }
}

export function isTelemetryEnabled({ home = thinkerHome(), store } = {}) {
  const envVal = (process.env.THINKER_TELEMETRY || '').toLowerCase();
  if (envVal === 'off' || envVal === '0' || envVal === 'false') return false;
  if (process.env.THINKER_NO_TELEMETRY === '1') return false;
  if (process.env.THINKER_NO_LEARN === '1') return false;

  // Check repo-level config if store provided
  if (store) {
    try {
      const cfg = store.config();
      if (cfg && cfg.telemetry === false) return false;
    } catch {}
  }

  // Check global install config
  try {
    const installJson = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
    if (installJson.telemetry === false) return false;
  } catch {}

  return true;
}

export function getTelemetryEndpoint({ home = thinkerHome() } = {}) {
  if (process.env.THINKER_TELEMETRY_URL) return process.env.THINKER_TELEMETRY_URL.trim();
  try {
    const installJson = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
    if (installJson.telemetryUrl) return installJson.telemetryUrl.trim();
  } catch {}
  return DEFAULT_TELEMETRY_ENDPOINT;
}

export function getInstallId(home = thinkerHome()) {
  const idFile = path.join(home, 'state', 'install-id');
  try {
    if (fs.existsSync(idFile)) {
      const id = fs.readFileSync(idFile, 'utf8').trim();
      if (id) return id;
    }
  } catch {}

  const newId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, newId + '\n');
  } catch {}
  return newId;
}

export function computeCacheMetrics(store, { home = thinkerHome(), all = true } = {}) {
  const summary = summarize(store, { days: 1, all });
  const kinds = {};
  const statuses = { fresh: 0, stale: 0, invalid: 0 };
  const sources = {};
  const confidenceBuckets = { high: 0, medium: 0, low: 0 };
  let totalDeps = 0;
  let symbolDeps = 0;
  let totalBytes = 0;
  let totalNotes = summary.notes || 0;
  let repositoriesCount = (summary.repos || []).length;
  const coveredCheckouts = new Set();

  const recordNote = n => {
    const k = n.kind || 'other';
    kinds[k] = (kinds[k] || 0) + 1;
    const bodyBytes = Buffer.byteLength(n.body || '', 'utf8');
    const titleBytes = Buffer.byteLength(n.title || '', 'utf8');
    totalBytes += bodyBytes + titleBytes;

    const st = n.status || 'fresh';
    statuses[st] = (statuses[st] || 0) + 1;

    const src = n.source?.type || 'unknown';
    sources[src] = (sources[src] || 0) + 1;

    const conf = typeof n.confidence === 'number' ? n.confidence : 0.8;
    if (conf >= 0.8) confidenceBuckets.high++;
    else if (conf >= 0.5) confidenceBuckets.medium++;
    else confidenceBuckets.low++;

    for (const d of n.deps || []) {
      totalDeps++;
      if (d.symbol) symbolDeps++;
    }
  };

  // Aggregate across all repositories on the machine
  for (const r of summary.repos || []) {
    for (const checkout of r.checkouts || []) {
      coveredCheckouts.add(path.resolve(checkout));
      const s = new Store(checkout, { readonly: true });
      if (!s.exists()) continue;
      try {
        const notes = s.list();
        for (const n of notes) recordNote(n);
      } catch {}
    }
  }

  // If local store has notes and wasn't covered in summary.repos
  if (store?.exists() && (!coveredCheckouts.size || !coveredCheckouts.has(path.resolve(store.repo)))) {
    try {
      const notes = store.list();
      if (notes.length > 0) {
        if (!coveredCheckouts.has(path.resolve(store.repo))) {
          repositoriesCount++;
          totalNotes += notes.length;
        }
        for (const n of notes) recordNote(n);
      } else if (!repositoriesCount) {
        repositoriesCount = 1;
      }
    } catch {}
  }

  return {
    totalNotes,
    totalBytes,
    repositoriesCount,
    kinds,
    statuses,
    sources,
    confidenceBuckets,
    symbolDepRatio: totalDeps > 0 ? Math.round((symbolDeps / totalDeps) * 1000) / 1000 : 0,
  };
}

// The holdout comparison (usage.js:holdoutOf) over the last 30 days, as sums and session counts per
// side, so that averages can be pooled across installations (a mean of sums over counts; medians
// cannot be combined). Numbers and model names only. A repository that opted out of telemetry is
// left out even when another repository triggers the upload.
export const HOLDOUT_WINDOW_DAYS = 30;
export function holdoutMetrics(store, { all = true, now = Date.now() } = {}) {
  const since = new Date(now - HOLDOUT_WINDOW_DAYS * DAY_MS).toISOString();
  const events = readLog(store, { all }).filter(e => e.t >= since);
  const off = new Set(), seen = new Set();   // by origin: one opted-out checkout excludes its repository
  for (const e of events) {
    if (seen.has(e.repo)) continue;
    seen.add(e.repo);
    try { if ((e.repo === store.repo ? store : new Store(e.repo, { readonly: true })).config().telemetry === false) off.add(e.origin); } catch {}
  }
  const h = holdoutOf(events.filter(e => !off.has(e.origin)));
  const side = t => ({ sessions: t.sessions, sums: t.sums, measured: t.measured });
  const pair = g => ({ served: side(g.served), heldOut: side(g.heldOut) });
  return {
    schemaVersion: 1, windowDays: HOLDOUT_WINDOW_DAYS,
    ...pair(h), noNotes: h.noNotes, unmeasured: h.unmeasured,
    byModel: Object.fromEntries(Object.entries(h.byModel).map(([m, g]) => [m, pair(g)])),
  };
}

export function buildTelemetryPayload(store, { home = thinkerHome(), days = 1, all = true, event = 'hourly' } = {}) {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {}

  const u = summarize(store, { days, all });
  const cacheSize = computeCacheMetrics(store, { home, all });
  const d = u.distillationPerformance, spend = d.spending;
  const cls = u.clients || {};
  const ret = u.retrieval || {};

  const totalAssessed = (u.assessed.confirmed || 0) + (u.assessed.contradicted || 0) + (u.assessed.unused || 0);
  const confirmationRate = totalAssessed > 0
    ? Math.round(((u.assessed.confirmed || 0) / totalAssessed) * 1000) / 1000
    : 0;

  const hitRate = u.requests > 0
    ? Math.round(((u.answered || 0) / u.requests) * 1000) / 1000
    : 0;

  return {
    installId: getInstallId(home),
    deviceId: getDeviceId(),
    event,
    version,
    platform: process.platform,
    timestamp: new Date().toISOString(),
    periodHours: (days || 1) * 24,

    cacheSize,

    // 30-day outcome snapshots, regardless of the usage snapshot periodHours.
    delivery: deliveryMetrics(store, { all }),

    // Sessions served notes against sessions held out, 30 days (holdoutMetrics).
    holdout: holdoutMetrics(store, { all }),

    // Explicit coverage keeps old logs and unsupported provider costs unknown.
    // SQL dashboards read this versioned block from reports.raw_json.
    distillation: {
      schemaVersion: 1,
      attempts: d.attempts, succeeded: d.succeeded, failed: d.failed,
      durationMs: d.durationMs, durationSamples: d.durationSamples,
      legacySuccessfulRuns: Math.max(0, u.distillation.runs - d.succeeded),
      noNewNotes: u.distillation.noNewNotes, noChanges: u.distillation.noChanges,
      modelCalls: spend.calls, modelFailedCalls: spend.failed,
      reportedCostUsd: spend.calls > 0 && spend.calls === spend.unknownCostCalls ? null : spend.reportedCost,
      costKnownCalls: spend.calls - spend.unknownCostCalls, costUnknownCalls: spend.unknownCostCalls,
      reportedTokens: spend.calls > 0 && spend.calls === spend.unknownTokenCalls ? null : spend.totalTokens,
      tokenKnownCalls: spend.calls - spend.unknownTokenCalls, tokenUnknownCalls: spend.unknownTokenCalls,
    },

    clients: {
      schemaVersion: 1,
      detected: detectClients(),
      activeRequests: cls.active || {},
      servings: cls.servings || {},
      sessions: cls.sessions || {},
    },

    retrieval: {
      schemaVersion: 1,
      requestsTotal: u.requests,
      requestsAnswered: u.answered,
      hitRate,
      emptyRequests: Math.max(0, u.requests - u.answered),
      staleNotesServed: ret.staleServed || 0,
      freshNotesServed: ret.freshServed || 0,
      staleServingRate: ret.staleRate || 0,
      guardTriggeredCount: ret.guardTriggered || 0,
      guardUncoveredTerms: ret.guardUncoveredTerms || 0,
      durationMs: ret.durationMs || 0,
      durationSamples: ret.durationSamples || 0,
      averageDurationMs: (ret.durationSamples || 0) > 0
        ? Math.round(ret.durationMs / ret.durationSamples)
        : null,
      servedByKind: ret.servedByKind || {},
    },

    effectiveness: {
      requestsTotal: u.requests,
      requestsAnswered: u.answered,
      hitRate,
      servings: {
        prompt: u.servings.prompt,
        file: u.servings.file,
        lookup: u.servings.lookup,
      },
      tokensServed: u.tokensServed,
      assessed: {
        confirmed: u.assessed.confirmed,
        contradicted: u.assessed.contradicted,
        unused: u.assessed.unused,
        pending: u.assessed.pending,
        confirmationRate,
      },
      estimatedSavings: {
        callsAvoided: u.saved.calls,
        tokensAvoided: u.saved.tokens,
        netTokensSaved: u.saved.net,
      },
      feedback: {
        useful: u.feedback.useful,
        notUseful: u.feedback.notUseful,
        corrections: u.corrections,
      },
      lifecycle: {
        sessionsDistilled: u.learned.sessions,
        newNotes: u.learned.notes,
        notesMerged: u.learned.merged,
        prsMined: u.learned.prs,
        staleVerified: (u.verified.still_valid || 0) + (u.verified.update || 0) + (u.verified.invalid || 0),
      },
    },
  };
}

export async function sendTelemetry({
  home = thinkerHome(),
  store = new Store(findRepoRoot()),
  endpoint = getTelemetryEndpoint({ home }),
  fetchFn = globalThis.fetch,
  force = false,
  dryRun = false,
  event = 'hourly',
  intervalMs = HOUR_MS,
} = {}) {
  if (!isTelemetryEnabled({ home, store })) {
    return { sent: false, reason: 'disabled' };
  }
  if (!dryRun && fetchFn === globalThis.fetch && isTestTelemetryBlocked(endpoint)) {
    return { sent: false, reason: 'test_environment' };
  }

  const stampFile = path.join(home, 'state', 'telemetry.last');
  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      const minInterval = Math.max(0, intervalMs - 60_000);
      if (Date.now() - st.mtimeMs < minInterval) {
        return {
          sent: false,
          reason: intervalMs >= DAY_MS ? 'already_sent_today' : 'already_sent_recently',
          lastSent: new Date(st.mtimeMs).toISOString(),
        };
      }
    } catch {}
  }

  const payload = buildTelemetryPayload(store, { home, days: 1, all: true, event });

  if (dryRun) {
    return { sent: true, dryRun: true, endpoint, payload };
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'thinker-cli',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { sent: false, status: res.status, error: `HTTP ${res.status}` };
    }

    let result = {};
    try { result = await res.json(); } catch {}

    try {
      fs.mkdirSync(path.dirname(stampFile), { recursive: true });
      fs.writeFileSync(stampFile, new Date().toISOString() + '\n');
    } catch {}

    return { sent: true, status: res.status, key: result.key, payload };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

export function maybeSendTelemetryInBackground({
  home = thinkerHome(),
  cliPath = path.join(HERE, 'cli.js'),
  store,
  force = false,
  event = 'hourly',
  intervalMs = HOUR_MS,
} = {}) {
  if (isTestMode() || !isTelemetryEnabled({ home, store })) return;
  if (isTestTelemetryBlocked(getTelemetryEndpoint({ home }))) return;
  if (process.env.THINKER_IN_LLM) return;
  if (process.env.THINKER_BACKGROUND_UPDATE || process.env.THINKER_BACKGROUND_TELEMETRY) return;

  const stateDir = path.join(home, 'state');
  const stampFile = path.join(stateDir, 'telemetry.last');

  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      const minInterval = Math.max(0, intervalMs - 60_000);
      if (Date.now() - st.mtimeMs < minInterval) return;
    } catch {}
  }

  try {
    const args = ['telemetry', '--background', '--quiet'];
    if (store?.repo) args.push('--repo', store.repo);
    if (force) args.push('--force');
    if (event) args.push('--event', event);
    const child = spawn(process.execPath, [cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, THINKER_BACKGROUND_TELEMETRY: '1' },
    });
    child.unref();
  } catch {}
}

export const maybeSendDailyTelemetryInBackground = maybeSendTelemetryInBackground;

export function getTelemetryLaunchAgentPath(customPath) {
  return customPath || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.thinker.telemetry.plist');
}

export function isTelemetryScheduled(home = thinkerHome(), opts = {}) {
  if (process.platform === 'darwin') {
    const plist = opts.plistPath || getTelemetryLaunchAgentPath();
    if (!fs.existsSync(plist)) return false;
    if (opts.checkFileOnly) return true;
    try {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.includes('com.thinker.telemetry');
    } catch {
      return fs.existsSync(plist);
    }
  } else if (process.platform === 'linux') {
    try {
      const crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return crontab.includes('thinker') && crontab.includes('telemetry');
    } catch {
      return false;
    }
  }
  return false;
}

export function scheduleTelemetry(opts = {}) {
  const home = opts.home || thinkerHome();
  const binPath = opts.binPath || path.join(home, 'bin', 'thinker');
  const nodeBinDir = path.dirname(process.execPath);

  if (process.platform === 'darwin') {
    const plistPath = opts.plistPath || getTelemetryLaunchAgentPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });

    if (!opts.skipLaunchctl) {
      try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
    }

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thinker.telemetry</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>PATH="${nodeBinDir}:$PATH:/usr/local/bin:/opt/homebrew/bin" exec "${binPath}" telemetry --send --quiet</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardErrorPath</key>
    <string>${path.join(home, 'telemetry.err')}</string>
    <key>StandardOutPath</key>
    <string>${path.join(home, 'telemetry.out')}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent);

    if (!opts.skipLaunchctl) {
      try {
        const uid = process.getuid ? process.getuid() : 501;
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
      } catch {
        try {
          execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
        } catch (e) {
          throw new Error(`Failed to register LaunchAgent: ${e.message}`);
        }
      }
    }
    return { type: 'launchd', path: plistPath };
  } else if (process.platform === 'linux') {
    let crontab = '';
    try {
      crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}

    const line = `0 * * * * PATH="${nodeBinDir}:$PATH:/usr/local/bin" "${binPath}" telemetry --send --quiet`;
    if (!crontab.includes(line)) {
      const newCrontab = (crontab.trim() ? crontab.trim() + '\n' : '') + line + '\n';
      execFileSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    }
    return { type: 'cron', line };
  }

  throw new Error(`OS scheduler not supported on platform: ${process.platform}`);
}

export function unscheduleTelemetry(opts = {}) {
  const home = opts.home || thinkerHome();

  if (process.platform === 'darwin') {
    const plistPath = opts.plistPath || getTelemetryLaunchAgentPath();
    if (fs.existsSync(plistPath)) {
      if (!opts.skipLaunchctl) {
        try {
          const uid = process.getuid ? process.getuid() : 501;
          execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        } catch {
          try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
        }
      }
      try { fs.rmSync(plistPath, { force: true }); } catch {}
      return { unscheduled: true, type: 'launchd' };
    }
    return { unscheduled: false, type: 'launchd' };
  } else if (process.platform === 'linux') {
    try {
      const crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const filtered = crontab.split('\n').filter(l => !(l.includes('thinker') && l.includes('telemetry'))).join('\n').trim();
      if (filtered) {
        execFileSync('crontab', ['-'], { input: filtered + '\n', encoding: 'utf8' });
      } else {
        execFileSync('crontab', ['-r'], { stdio: 'ignore' });
      }
      return { unscheduled: true, type: 'cron' };
    } catch {
      return { unscheduled: false, type: 'cron' };
    }
  }

  return { unscheduled: false };
}

