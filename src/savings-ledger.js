// What thinker has saved in dollars, for the footer surfaces: today, and over the whole log.
//
// The figures are the Report page's own savings table (report-savings.js:weeklySavings), asked for two
// windows instead of six weeks: one column from midnight, one from the beginning of the log. Both rows
// are counted -- the cache's avoided reading at each request's observed input mix, and the context
// clearing at the prompt-cache read rate -- so the footer can never disagree with `thinker report`.
// Nothing is priced here that is not priced there (the owner's call, 2026-11-05: the footer shows money,
// which the rest of the product deliberately does not, and the one way to keep that honest is to show
// the Report's own arithmetic rather than invent a second one). prices.js holds why dollars are rare:
// most agents run on a subscription, so this is an API-list-price equivalent of context that never had
// to be read, not a bill anybody was spared.
//
// Why a kept file rather than a figure worked out when asked: the full pass is a read of the machine's
// log (16 MB, 34k events here) and of every session the savings records name, about a second. The
// statusline is drawn as the person types and the hooks run on every turn, so neither may do that. The
// Stop hook starts a refresh in the background at most every REFRESH_MS (`thinker savings --refresh`),
// every surface reads this file, and a figure a few minutes old is the right trade for a footer.
//
// The ledger is the machine's, not a repository's, and sits beside the notice cadence under
// THINKER_HOME: lifetime means every checkout thinker has ever run in, which is what a person means by
// it. The suite must not write under the developer's home, so a test run with no THINKER_HOME of its
// own keeps it in the cache it is working in (notice-cadence.js does the same).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isTestMode } from './test-mode.js';
import { summarize, readLog } from './usage.js';
import { compressionRecords } from './compression.js';
import { proxyLogFile } from './proxy-service.js';
import { weeklySavings, SAVINGS_SERIES } from './report-savings.js';
import { formatDollars } from './prices.js';
import { formatTokens } from './model-usage.js';

export const REFRESH_MS = 10 * 60_000;
// A refresh that dies leaves its lock behind; another may start once the lock is this old.
const LOCK_MS = 5 * 60_000;

const ledgerHome = () => (isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'));
export const savingsFile = store => path.join(ledgerHome() || store.dir, 'state', 'savings.json');
const lockFile = store => path.join(ledgerHome() || store.dir, 'state', 'savings.lock');

// The day the person is in, in their own timezone: "today" on a footer means the day they are working
// through, so the window starts at local midnight and the stamp is the local date, never UTC's.
export const dayKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dayStart = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

const emptyCell = () => ({ cost: 0, tokens: 0, unpricedTokens: 0, cache: { cost: 0, tokens: 0 }, cleared: { cost: 0, tokens: 0 } });

// One window's two rows added up, and each kept beside the total: the split is what makes the total
// readable (clearing moves far more tokens than avoided reading, at a fortieth of its price), and the
// CLI and the cards show it. A row with observations but no price adds its tokens to `unpricedTokens`
// rather than nothing, so an unpriced model is a gap the output can name, not a silent zero.
function cellOf(series) {
  const out = emptyCell();
  for (const [key] of SAVINGS_SERIES) {
    const c = series.find(s => s.key === key)?.cells[0];
    if (!c) continue;
    const to = key === 'cache' ? out.cache : out.cleared;
    to.cost = c.cost; to.tokens = c.tokens;
    out.cost += c.cost; out.tokens += c.tokens; out.unpricedTokens += c.unpricedTokens || 0;
  }
  return out;
}

// The whole pass: the machine's log, the savings records of every repository in it, and the proxy's
// clearing records, bucketed into the two windows. Read-only.
//
// The two windows select servings differently, and that is deliberate (the owner's call, 2026-11-06,
// on this machine's own numbers): only 15% of the sessions that were ever served notes have been
// assessed at all, and of those the median session is assessed 72 minutes after its first serving,
// one in ten more than ten hours later. Confirmed-only, "today" would read $0 all morning and then
// show a fraction of the day. So today counts what the running session's own footer counts -- served,
// not yet judged, minus anything judged unused or contradicted -- while lifetime stays the confirmed
// estimate the Report page shows, and `thinker savings` says which is which.
export function computeSavings(store, { now = Date.now() } = {}) {
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  const cache = [], open = [];
  summarize(store, { all: true, now, onSaving: r => cache.push(r), onProvisional: r => open.push(r), provisionalSince: dayStart(now) });
  const events = readLog(store, { all: true });
  // The proxy's own log, as reportView reads it: a test with no home and no log of its own has none.
  const compression = process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME && !process.env.THINKER_PROXY_LOG
    ? [] : compressionRecords(proxyLogFile());
  // `origin: null` counts every repository's clearing: this is the machine's ledger, and a clear is not
  // attributed to a checkout here as it is in a repository's report. The clearing series is measured
  // either way -- the proxy reports what it took out -- so only the cache series differs by window.
  const windowOf = (from, records) => cellOf(weeklySavings({ columns: [{ t: from }], now, config, cache: records, events, compression, sessions: [], origin: null, ownership: events }));
  return {
    at: now, day: dayKey(now),
    today: windowOf(dayStart(now), open),
    lifetime: windowOf(0, cache),
    from: events[0]?.t || null,
  };
}

const read = store => { try { const s = JSON.parse(fs.readFileSync(savingsFile(store), 'utf8')); return s && s.lifetime && s.today ? s : null; } catch { return null; } };

// The kept ledger, with what the reader must know to word it: `sameDay` says the `today` figures are
// this day's and not a stamp left from yesterday, `current` that a refresh is not due yet.
export function readSavings(store, { now = Date.now() } = {}) {
  const s = read(store);
  if (!s) return null;
  return { ...s, sameDay: s.day === dayKey(now), current: s.day === dayKey(now) && now - s.at <= REFRESH_MS };
}

export function writeSavings(store, ledger) {
  const f = savingsFile(store), tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, f);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} } // a footer must never fail a turn
  return ledger;
}

export const savingsDue = (store, { now = Date.now() } = {}) => !readSavings(store, { now })?.current;

// Held while a refresh runs, so the Stop hooks of several sessions do not each start one.
function takeLock(store, { now = Date.now() } = {}) {
  const f = lockFile(store);
  try { if (now - fs.statSync(f).mtimeMs < LOCK_MS) return false; } catch {}
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(process.pid)); return true; } catch { return false; }
}
const dropLock = store => { try { fs.rmSync(lockFile(store), { force: true }); } catch {} };

export function refreshSavings(store, { now = Date.now(), force = false } = {}) {
  if (!force && !takeLock(store, { now })) return readSavings(store, { now });
  try { return writeSavings(store, computeSavings(store, { now })); }
  finally { if (!force) dropLock(store); }
}

// From a hook: recompute in the background when it is due, at most one process at a time. No model
// call and no network, so it runs the same way inside a desktop app, where no agent CLI is signed in.
export function refreshSavingsInBackground(store, { cli, now = Date.now() } = {}) {
  if (isTestMode() && process.env.THINKER_SAVINGS !== 'on') return false;
  if (!savingsDue(store, { now }) || !takeLock(store, { now })) return false;
  try {
    spawn(process.execPath, [cli, 'savings', '--refresh', '--quiet', '--repo', store.repo], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { dropLock(store); return false; }
}

// How the figures are worded, in one place, because five surfaces say them (the Claude Code statusline,
// the Codex desktop card, the Cursor table, the end-of-turn line and `thinker savings`).
//
// A ledger whose day has turned says nothing about today: the refresh it needs has not run, and a
// person who worked this morning would read a figure from yesterday as this morning's. Lifetime is
// still true, so that is said alone rather than the whole line being dropped.
export function savingsLine(ledger, { now = Date.now() } = {}) {
  if (!ledger?.lifetime) return '';
  const lifetime = ledger.lifetime.cost, today = ledger.today?.cost;
  if (!ledger.lifetime.tokens && !ledger.lifetime.unpricedTokens) return '';
  const sameDay = ledger.sameDay ?? ledger.day === dayKey(now);
  const parts = [];
  if (sameDay && Number.isFinite(today)) parts.push(`saved today ~${formatDollars(today)}`);
  parts.push(`lifetime ~${formatDollars(lifetime)}`);
  return parts.join(' · ');
}

// The statusline's own form: shorter, since it sits under the prompt beside everything else the
// session pins there, and named so it is read as thinker's and not the host's. The name in words, not
// the brain the rest of thinker's lines carry (the owner's ask, 2026-11-06): the status row is a line
// of small type beside the host's own, where a lone glyph is a puzzle and a word is a label.
export function savingsStatus(ledger, { now = Date.now() } = {}) {
  const line = savingsLine(ledger, { now });
  return line ? `thinker: ${line}` : '';
}

// The split, for `thinker savings` and the cards' detail: what each row contributed, and the tokens
// behind it, so a total nobody can check is never the only thing said.
export function savingsDetail(cell) {
  if (!cell) return '';
  const row = (name, c) => `${name} ~${formatDollars(c.cost)} (~${formatTokens(c.tokens)} tokens)`;
  return [row('cache hits', cell.cache), row('context cleared', cell.cleared)].join(' · ');
}
