// A compact dashboard over the same accounting used by `usage`.
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from './usage.js';
import { formatTokens } from './model-usage.js';

export function stats(store, { here = false, days } = {}) {
  let profile = null; try { profile = JSON.parse(fs.readFileSync(path.join(store.localDir, 'profile', 'profile.json'), 'utf8')); } catch {}
  return { repo: store.repo, configured: store.exists(),
    profile: profile ? { observations: profile.window?.observations || 0, sessions: profile.window?.sessions || 0, compiledAt: profile.compiledAt || null } : null,
    days: days ?? null, usage: summarize(store, { all: !here, days }) };
}

const num = n => Math.round(n).toLocaleString('en-US');
const entries = obj => Object.entries(obj).filter(([, n]) => n).map(([k, n]) => `${num(n)} ${k}`).join(' · ') || 'none';

export function renderStats(s) {
  const u = s.usage;
  const L = [`thinker stats · ${u.scope === 'machine' ? 'this machine' : 'this repository'} · ${s.days ? `last ${s.days} days` : 'all recorded history'}`, ''];
  const row = (label, value) => L.push(`  ${label.padEnd(20)} ${value}`);
  L.push('Activity');
  row('Requests', `${num(u.requests)} · ${num(u.sessions)} sessions`);
  row('Agents (requests)', entries(u.clients.active));
  if (!u.events) row('History', 'No usage recorded in this scope and period yet.');
  else row('Recorded dates', `${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}`);

  L.push('', 'Tokens');
  row('Learning', u.spending.calls ? `${formatTokens(u.spending.totalTokens)} reported · ${num(u.spending.calls)} model records` : 'No model usage recorded');
  if (u.spending.unknownTokenCalls || u.spending.legacyRecords) L.push('  Model token totals are incomplete: some records lack usage.');

  if (u.repos.length) {
    L.push('', 'Repositories with recorded activity');
    L.push(`  ${'Requests'.padStart(9)}  ${'Sessions'.padStart(9)}`);
    for (const r of u.repos.slice(0, 20)) L.push(`  ${r.repo}`, `  ${num(r.requests).padStart(9)}  ${num(r.sessions || 0).padStart(9)}`);
    if (u.repos.length > 20) L.push(`  + ${num(u.repos.length - 20)} more repositories; --json includes all.`);
  }

  L.push('', 'Current checkout', `  ${s.repo}`);
  if (!s.configured) row('Cache', 'Not set up · run thinker setup');
  else if (!s.profile) row('Profile', 'none yet · it grows from your sessions');
  else row('Profile', `${num(s.profile.observations)} observations from ${num(s.profile.sessions)} sessions · compiled ${String(s.profile.compiledAt || '').slice(0, 10)}`);
  L.push('', 'Use --here for this repository, --days 7 for recent activity, or --json for all data.', 'Run thinker usage for the token accounting, thinker profile show for the profile.');
  return L.join('\n');
}
