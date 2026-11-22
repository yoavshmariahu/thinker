// The telemetry report under a deadline and a memory ceiling.
//
// The report is read out of everything the machine has logged, and a machine's history has no upper bound. Built
// in the process that sends it, it took whatever it took: on 2026-11-21 one build was 900 MB and nine seconds on a
// machine with fifteen worktrees of one repository, eleven of them ran at once because nothing stopped a second
// from starting (telemetry.js:claimAttempt), and a 16 GB machine ran out of memory. The build is synchronous, so
// no timer in its own thread can interrupt it -- it has to be stopped from outside.
//
// So it runs in a worker thread (telemetry-worker.js) and this thread, which does nothing else, holds three
// limits over it:
//
//   heapMb      V8's own limit on the worker's heap. V8 collects harder as it nears it, which is what keeps an
//               ordinary build small, and ends the worker when live data does not fit.
//   growthMb    how much the process may grow while the worker runs, read off the resident size ten times a
//               second: the memory V8's limit does not see (a file read whole is a buffer outside the heap).
//   deadlineMs  how long it may take.
//
// Past any of them the worker is terminated and the report is the parts it had finished, in the order
// telemetry.js:telemetryParts builds them -- identity and activity first -- with `incomplete` saying why and what
// is missing. A limit is therefore never a machine that goes quiet: it is a machine that says it hit one.
//
// The numbers, measured on the machine above with the real command against a loopback endpoint: the build needs
// about 100 MB of heap (it fits in 112 and not in 96) and three seconds, and the job's process peaks at 270-300 MB
// resident, 77 of which is node and the CLI's modules before any work. The limits are that with room to grow,
// and are not settings: a limit somebody can raise is not a limit.
import { Worker } from 'node:worker_threads';

export const BUILD_LIMITS = { deadlineMs: 60_000, heapMb: 160, youngMb: 16, growthMb: 384, graceMs: 2_000 };
const MB = 1024 * 1024;
const TELEMETRY = new URL('./telemetry.js', import.meta.url).href;
const WORKER = new URL('./telemetry-worker.js', import.meta.url);

// { fragments, names, incomplete, detail, stuck, ms }. `fragments` are the parts that were built, each the payload's
// own keys; `incomplete` is null for a whole report, else { reason: 'deadline' | 'memory' | 'error', missing, ms }.
// `detail` is what a failed part said, for the machine's own error record and never for the report: it can name a path.
// `stuck` is a worker that did not end when it was told to -- it was inside one native call, which nothing can
// interrupt -- so the caller must not wait for the process to exit by itself (commands/telemetry.js).
// Never rejects.
export function buildGuarded({ repo, options = {}, module = TELEMETRY, limits = BUILD_LIMITS, rss = () => process.memoryUsage.rss() } = {}) {
  limits = { ...BUILD_LIMITS, ...limits };
  return new Promise(resolve => {
    const t0 = Date.now(), fragments = [], built = new Set();
    let names = null, reason = null, detail = null, settled = false, stuck = false, deadline, watch, grace;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearInterval(watch); clearTimeout(grace);
      const ms = Date.now() - t0;
      const missing = names ? names.filter(n => !built.has(n)) : null;
      const incomplete = reason || !names || missing.length ? { reason: reason || 'error', missing, ms } : null;
      resolve({ fragments, names, incomplete, detail, stuck, ms });
    };
    let worker;
    try {
      worker = new Worker(WORKER, {
        workerData: { module, repo: repo || null, options },
        resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: limits.youngMb },
      });
    } catch (e) { reason = 'error'; detail = String(e?.message || e).slice(0, 200); return finish(); }
    const stop = why => {
      if (reason || settled) return;
      reason = why;
      Promise.resolve(worker.terminate()).catch(() => {});
      grace = setTimeout(() => { stuck = true; finish(); }, limits.graceMs);
    };
    const start = rss();
    deadline = setTimeout(() => stop('deadline'), limits.deadlineMs);
    watch = setInterval(() => { if (rss() - start > limits.growthMb * MB) stop('memory'); }, 100);
    worker.on('message', m => {
      if (m.names) names = m.names;
      else if (m.fragment) { fragments.push(m.fragment); built.add(m.name); }
      else if (m.error || m.fatal) { reason ||= 'error'; detail ||= m.error || m.fatal; }
    });
    worker.on('error', e => {
      reason ||= e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'error';
      if (reason === 'error') detail ||= String(e?.message || e).slice(0, 200);
    });
    worker.on('exit', finish);
  });
}
