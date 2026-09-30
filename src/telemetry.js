// Daily telemetry for Thinker: collects high-level cache effectiveness and cache size metrics.
// Pseudonymous: no prompt text, note bodies, file paths, code symbols,
// or repository URLs are ever collected or transmitted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome, DAY_MS } from './update.js';
import { summarize } from './usage.js';
import { Store, findRepoRoot } from './store.js';
import { getDeviceId } from './device.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://khsky10r4l.execute-api.us-east-1.amazonaws.com/metrics';

export function isTestTelemetryBlocked(endpoint, env = process.env) {
  if (env.THINKER_TEST !== '1' && !env.NODE_TEST_CONTEXT) return false;
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
  let totalBytes = 0;
  let totalNotes = summary.notes || 0;
  let repositoriesCount = (summary.repos || []).length;
  const coveredCheckouts = new Set();

  // Aggregate across all repositories on the machine
  for (const r of summary.repos || []) {
    for (const checkout of r.checkouts || []) {
      coveredCheckouts.add(path.resolve(checkout));
      const s = new Store(checkout);
      if (!s.exists()) continue;
      try {
        const notes = s.list();
        for (const n of notes) {
          const k = n.kind || 'other';
          kinds[k] = (kinds[k] || 0) + 1;
          const bodyBytes = Buffer.byteLength(n.body || '', 'utf8');
          const titleBytes = Buffer.byteLength(n.title || '', 'utf8');
          totalBytes += bodyBytes + titleBytes;
        }
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
        for (const n of notes) {
          const k = n.kind || 'other';
          kinds[k] = (kinds[k] || 0) + 1;
          const bodyBytes = Buffer.byteLength(n.body || '', 'utf8');
          const titleBytes = Buffer.byteLength(n.title || '', 'utf8');
          totalBytes += bodyBytes + titleBytes;
        }
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
  };
}

export function buildTelemetryPayload(store, { home = thinkerHome(), days = 1, all = true, event = 'daily' } = {}) {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {}

  const u = summarize(store, { days, all });
  const cacheSize = computeCacheMetrics(store, { home, all });
  const d = u.distillationPerformance, spend = d.spending;

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
  event = 'daily',
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
      if (Date.now() - st.mtimeMs < DAY_MS) {
        return { sent: false, reason: 'already_sent_today', lastSent: new Date(st.mtimeMs).toISOString() };
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

export function maybeSendDailyTelemetryInBackground({
  home = thinkerHome(),
  cliPath = path.join(HERE, 'cli.js'),
  store,
  force = false,
  event = 'daily',
} = {}) {
  if (!isTelemetryEnabled({ home, store })) return;
  if (isTestTelemetryBlocked(getTelemetryEndpoint({ home }))) return;
  if (process.env.THINKER_IN_LLM) return;
  if (process.env.THINKER_BACKGROUND_UPDATE || process.env.THINKER_BACKGROUND_TELEMETRY) return;

  const stateDir = path.join(home, 'state');
  const stampFile = path.join(stateDir, 'telemetry.last');

  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      if (Date.now() - st.mtimeMs < DAY_MS) return;
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
