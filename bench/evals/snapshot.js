#!/usr/bin/env node
// Recoverable snapshots of the evals database. A snapshot is a consistent copy (SQLite VACUUM INTO,
// safe while the app writes), gzipped, kept in ~/.thinker-evals/snapshots (the newest 14) and uploaded
// with the aws CLI to the S3 location in ~/.thinker-evals/config.json ({"s3": "s3://bucket/prefix"}),
// or EVALS_S3_URI, which overrides it. The app takes one daily.
//
//   node bench/evals/snapshot.js take              a snapshot now
//   node bench/evals/snapshot.js list              local snapshots and, with EVALS_S3_URI, the bucket's
//   node bench/evals/snapshot.js restore <file | s3://…> --force
//                                                  replace the database with a snapshot (stop the app first;
//                                                  the database it replaces is kept beside it)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB } from './db.js';

export const SNAP_DIR = path.join(os.homedir(), '.thinker-evals', 'snapshots');
export const CONFIG = path.join(os.homedir(), '.thinker-evals', 'config.json');

// where snapshots go: the environment first, then the machine's evals config
export function s3Uri(config = CONFIG) {
  if (process.env.EVALS_S3_URI) return process.env.EVALS_S3_URI;
  try { const s = JSON.parse(fs.readFileSync(config, 'utf8')).s3; return typeof s === 'string' && /^s3:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/.test(s) ? s : null; } catch { return null; }
}
const KEEP = 14;

export function listLocal(dir = SNAP_DIR) {
  try { return fs.readdirSync(dir).filter(f => /^evals-.*\.db\.gz$/.test(f)).sort().reverse().map(f => ({ file: path.join(dir, f), bytes: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs })); } catch { return []; }
}

export function takeSnapshot(dbFile = DEFAULT_DB, { dir = SNAP_DIR, s3 = s3Uri(), now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z');
  const tmp = path.join(dir, `evals-${stamp}.db`);
  const db = new DatabaseSync(dbFile);
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  // a snapshot that does not open is no snapshot
  const check = new DatabaseSync(tmp, { readOnly: true });
  const counts = { results: check.prepare('SELECT count(*) n FROM results').get().n, transcripts: check.prepare('SELECT count(*) n FROM transcripts').get().n };
  check.close();
  const out = tmp + '.gz';
  fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(tmp)));
  fs.rmSync(tmp);
  for (const old of listLocal(dir).slice(KEEP)) fs.rmSync(old.file, { force: true });
  let uploaded = null, uploadError = null;
  if (s3) {
    const dest = `${s3.replace(/\/$/, '')}/${path.basename(out)}`;
    try { execFileSync('aws', ['s3', 'cp', out, dest, '--only-show-errors'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }); uploaded = dest; }
    catch (e) { uploadError = String(e.stderr || e.message).slice(0, 300); }
  }
  return { file: out, bytes: fs.statSync(out).size, counts, uploaded, uploadError, s3: s3 || null, at: now.getTime() };
}

export function restoreSnapshot(src, dbFile = DEFAULT_DB) {
  let gz = src;
  if (/^s3:\/\//.test(src)) {
    gz = path.join(os.tmpdir(), path.basename(src));
    execFileSync('aws', ['s3', 'cp', src, gz, '--only-show-errors'], { stdio: 'inherit' });
  }
  const tmp = dbFile + '.restoring';
  fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(gz)));
  const check = new DatabaseSync(tmp, { readOnly: true });
  const n = check.prepare('SELECT count(*) n FROM results').get().n;
  check.close();
  if (fs.existsSync(dbFile)) fs.renameSync(dbFile, `${dbFile}.replaced-${Date.now()}`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(tmp, dbFile);
  return { restored: dbFile, from: src, results: n };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const dbFile = process.env.EVALS_DB || DEFAULT_DB;
  if (cmd === 'take') console.log(JSON.stringify(takeSnapshot(dbFile), null, 2));
  else if (cmd === 'list') {
    console.log(listLocal().map(s => `${new Date(s.at).toISOString()}  ${(s.bytes / 1e6).toFixed(1)} MB  ${s.file}`).join('\n') || 'no local snapshots');
    if (s3Uri()) execFileSync('aws', ['s3', 'ls', s3Uri().replace(/\/?$/, '/')], { stdio: 'inherit' });
  } else if (cmd === 'restore' && arg && process.argv.includes('--force')) console.log(JSON.stringify(restoreSnapshot(arg, dbFile), null, 2));
  else { console.error('usage: snapshot.js take | list | restore <file | s3://…> --force   (stop the app before restoring)'); process.exit(2); }
}
