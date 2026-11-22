// What this machine delivered: the pull requests its sessions produced, kept beside the usage log.
//
// One append-only file per repository (`<log dir>/delivery/<digest>.jsonl`), never committed and never
// shared. It holds three kinds of record:
//
//   observation  a session was at this branch and this commit at this moment (the prompt hook)
//   pr           a pull request as GitHub last described it (`thinker prs sync`)
//   link         a person's own word on which PR a session belongs to (`thinker prs link`)
//
// The sessions, the servings and the model calls are already in the usage log (store.js:logFile); nothing is
// copied here. What the log cannot hold is a pull request, which belongs to no single session, and a link,
// which is a decision rather than an event.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { logFile, repoId } from './store.js';
import { eachLine, eachLineBackwards } from './jsonl.js';

export const SCHEMA = 1;
export const OPS = ['observation', 'pr', 'link'];

export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export function deliveryFile(store) {
  const log = logFile(store);
  return log && path.join(path.dirname(log), 'delivery', `${digest(repoId(store.repo))}.jsonl`);
}

export function appendDelivery(store, event) {
  const file = deliveryFile(store);
  if (!file) throw new Error('Delivery recording is disabled by THINKER_LOG=off');
  if (!OPS.includes(event.op)) throw new Error(`Unknown delivery record: ${event.op}`);
  const record = { ...event, schema: SCHEMA, eventId: event.eventId || crypto.randomUUID(), t: new Date(event.t || Date.now()).toISOString(), origin: repoId(store.repo), checkout: store.repo };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A branch name is the person's own work in progress and never becomes shared cache content.
  try { fs.writeFileSync(path.join(path.dirname(file), '.gitignore'), '*\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

// Recording must never fail a hook or a command: a lost observation costs one link, nothing more.
export function tryDelivery(store, event) { try { return appendDelivery(store, event); } catch { return null; } }

// The journal, a line at a time (jsonl.js): what is held is the records, never the file.
//
// A pull request is written again every time GitHub is read, whether or not anything about it moved, so most
// of a journal is one record repeated: on the machine this was measured on (2026-11-21) 77,421 `pr` rows named
// 3,868 pull requests and 62,538 of them were word for word the row before for that number, 49 MB of it. A run
// of identical rows is kept as its newest one. Nothing a reader folds can change: a pull request is its rows
// merged in order of time, later over earlier, and a row that says what a later row says decides no field.
export function readDelivery(store) {
  const file = deliveryFile(store), events = [], warnings = [], seen = new Set();
  if (!file || !fs.existsSync(file)) return { events, warnings };
  const origin = repoId(store.repo), lastPr = new Map(); // number -> { json, index } of the row kept for it
  eachLine(file, (line, index) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (e.schema !== SCHEMA || typeof e.eventId !== 'string' || typeof e.t !== 'string' || !Number.isFinite(Date.parse(e.t)) || e.origin !== origin || !OPS.includes(e.op)) throw new Error('unsupported or invalid record');
      if (seen.has(e.eventId)) return;
      if (e.op === 'pr' && e.pr && e.pr.number != null) {
        const json = JSON.stringify(e.pr), kept = lastPr.get(e.pr.number);
        // A repeat is not remembered by its id either: the ids of every row ever written were 12 MB held for a
        // journal of 120,000 rows, and a row with the id of a repeat is that repeat again, which is dropped here.
        if (kept && kept.json === json) { if (e.t >= events[kept.index].t) events[kept.index] = e; return; }
        lastPr.set(e.pr.number, { json, index: events.length });
      }
      seen.add(e.eventId);
      events.push(e);
    } catch { warnings.push(`Unreadable delivery record at line ${index + 1}`); }
  });
  return { events: events.sort((a, b) => a.t.localeCompare(b.t)), warnings };
}

// What the journal last said of each pull request, as the text of its record: what `thinker prs sync` compares
// a pull request against before writing it again (delivery.js:syncPrs).
export function lastPrRecords(store) {
  const last = new Map();
  for (const e of readDelivery(store).events) if (e.op === 'pr' && e.pr && e.pr.number != null) last.set(e.pr.number, JSON.stringify(e.pr));
  return last;
}

// Every checkout whose sessions this machine recorded, for the roll-up across repositories.
export function deliveryCheckouts(store) {
  const file = deliveryFile(store), out = [];
  if (!file) return out;
  const dir = path.dirname(file);
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    // the newest record that names a checkout, read from the end of the file: a journal is tens of megabytes
    // and its last record is in its last few hundred bytes
    try {
      eachLineBackwards(path.join(dir, name), line => {
        if (!line.trim()) return false;
        let e; try { e = JSON.parse(line); } catch { return true; } // an unreadable journal is counted when its checkout is reached another way
        if (!e.checkout) return false;
        out.push(e.checkout); return true;
      });
    } catch { /* as above */ }
  }
  return out;
}

export function gitContext(repo) {
  const git = args => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
  return { branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']), head: git(['rev-parse', '--verify', 'HEAD']) };
}

export function positiveInteger(value, label) {
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
  return n;
}
