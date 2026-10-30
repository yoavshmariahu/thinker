// The Report page's figures, worked out ahead of time. reportView reads the machine's log and every session of the
// window: two seconds on this repository, a dozen repositories for All repositories, and the page did it again on
// every visit a minute apart. So the report is kept in the checkout's state (`.thinker/state/report-<weeks>.json`)
// and the page reads that: `thinker report` and `thinker report --refresh` write it (`--all` for every repository the
// page lists, in one process so the log is parsed once), and the page starts that in the background when what it
// read is older than REFRESH_MS or was made by other code. The decisions under the tables are not kept: the server
// reads them live (report.js:reportActions), so one taken on Find Savings a moment ago is in the window at once.
// One file per repository (`.thinker/state/report.json`, every window asked for under `views`): a linked worktree
// keeps its cache in the main checkout's .thinker and the sessions are gathered over every checkout, so every
// checkout reads and refreshes the same report (the owner's decision, 2026-10-24: worktrees are not a dimension).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reportView, withEffects, REPORT_WEEKS, promptAverage } from './report.js';

export const REFRESH_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// the readers behind the report: a snapshot made by other code is not this code's report
let codeKey;
const code = () => codeKey ||= crypto.createHash('sha256').update(['report.js', 'instruction-value.js', 'instruction-sections.js', 'harness.js', 'harness-codex.js', 'tool-outputs.js', 'transcripts.js', 'usage.js', 'prices.js', 'model-usage.js', 'delivery.js', 'compression.js']
  .map(f => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return f; } }).join('\0')).digest('hex').slice(0, 16);

export const reportFile = store => path.join(store.dir, 'state', 'report.json');
const lockFile = store => path.join(store.dir, 'state', 'report.lock');
const readFile = store => { try { const s = JSON.parse(fs.readFileSync(reportFile(store), 'utf8')); return s && typeof s.views === 'object' ? s : { views: {} }; } catch { return { views: {} }; } };

// { at, view, current } of the report kept for `weeks`, whether or not it still holds: `current` when this code made
// it less than REFRESH_MS ago; null when there is none
export function readReport(store, weeks = REPORT_WEEKS, { now = Date.now() } = {}) {
  const s = readFile(store).views[String(weeks)];
  return s?.view ? { at: s.at, view: s.view, current: s.code === code() && now - s.at <= REFRESH_MS } : null;
}

// the report for `weeks` written into the repository's file, the other windows kept as they are
export function writeReport(store, weeks, view, { now = Date.now() } = {}) {
  const f = reportFile(store), tmp = `${f}.${process.pid}.tmp`;
  try {
    const s = readFile(store);
    s.views[String(weeks)] = { at: now, code: code(), view };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, f);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return { at: now, view };
}

// The report of one window: the one kept when there is one, else made now and kept. `stale` says it should be made
// again in the background (old, or made by other code); what is kept is served meanwhile.
export function reportSnapshot(store, weeks = REPORT_WEEKS, { now = Date.now() } = {}) {
  const s = readReport(store, weeks, { now });
  if (s) return { at: s.at, view: s.view, stale: !s.current };
  return { ...writeReport(store, weeks, reportView(store, { weeks, now }), { now }), stale: false };
}

// `thinker report --refresh`: the report made again and kept; one run at a time per checkout
export function refreshReport(store, { weeks = REPORT_WEEKS, now = Date.now() } = {}) {
  const lock = lockFile(store);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch {}
  try { if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' }; fs.rmSync(lock, { force: true }); } catch {}
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return { skipped: 'locked' }; }
  try { writeReport(store, weeks, reportView(store, { weeks, now }), { now }); return { written: weeks }; }
  finally { fs.rmSync(lock, { force: true }); }
}

// whether a refresh is running in this checkout (the page says so and checks back)
export function refreshing(store, { now = Date.now() } = {}) {
  try { return now - fs.statSync(lockFile(store)).mtimeMs < LOCK_MS; } catch { return false; }
}

export function dropReports(store) {
  try { fs.rmSync(reportFile(store), { force: true }); } catch {}
}

// The session rows of the report kept here (report.js:reportView `sessionRows`), for the decisions' before and after: only
// from a report this code made, since another copy of thinker writing the same file (the installed one, from a hook, beside
// a worktree's: 2026-10-24, every row read "measuring" for an hour) leaves rows without what the effects need, or none.
// `stale`: the report should be made again (none, other code, or older than REFRESH_MS), which the page starts.
export function keptRows(store, { weeks = REPORT_WEEKS, now = Date.now() } = {}) {
  const s = readFile(store).views[String(weeks)];
  const mine = s?.view && s.code === code();
  return { rows: mine ? s.view.sessionRows || [] : [], stale: !mine || now - s.at > REFRESH_MS };
}

// The decisions with what each saved (report.js:actionEffect), read over the report kept here without making one: what
// Recent activity and `thinker context --history` show. With no report of this code's the effects are null.
export function historyEffects(store, history, { weeks = REPORT_WEEKS, now = Date.now() } = {}) {
  return withEffects(history, keptRows(store, { weeks, now }).rows, now);
}

// What a prompt costs on average here (report.js:promptAverage), over the report kept here; null without one of this code's.
export function promptAverageHere(store, { weeks = REPORT_WEEKS, now = Date.now() } = {}) {
  return promptAverage(keptRows(store, { weeks, now }).rows);
}
