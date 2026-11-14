// Fill a collector from this machine's own sessions, spread over a few synthetic machines.
//
// For the demo, and only the demo. The figures are real -- every one of them comes through `sessionEvent`,
// so they are priced by `delivery.js:sessionsOf` like any other event and nothing here turns a token into a
// dollar. What is invented is which machine a session was on: one machine's sessions are dealt out over
// three install ids so the fleet view has a fleet to show. Nothing identifying goes with them.
//
//   node demo/collector/seed.mjs [--url http://127.0.0.1:PORT/v1/sessions] [--sessions 12] [--machines 3]
import { Store } from '../../src/store.js';
import { thinkerHome } from '../../src/update.js';
import { sessionEvent, EVENTS } from '../../src/events.js';
import { sessionsOf } from '../../src/delivery.js';
import { readLog } from '../../src/usage.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const URL_ = arg('url', 'http://127.0.0.1:8787/v1/sessions');
const WANT = Number(arg('sessions', 12));
const MACHINES = Number(arg('machines', 3));
const DAYS = Number(arg('days', 14));

// stable made-up install ids, so re-seeding lands on the same machines
const INSTALLS = ['b2e4d8c1-66f0-4a19-8d73-44dd55ee66ff', 'a1f3c9d2-7b41-4e8a-9c02-11aa22bb33cc', 'c3d5e7b0-5599-42c7-b1e4-77aa88bb99cc'].slice(0, MACHINES);

const home = thinkerHome();
const store = new Store(process.cwd()).init();
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const log = readLog(store);

// The most recent sessions, not the most interesting ones. Picking the longest, or the ones that got a cut,
// would be choosing the figures the page then shows -- and a seed that is tuned until the headline looks
// good is a demo of nothing. Newest first is what a fleet actually reports.
const sessions = [...sessionsOf(store, { since, log, home }).values()]
  .filter(x => x.prompts > 0)
  .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
  .slice(0, WANT);

const lines = [];
for (const [i, x] of sessions.entries()) {
  const ev = sessionEvent(store, { session: x.id, home, env: {}, log, since });
  if (!ev) continue;
  lines.push(JSON.stringify({ ...ev, install: INSTALLS[i % INSTALLS.length] }));
}
if (!lines.length) { console.error('no sessions in the window; nothing to seed'); process.exit(1); }

const res = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-ndjson', 'X-Thinker-Events': String(EVENTS.schemaVersion) },
  body: lines.join('\n') + '\n',
});
console.log(`${lines.length} sessions over ${INSTALLS.length} machines ->`, res.status, JSON.stringify(await res.json()));
