import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { formatTokens } from './model-usage.js';

export const oneLine = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

// Keep terminal output bounded; retain individual results for troubleshooting.
export function batchProgress({ dir, name, total, out, verbose = false, every = 5, intervalMs = 30_000 }) {
  const file = path.join(dir, 'state', `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${process.pid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ event: 'batch', name, total }) + '\n');
  let completed = 0, saved = 0, empty = 0, failed = 0, current = '', timer;
  const reasons = new Map();
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const status = () => `${name}: ${completed}/${total} processed · ${saved} ${saved === 1 ? 'note' : 'notes'} saved${empty ? ` · ${empty} with no new notes` : ''}${failed ? ` · ${failed} failed` : ''}`;
  const detail = record => {
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
    if (verbose) out(`        ${oneLine(JSON.stringify(record))}`);
  };
  return {
    pause() { clearInterval(timer); },
    start(label) {
      current = oneLine(label).slice(0, 70);
      detail({ event: 'start', item: label });
      if (completed === 0 || every === 1) out(`        ${name}: ${completed}/${total} processed · working on ${current}…`);
      clearInterval(timer);
      timer = setInterval(() => out(`        ${status()} · still working on ${current} (${elapsed()} elapsed)`), intervalMs);
      timer.unref();
    },
    detail,
    complete({ notes = [], error, ...rest } = {}) {
      clearInterval(timer);
      completed++;
      saved += notes.length;
      if (error) {
        failed++;
        const reason = /timed?\s*out|timeout/i.test(String(error)) ? 'agent timed out' : oneLine(error).slice(0, 100);
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      } else if (!notes.length) empty++;
      detail({ event: 'complete', item: current, notes, ...(error ? { error: String(error) } : {}), ...rest });
      if (completed < total && (completed === 1 || completed % every === 0)) out(`        ${status()}`);
    },
    // `tokens`: what the agent reported using, summed over the batch, for the user's own sense of
    // their usage; no dollar figure, since the agent's login may be a subscription
    finish({ retry, tokens = 0 } = {}) {
      clearInterval(timer);
      out(`        ${status()} · ${elapsed()}${tokens ? ` · ~${formatTokens(tokens)} tokens of ${name === 'Exploration' ? 'agent' : 'model'} usage` : ''}`);
      if (failed) {
        const summary = [...reasons].slice(0, 3).map(([reason, count]) => `${reason} (${count})`).join('; ');
        out(`        Warning: ${summary}${reasons.size > 3 ? '; more errors in details' : ''}.`);
        if (retry) out(`        ${retry}`);
      }
      out(`        Details: ${file}`);
      return { saved, failed, processed: completed, empty };
    },
  };
}
