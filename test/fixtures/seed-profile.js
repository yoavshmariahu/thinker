// A profile a hook test can serve: one Working on line, compiled from one observation, written as profile.js writes it.
import fs from 'node:fs';
import path from 'node:path';
export function seedProfile(store, text = 'Rate limiting for uploads: src/upload.py:RateLimiter.allow keys on the user, never the IP.', { now = Date.now() } = {}) {
  const dir = path.join(store.localDir, 'profile');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(now).toISOString();
  const row = { id: 'obs-seed000000', at, seen: at, session: 'seed', client: 'claude', dirs: ['src'], turn: 1, request: 'rate limiting', kind: 'feature', approach: 'x', outcome: 'accepted', reaction: 'ok', lesson: '', prefs: [], topics: ['upload'], bug: '' };
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ version: 3, compiledAt: at, rebasedAt: at, model: 'fake', window: { days: 60, observations: 1, sessions: 1, from: at.slice(0, 10), to: at.slice(0, 10) }, sections: { workingOn: [{ id: 'w1', text, obs: [row.id], count: 1, firstSeen: at.slice(0, 10), lastSeen: at.slice(0, 10) }], howWeWork: [], whatFails: [], recentBugs: [] } }));
}
