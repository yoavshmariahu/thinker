// Durable local outcome evidence. Independent of shared notes and telemetry; one append per event.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logFile, repoId } from './store.js';

export const impactContext = new AsyncLocalStorage();
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function impactFile(store) {
  const log = logFile(store);
  return log && path.join(path.dirname(log), 'impact', `${digest(repoId(store.repo))}.jsonl`);
}
export function appendImpact(store, event) {
  const file = impactFile(store);
  if (!file) throw new Error('Impact recording is disabled by THINKER_LOG=off');
  const record = { ...event, schema: 1, eventId: event.eventId || crypto.randomUUID(), t: new Date(event.t || Date.now()).toISOString(), origin: repoId(store.repo), checkout: store.repo };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Local-mode evidence can contain source excerpts and must not become shared cache content.
  try { fs.writeFileSync(path.join(path.dirname(file), '.gitignore'), '*\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}
// Instrumentation must never fail a hook, model call, or review.
export function tryImpact(store, event) { try { return appendImpact(store, event); } catch { return null; } }
export function readImpact(store) {
  const file = impactFile(store), events = [], warnings = [], seen = new Set();
  if (!file || !fs.existsSync(file)) return { events, warnings };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (e.schema !== 1 || typeof e.eventId !== 'string' || typeof e.t !== 'string' || !Number.isFinite(Date.parse(e.t)) || e.origin !== repoId(store.repo)) throw new Error('unsupported or invalid event');
      if (!seen.has(e.eventId)) { seen.add(e.eventId); events.push(e); }
    } catch { warnings.push(`Unreadable impact event at line ${index + 1}`); }
  });
  return { events: events.sort((a, b) => a.t.localeCompare(b.t)), warnings };
}
export function gitContext(repo) {
  const git = args => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
  return { branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']), head: git(['rev-parse', '--verify', 'HEAD']) };
}
export function findingId(f) {
  // Line numbers move between revisions. Exact content matches are safe; semantic duplicates
  // require an explicit duplicate decision rather than a model silently merging different bugs.
  const text = v => String(v || '').replace(/\s+/g, ' ').trim();
  return `f-${digest([f.file, f.category, text(f.message), text(f.evidence), f.noteId || f.note || ''])}`;
}
export function reviewPrNumber(explicit) {
  if (explicit !== undefined) {
    const n = Number(explicit);
    if (typeof explicit === 'boolean' || !Number.isSafeInteger(n) || n <= 0) throw new Error('PR must be a positive integer');
    return n;
  }
  try { return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.number; } catch { return undefined; }
}
