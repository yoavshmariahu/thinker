#!/usr/bin/env node
// Fill the dense embedding cache (dense.js) for a directory of notes, ahead of a run with THINKER_DENSE=minilm.
//   node bench/dense-embed.js <notes dir>
import fs from 'node:fs';
import path from 'node:path';
const { buildDenseCache } = await import('../src/dense.js');
const dir = process.argv[2];
if (!dir) { console.error('usage: node bench/dense-embed.js <notes dir>'); process.exit(2); }
const notes = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
const t0 = Date.now();
const n = await buildDenseCache(notes, { out: s => process.stderr.write(`\r${s}   `) });
console.log(`\n${notes.length} notes, ${n} embedded now, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
