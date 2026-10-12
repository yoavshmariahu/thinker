// Migrate existing installations as soon as the new CLI runs. Older updaters run
// `ranker fetch` from the staged release before swapping it in, then `rewire`.
// Always schedule the final installed path, never the temporary extraction path.
import fs from 'node:fs';
import path from 'node:path';
import { isTestMode } from './test-mode.js';
import { fileURLToPath } from 'node:url';
import { thinkerHome, DAY_MS } from './update.js';
import { isTelemetryEnabled, scheduleTelemetry } from './telemetry.js';

const statePath = home => path.join(home, 'state', 'telemetry-schedule.json');
export function telemetryScheduleState(home = thinkerHome()) {
  try { return JSON.parse(fs.readFileSync(statePath(home), 'utf8')); } catch { return {}; }
}
function save(home, state) {
  fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
  fs.writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n');
}
export function setTelemetryScheduleDisabled(disabled, home = thinkerHome()) {
  save(home, { disabled });
}

export function ensureTelemetryScheduled({
  home = thinkerHome(), rootDir, force = false,
  schedule = scheduleTelemetry, testMode = isTestMode(), now = Date.now(),
} = {}) {
  // Tests may exercise the migration only with a fake scheduler; no OS jobs.
  if ((testMode || isTestMode()) && schedule === scheduleTelemetry) return { skipped: 'test' };
  if (testMode || process.env.THINKER_IN_LLM || !isTelemetryEnabled({ home })) return { skipped: 'disabled' };
  const state = telemetryScheduleState(home);
  if (state.disabled) return { skipped: 'unscheduled' };
  const root = rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(fs.existsSync(path.join(root, '.git')) ? root : path.join(home, 'app'), 'src', 'cli.js');
  const key = JSON.stringify([1, process.execPath, cliPath, home]);
  // Check again daily (repair removed jobs) and when the executable moves. A
  // failed scheduler is retried on the next invocation, at most once an hour.
  if (!force && state.key === key && now - state.at < (state.error ? 3600_000 : DAY_MS)) return { ...state, cached: true };
  try {
    const result = schedule({ home, cliPath });
    const next = { key, at: now, type: result.type };
    save(home, next);
    return next;
  } catch (e) {
    const next = { key, at: now, error: e.message };
    save(home, next);
    return next;
  }
}

export function reportTelemetrySchedule(result, out = s => process.stderr.write(s + '\n')) {
  if (result.error && !result.cached) out(`thinker: hourly telemetry could not be scheduled: ${result.error}. Run \`thinker telemetry --schedule\` to retry.`);
}
