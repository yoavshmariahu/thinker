// A compact dashboard over the same accounting used by `usage`.
import { summarize } from './usage.js';
import { formatTokens } from './model-usage.js';

export function stats(store, { here = false, days } = {}) {
  const notes = store.list();
  const status = {}, kinds = {};
  for (const n of notes) {
    status[n.status || 'unknown'] = (status[n.status || 'unknown'] || 0) + 1;
    kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  }
  // Keep the original JSON fields: they describe the current checkout only.
  return { repo: store.repo, notes: notes.length, status, kinds,
    uses: notes.reduce((s, n) => s + (n.uses || 0), 0),
    archived: notes.filter(n => n.archived).length, configured: store.exists(),
    days: days ?? null, usage: summarize(store, { all: !here, days }) };
}

const num = n => Math.round(n).toLocaleString('en-US');
const entries = obj => Object.entries(obj).filter(([, n]) => n).map(([k, n]) => `${num(n)} ${k}`).join(' · ') || 'none';

export function renderStats(s) {
  const u = s.usage;
  const L = [`thinker stats · ${u.scope === 'machine' ? 'this machine' : 'this repository'} · ${s.days ? `last ${s.days} days` : 'all recorded history'}`, ''];
  const row = (label, value) => L.push(`  ${label.padEnd(20)} ${value}`);
  L.push('Activity');
  row('Requests', `${num(u.requests)} · ${num(u.answered)} answered with notes · ${num(u.sessions)} sessions`);
  row('Notes delivered', `${num(u.servings.prompt + u.servings.file + u.servings.lookup)} · ${num(u.notesServed)} distinct notes`);
  row('Session assessments', `${num(u.assessed.confirmed)} acted on · ${num(u.assessed.unused)} unused · ${num(u.assessed.contradicted)} contradicted`);
  row('Awaiting assessment', num(u.assessed.pending));
  row('Agents (requests)', entries(u.clients.active));
  if (!u.events) row('History', 'No usage recorded in this scope and period yet.');
  else row('Recorded dates', `${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}`);

  L.push('', 'Tokens');
  row('Reading avoided', `~${formatTokens(u.saved.tokens)} estimated · ~${num(u.saved.calls)} file reads`);
  row('Context added', formatTokens(u.tokensServed));
  row('Build / maintenance', u.spending.calls ? `${formatTokens(u.spending.totalTokens)} reported · ${num(u.spending.calls)} model records` : 'No model usage recorded');
  L.push('  Savings count only notes an agent was seen to act on; estimates, not measured savings.');
  if (u.spending.unknownTokenCalls || u.spending.legacyRecords) L.push('  Model token totals are incomplete: some records lack usage or setup exploration.');

  L.push('', 'Learning');
  row('Sessions distilled', `${num(u.learned.sessions)} · ${num(u.learned.notes)} new notes · ${num(u.learned.merged)} merged`);
  row('Pull requests mined', `${num(u.learned.prs)} · ${num(u.learned.prNotes)} notes`);
  row('Re-verification', `${num(u.verified.still_valid)} still valid · ${num(u.verified.update)} updated · ${num(u.verified.invalid)} retired`);

  if (u.repos.length) {
    L.push('', 'Repositories with recorded activity');
    // Names get their own line so long origins and paths never collide with columns.
    L.push(`  ${'Requests'.padStart(9)}  ${'Delivered'.padStart(9)}  ${'Notes now'.padStart(9)}  ${'Saved tokens*'.padStart(13)}`);
    for (const r of u.repos.slice(0, 20)) {
      L.push(`  ${r.repo}`, `  ${num(r.requests).padStart(9)}  ${num(r.served).padStart(9)}  ${num(r.notes).padStart(9)}  ${formatTokens(r.tokens).padStart(13)}`);
    }
    if (u.repos.length > 20) L.push(`  + ${num(u.repos.length - 20)} more repositories; --json includes all.`);
    L.push('  * Estimated. Notes now uses the largest known checkout per repository.');
  }
  if (u.unreadable.length) L.push(`  ${num(u.unreadable.length)} unreadable checkouts; their notes are not counted.`);

  L.push('', 'Current checkout', `  ${s.repo}`);
  if (!s.configured) row('Cache', 'Not set up · run thinker setup');
  else {
    row('Notes now', `${num(s.notes)} · ${num(s.archived)} archived`);
    row('Recorded status', entries(s.status));
    row('Kinds', entries(s.kinds));
    L.push('  Status is stored state; thinker check refreshes it against the code.');
  }
  L.push('', 'Use --here for this repository, --days 7 for recent activity, or --json for all data.', 'Run thinker usage for detailed token accounting and the most-served notes.');
  return L.join('\n');
}
