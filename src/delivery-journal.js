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

export function readDelivery(store) {
  const file = deliveryFile(store), events = [], warnings = [], seen = new Set();
  if (!file || !fs.existsSync(file)) return { events, warnings };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (e.schema !== SCHEMA || typeof e.eventId !== 'string' || typeof e.t !== 'string' || !Number.isFinite(Date.parse(e.t)) || e.origin !== repoId(store.repo) || !OPS.includes(e.op)) throw new Error('unsupported or invalid record');
      if (!seen.has(e.eventId)) { seen.add(e.eventId); events.push(e); }
    } catch { warnings.push(`Unreadable delivery record at line ${index + 1}`); }
  });
  return { events: events.sort((a, b) => a.t.localeCompare(b.t)), warnings };
}

// Every checkout whose sessions this machine recorded, for the roll-up across repositories.
export function deliveryCheckouts(store) {
  const file = deliveryFile(store), out = [];
  if (!file) return out;
  const dir = path.dirname(file);
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) { const e = JSON.parse(lines[i]); if (e.checkout) { out.push(e.checkout); break; } }
    } catch { /* an unreadable journal is counted when its checkout is reached another way */ }
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
