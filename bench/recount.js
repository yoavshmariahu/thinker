#!/usr/bin/env node
// Recompute the loop counters of finished runs from their saved transcripts (Claude) or event
// streams (Codex), after a change to how a green test run is recognized. Rewrites `tools` in
// each record in place; the rest of the record is untouched.
//
//   node bench/recount.js <runs dir>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexLoopStats, testGreen, TEST_RUN, goldTestsSeen } from './oracle.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: recount.js <runs dir> [--tasks <task file>]   (--tasks also backfills `leak`, the gold test names the session saw)'); process.exit(1); }
const ti = process.argv.indexOf('--tasks');
const tasks = ti > 0 ? Object.fromEntries(JSON.parse(fs.readFileSync(process.argv[ti + 1], 'utf8')).tasks.map(t => [t.id, t])) : null;

function claudeLoopStats(file) {
  const s = { callsBeforeFirstEdit: null, testRunsBeforeEdit: 0, testRunsAfterEdit: 0, attemptsToGreen: null, greenReached: false };
  const ids = new Map(); let calls = 0, edited = false, attempts = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!Array.isArray(j.message?.content)) continue;
    if (j.type === 'user') {
      for (const b of j.message.content) {
        if (b.type !== 'tool_result' || ids.get(b.tool_use_id) !== 'after' || s.greenReached) continue;
        const out = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : '';
        if (testGreen(out, null)) { s.greenReached = true; s.attemptsToGreen = attempts; }
      }
      continue;
    }
    if (j.type !== 'assistant') continue;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      calls++;
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && !edited) { edited = true; s.callsBeforeFirstEdit = calls - 1; }
      if (b.name === 'Bash' && TEST_RUN.test(b.input?.command || '')) {
        if (edited) { s.testRunsAfterEdit++; if (!s.greenReached) attempts++; ids.set(b.id, 'after'); }
        else { s.testRunsBeforeEdit++; ids.set(b.id, 'before'); }
      }
    }
  }
  if (!edited) s.callsBeforeFirstEdit = calls;
  return s;
}

// A Claude transcript is keyed by the session's cwd; find it by session id under every project dir.
function findTranscript(session) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(root)) { const f = path.join(root, d, session + '.jsonl'); if (fs.existsSync(f)) return f; }
  return null;
}

let n = 0, missing = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f === 'summary.json') continue;
  const p = path.join(dir, f);
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!r.task || !r.arm || r.error) continue;
  const events = path.join(dir, 'events', f.replace(/\.json$/, '.jsonl'));
  let stats = null, text = null;
  if (fs.existsSync(events)) { text = fs.readFileSync(events, 'utf8'); stats = codexLoopStats(text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); }
  else if (r.session) { const t = findTranscript(r.session); if (t) { text = fs.readFileSync(t, 'utf8'); stats = claudeLoopStats(t); } }
  if (!stats) { missing++; continue; }
  if (tasks && tasks[r.task]) r.leak = goldTestsSeen(tasks[r.task], text);
  const before = JSON.stringify({ a: r.tools?.attemptsToGreen, g: r.tools?.greenReached });
  r.tools = { ...(r.tools || {}), ...stats };
  fs.writeFileSync(p, JSON.stringify(r, null, 2));
  n++;
  const after = JSON.stringify({ a: r.tools.attemptsToGreen, g: r.tools.greenReached });
  if (before !== after) console.log(`${r.id}: ${before} → ${after}`);
}
console.log(`recounted ${n} records; ${missing} without a transcript or event stream`);
