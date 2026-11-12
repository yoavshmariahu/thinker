// Repository state with machine-wide records shared by every checkout. Keep a single undo/history
// record for a tool switch even when the tool appears in many repositories' reports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { thinkerHome } from './update.js';
import { isTestMode } from './test-mode.js';

const baseline = Symbol('shared records read');
const key = x => x.id || `${x.client || 'claude'}:${x.key}`;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
// A test run with no THINKER_HOME of its own gets a machine of its own under the run's temp directory, kept in
// the environment so the children a test spawns share it: with the real home, a test's approval of a tool switch
// left a machine-wide decision in ~/.thinker that every later run's Recent activity, report and telemetry read
// (2026-11-11, a dozen failures from one stray Artifact record). The three other machine-wide files in test mode
// (update note, notice cadence, savings ledger) stay off instead; machine actions are what the tests exercise.
export const machineDir = () => {
  if (!process.env.THINKER_HOME && isTestMode()) {
    process.env.THINKER_TEST_MACHINE ||= path.join(os.tmpdir(), `thinker-machine-${process.pid}`);
    return process.env.THINKER_TEST_MACHINE;
  }
  return path.join(thinkerHome(), 'state', 'machine-actions');
};
const sharedFile = file => path.join(machineDir(), path.basename(file));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
};
export function readScopedState(file, field) {
  const local = read(file), shared = read(sharedFile(file));
  const records = [...(local[field] || []), ...(shared[field] || [])];
  const state = records.length ? { ...local, [field]: records } : local;
  Object.defineProperty(state, baseline, { value: structuredClone(shared[field] || []) });
  return state;
}
export function writeScopedState(file, field, state) {
  const machine = (state[field] || []).filter(x => x.scope === 'machine');
  const local = (state[field] || []).filter(x => x.scope !== 'machine');
  // An async action may have read its state before another repository finished an action. Only
  // replace records this caller changed, preserving shared records added in the meantime.
  const before = new Map((state[baseline] || []).map(x => [key(x), x]));
  const after = new Map(machine.map(x => [key(x), x]));
  const current = new Map((read(sharedFile(file))[field] || []).map(x => [key(x), x]));
  let changed = false;
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(k)) === JSON.stringify(after.get(k))) continue;
    changed = true;
    if (after.has(k)) current.set(k, after.get(k)); else current.delete(k);
  }
  if (changed) write(sharedFile(file), { [field]: [...current.values()] });
  const next = { ...state, [field]: local };
  if (state[field] === undefined && !local.length) delete next[field];
  write(file, next);
}
export const machineUndoDir = () => path.join(machineDir(), 'undo');
