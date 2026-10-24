// The Report page's figures, worked out ahead of time. reportView reads the machine's log and every session of the
// window: two seconds on this repository, a dozen repositories for All repositories, and the page did it again on
// every visit a minute apart. So the report is kept in the checkout's state (`.thinker/state/report-<weeks>.json`)
// and the page reads that: `thinker report` and `thinker report --refresh` write it (`--all` for every repository the
// page lists, in one process so the log is parsed once), and the page starts that in the background when what it
// read is older than REFRESH_MS or was made by other code. The decisions under the tables are not kept: the server
// reads them live (report.js:reportActions), so one taken on Find Savings a moment ago is in the window at once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reportView, REPORT_WEEKS } from './report.js';
import { stateTag } from './context-snapshot.js';

export const REFRESH_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// the readers behind the report: a snapshot made by other code is not this code's report
let codeKey;
const code = () => codeKey ||= crypto.createHash('sha256').update(['report.js', 'instruction-value.js', 'instruction-sections.js', 'harness.js', 'harness-codex.js', 'tool-outputs.js', 'transcripts.js', 'usage.js', 'prices.js', 'model-usage.js']
  .map(f => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return f; } }).join('\0')).digest('hex').slice(0, 16);

const file = (store, weeks) => path.join(store.dir, 'state', `report-${weeks}${stateTag(store)}.json`);
const lockFile = store => path.join(store.dir, 'state', `report${stateTag(store)}.lock`);

// { at, view, current } of the report kept, whether or not it still holds: `current` when this code made it less
// than REFRESH_MS ago; null when there is none
export function readReport(store, weeks = REPORT_WEEKS, { now = Date.now() } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file(store, weeks), 'utf8'));
    return s.view ? { at: s.at, view: s.view, current: s.code === code() && now - s.at <= REFRESH_MS } : null;
  } catch { return null; }
}

export function writeReport(store, weeks, view, { now = Date.now() } = {}) {
  const f = file(store, weeks), tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ at: now, weeks, code: code(), view }));
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
  let files = []; try { files = fs.readdirSync(path.join(store.dir, 'state')); } catch {}
  for (const f of files) if (new RegExp(`^report-\\d+${stateTag(store)}\\.json$`).test(f)) { try { fs.rmSync(path.join(store.dir, 'state', f), { force: true }); } catch {} }
}
