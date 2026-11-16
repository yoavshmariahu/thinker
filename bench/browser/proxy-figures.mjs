#!/usr/bin/env node
// What one session's own proxy did, as one line of JSON for the bench record (`armReport`).
// Read from the proxy's log in the session's directory, so the figures are that session's and nobody else's.
import fs from 'node:fs';
const rows = (() => { try { return fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
const calls = rows.filter(r => r.op === 'proxy');
const sum = f => calls.reduce((n, r) => n + (f(r) || 0), 0);
const reasons = {};
for (const r of calls) if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
const last = [...calls].reverse().find(r => r.ephemeral);
console.log(JSON.stringify({
  requests: calls.length,
  policy: [...new Set(calls.map(r => r.policy).filter(Boolean))],
  // the cut (cutting.js): how often it moved, and what was out of the prompt summed over the calls
  clears: calls.filter(r => r.clear).length,
  cutTokenCalls: sum(r => r.clientCut?.tokens),
  // superseded page states (ephemeral.js): replaced by the end, and what that kept out summed over the calls
  pagesReplaced: last?.ephemeral?.results || 0,
  pageTokenCalls: sum(r => r.ephemeral?.tokens),
  anchored: calls.filter(r => r.ephemeral?.anchor).length,
  anchorRefused: calls.filter(r => r.ephemeral?.reason).length,
  rejected: rows.filter(r => r.op === 'proxy-cut-rejected').length,
  reasons,
}));
