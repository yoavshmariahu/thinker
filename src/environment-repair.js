// Persisted by the NEW rewire command: even an old updater that ignores its child's status leaves
// actionable evidence on the first upgrade. A successful later repair clears the failure.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export const repairFile = home => path.join(home, 'state', 'environment-repair.json');
export function recordRepair(home, result) {
  const file = repairFile(home);
  let previous; try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const restartRequired = !!(result.changed || result.connected?.length || previous?.restartRequired);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ ...result, restartRequired, at: new Date().toISOString() })); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function repairNotice(home, { includeRestart = false } = {}) {
  let result;
  try { result = JSON.parse(fs.readFileSync(repairFile(home), 'utf8')); } catch { return null; }
  if (!result.errors?.length) {
    if (!includeRestart || !result.restartRequired) return null;
    try { fs.writeFileSync(repairFile(home), JSON.stringify({ ...result, restartRequired: false })); } catch {}
    return 'agent environment repaired; restart open desktop apps to load changed host settings. Learning resumes on a later app prompt';
  }
  return `environment repair incomplete: ${result.errors.map(e => `${e.scope}: ${e.message}`).join('; ')}. Run thinker rewire to retry, or thinker doctor --fix to diagnose and repair.`;
}

export function repairAfterUpdate(newCli, { quiet, home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), spawnFn = spawnSync } = {}) {
  let summary = null, failure = null;
  try {
    const r = spawnFn(process.execPath, [newCli, 'rewire', '--json', '--quiet'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, THINKER_HOME: home, THINKER_TELEMETRY: process.env.THINKER_TELEMETRY || 'off' } });
    try { summary = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
    if (r.error || r.signal || r.status !== 0 || !summary || !Array.isArray(summary.files) || summary.errors?.length) {
      failure = r.error?.message || r.signal || summary?.errors?.map(e => `${e.scope}: ${e.message}`).join('; ') || String(r.stderr || '').trim() || `rewire exited ${r.status} without a valid repair report`;
    }
  } catch (e) { failure = e.message; }
  if (failure) {
    const result = { ok: false, errors: [{ scope: 'update', message: failure }] };
    try { recordRepair(home, result); } catch (e) { failure += `; cannot save repair status: ${e.message}`; }
    throw new Error(`Thinker code is installed, but environment repair failed: ${failure}. Run thinker rewire or thinker doctor --fix.`);
  }
  // Also clears a launch failure left by a previous attempt when updating an older target.
  recordRepair(home, { ...summary, ok: true, errors: [] });
  if (!quiet && summary.changed) process.stdout.write(`Repaired agent settings and hooks in ${summary.changed} location(s). Restart open desktop apps to load changed host settings.\n`);
  if (summary.connected?.length && !quiet) process.stdout.write(`Wired thinker into your own settings for ${summary.connected.join(', ')}; restart open desktop apps to load the new settings.\n`);
  return summary;
}
