import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { formatTokens } from './model-usage.js';
import { spinner, spinnerEnabled, onTerminal, terminalStream } from './setup/ui.js';

export const oneLine = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

// Keep terminal output bounded; retain individual results for troubleshooting. On a terminal the
// item in progress is a live spinner line; elsewhere a heartbeat line every `intervalMs` says the
// batch is still working.
// The detail file (state/<name>-<started>-<pid>.jsonl) is also how the local page shows a batch
// running in another process (activity.js): its first line names the batch and its size, each
// item has a start and a complete record, and `finish` closes it. `silent` writes the file and
// says nothing on the terminal (the catch-up learning the hooks start).
// `onProgress({ completed, total, current, saved })` is told of every start and completion: the build's
// progress bar reads it (setup/steps.js), and then the batch draws no spinner and no heartbeat of its own.
export function batchProgress({ dir, name, total, out, verbose = false, every = 5, intervalMs = 30_000, silent = false, onProgress = null, heartbeat = !onProgress, live = !silent && heartbeat && onTerminal(out) && spinnerEnabled(terminalStream(out)) }) {
  if (silent) out = () => {};
  const file = path.join(dir, 'state', `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${process.pid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ event: 'batch', name, total, pid: process.pid, started: new Date().toISOString() }) + '\n');
  let completed = 0, saved = 0, empty = 0, failed = 0, current = '', timer, spin = null;
  const reasons = new Map();
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const status = () => `${name}: ${completed}/${total} processed · ${saved} ${saved === 1 ? 'note' : 'notes'} saved${empty ? ` · ${empty} with no new notes` : ''}${failed ? ` · ${failed} failed` : ''}`;
  const detail = record => {
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
    if (verbose) out(`        ${oneLine(JSON.stringify(record))}`);
  };
  return {
    pause() { clearInterval(timer); spin?.stop(); spin = null; },
    start(label) {
      current = oneLine(label).slice(0, 70);
      detail({ event: 'start', item: label });
      clearInterval(timer);
      onProgress?.({ completed, total, current, saved });
      if (!heartbeat) return;
      if (live) {
        const text = `${name}: ${completed}/${total} · working on ${current}`;
        if (spin) spin.set(text); else spin = spinner(text, { indent: '        ' });
        return;
      }
      if (completed === 0 || every === 1) out(`        ${name}: ${completed}/${total} processed · working on ${current}…`);
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
      onProgress?.({ completed, total, current, saved });
      if (completed < total && (completed === 1 || completed % every === 0)) out(`        ${status()}`);
    },
    // `tokens`: what the agent reported using, summed over the batch, for the user's own sense of
    // their usage; no dollar figure, since the agent's login may be a subscription
    finish({ retry, tokens = 0 } = {}) {
      clearInterval(timer);
      spin?.stop(); spin = null;
      detail({ event: 'finish', completed, saved, failed, tokens });
      out(`        ${status()} · ${elapsed()}${tokens ? ` · ~${formatTokens(tokens)} tokens of model usage` : ''}`);
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

// What a build has done and how long it has left, for the terminal's progress bar (setup/steps.js) and,
// from the batch file, the page (ui/server.js:jobProgress). Three stages in order: mining the pull
// requests (the estimate's seconds, then the batch's own pace once it has completed something), the
// finish (linking, phrasings, behavior drafts: a time budget), and the design documents (a budget per
// document, then the count read). A stage with no count creeps towards its budget and never reaches it.
export const BUILD_SECONDS = { finish: 75, perDoc: 6 };
export function buildProgress({ mineSeconds = 0, docs = 0, now = Date.now } = {}) {
  const budget = { mine: Math.max(30, Number(mineSeconds) || 0), finish: BUILD_SECONDS.finish, docs: docs * BUILD_SECONDS.perDoc };
  const order = ['mine', 'finish', 'docs'];
  const st = { stage: null, startedAt: 0, done: 0, total: 0, current: '', text: '', complete: new Set() };
  return {
    stage(name, { total = 0, text = '' } = {}) { if (st.stage) st.complete.add(st.stage); Object.assign(st, { stage: name, startedAt: now(), done: 0, total, current: '', text }); },
    skip(name) { budget[name] = 0; st.complete.add(name); },
    update(next = {}) { for (const k of ['done', 'total', 'current', 'text']) if (next[k] !== undefined) st[k] = next[k]; },
    now() {
      const t = st.stage ? (now() - st.startedAt) / 1000 : 0;
      let doneSec = 0, left = 0;
      for (const s of order) {
        if (st.complete.has(s)) { doneSec += budget[s]; continue; }
        if (s !== st.stage) { left += budget[s]; continue; }
        if (st.total && st.done) { const frac = Math.min(1, st.done / st.total); doneSec += budget[s] * frac; left += Math.round(t / st.done * (st.total - st.done)); }
        else { const frac = budget[s] ? Math.min(0.95, t / budget[s]) : 0; doneSec += budget[s] * frac; left += Math.max(5, Math.round(budget[s] - t)); }
      }
      const total = order.reduce((a, s) => a + budget[s], 0);
      const text = `${st.text}${st.total ? ` ${st.done}/${st.total}` : ''}${st.current ? ` · ${st.current}` : ''}`;
      return { fraction: total ? Math.min(0.99, doneSec / total) : 0, left, text };
    },
  };
}
