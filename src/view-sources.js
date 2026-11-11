// What a kept view rests on besides the code that made it: the sessions of its window, and the records the readers
// summarise beside them. A stamp over those answers one question -- could working the view out again give a different
// answer? When it could not, the refresh keeps what is there and only says when it looked (context-snapshot.js,
// report-snapshot.js), instead of reading every session's metadata and adding it all up again.
//
// Why it exists (2026-11-10): the page holds a view for REFRESH_MS and then has `thinker context --refresh` /
// `thinker report --refresh` make it again in the background. The transcripts themselves are read once and kept
// (tool-outputs.js, harness.js, instruction-value.js, factory.js each keep a record per session), so the work the
// refresh repeated was the aggregation: 41 MB of per-session records read back and summed. On this machine
// `thinker report --refresh --all` was fifteen seconds of that every ten minutes, over nineteen repositories, most of
// which nobody had touched for days.
//
// **A stamp is of this repository's slice, never of a shared file's mtime.** The machine's log and the proxy's are
// one file for every repository and are appended to all day, so their size and mtime say nothing about whether this
// repository's figures moved: stamped that way (the first cut of this file) every repository rebuilt every time, which
// is what was there before. So the log is stamped by the events of this repository alone, and the proxy's by the rows
// of the window's own sessions. The cost is parsing both files once a process, which a refresh that rebuilds pays
// anyway and which usage.js and compression.js keep for the rest of the run.
//
// A stamp is a sufficient reason to skip, never the only check: the snapshot still carries the code that made it and
// the switches it read (context-snapshot.js:inputs), and a view older than MAX_KEEP_MS is made again whatever the
// stamp says. So what this file does not watch -- another repository's events, which only ever decide whether a
// session counts as this repository's -- is wrong for hours at most and never for ever.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logFile } from './store.js';
import { readLog, sessionKey } from './usage.js';
import { deliveryFile } from './delivery-journal.js';
import { compressionRecords, compressionDir } from './compression.js';
import { proxyLogFile } from './proxy-service.js';

// a kept view is made again at least this often, whatever the stamp says
export const MAX_KEEP_MS = 6 * 3600_000;

const fileStamp = f => { try { const s = fs.statSync(f); return `${s.size}\t${Math.round(s.mtimeMs)}`; } catch { return '-'; } };

// This repository's own events in the machine's log: how many and the last one's time. The log holds every
// repository's, and `thinker report` reads this repository's for the decisions, the savings and the diet timeline.
const logSlice = store => {
  if (!logFile(store)) return 'log\toff';
  let events = []; try { events = readLog(store); } catch { return 'log\t-'; }
  return `log\t${events.length}\t${events.at(-1)?.t || ''}`;
};

// The proxy's rows for the window's own sessions: how many and the last one's time. The log is the machine's, one
// row per request of every agent it serves, so only the sessions of this window can change this view.
const proxySlice = ids => {
  const file = proxyLogFile();
  if (!file) return 'proxy\toff';
  let rows = []; try { rows = compressionRecords(file); } catch { return 'proxy\t-'; }
  let n = 0, last = '';
  for (const r of rows) if (ids.has(sessionKey(r.session))) { n++; if (String(r.at || '') > last) last = String(r.at || ''); }
  return `proxy\t${n}\t${last}`;
};

// The clears a desktop session recorded for itself (compression.js): one file per session, rewritten in place when
// the card is drawn, so each is stamped by its own size and mtime. Only the window's sessions count.
const clearSlice = ids => {
  const dir = compressionDir();
  let names = []; try { names = fs.readdirSync(dir).sort(); } catch { return 'clears\t-'; }
  const mine = names.filter(n => ids.has(sessionKey(n.replace(/\.json$/, ''))));
  return `clears\t${mine.map(n => `${n}\t${fileStamp(path.join(dir, n))}`).join('|')}`;
};

// The stamp of one view's sources. `sessions` is the window's own list (instruction-value.js:findRepoSessions,
// filtered as the view filters it), so a session written, added or dropped from the window all move the stamp;
// `window` names the window itself (the Report's first week, the Context view's days), so a boundary that moves
// with the clock moves it too. `proxy`: the Report prices what the clearing saved, the Context view does not.
export function sourceStamp(store, { sessions = [], window = '', proxy = false } = {}) {
  const ids = new Set(sessions.map(s => sessionKey(s.session)));
  const parts = [`window\t${window}`, logSlice(store), `delivery\t${fileStamp(deliveryFile(store) || '')}`];
  if (proxy) parts.push(proxySlice(ids), clearSlice(ids));
  for (const s of [...sessions].sort((a, b) => String(a.session).localeCompare(String(b.session)))) {
    parts.push(`${s.session}\t${s.file}\t${Math.round(s.mtime || 0)}\t${fileStamp(s.file)}\t${s.since || 0}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

// Whether a kept view may be kept as it is: this code made it, its sources have not moved, and it is not older than
// MAX_KEEP_MS. `kept.stamp` is absent on a view written before this existed, and such a view is made again once.
export function canKeep(kept, stamp, { now = Date.now(), maxAge = MAX_KEEP_MS } = {}) {
  return Boolean(kept?.view && kept.mine && kept.stamp && kept.stamp === stamp && now - (kept.at || 0) < maxAge);
}

// How each view names its window in the stamp: one place, so the page's worker (ui/scan-worker.js) and the commands
// that write the snapshots (context-snapshot.js, report-snapshot.js) stamp the same sources the same way.
export const contextWindow = days => `context:${days}`;
export const reportWindow = (weeks, from) => `report:${weeks}:${from}`;
