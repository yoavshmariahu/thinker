// The telemetry report, built in a worker thread so that the thread which started it can stop it
// (telemetry-guard.js). Every part is posted as it finishes: a report stopped at the deadline or the memory
// ceiling has the parts that were done, in the order telemetry.js:telemetryParts gives them.
import { parentPort, workerData } from 'node:worker_threads';

const { module, repo, options } = workerData;
const why = e => String(e?.message || e).slice(0, 200);

try {
  const { telemetryParts, prepareTelemetryWorker } = await import(module);
  // this thread builds one report and ends: it may say how far back it will ever look (telemetry.js)
  prepareTelemetryWorker?.();
  let store;
  if (repo) { const { Store } = await import('./store.js'); store = new Store(repo); }
  const parts = telemetryParts(store, options);
  parentPort.postMessage({ names: parts.map(([name]) => name) });
  for (const [name, make] of parts) {
    // one part failing is that part missing, not the report: the rest are still built
    try { parentPort.postMessage({ name, fragment: make() }); }
    catch (e) { parentPort.postMessage({ name, error: why(e) }); }
  }
} catch (e) {
  parentPort.postMessage({ fatal: why(e) });
}
