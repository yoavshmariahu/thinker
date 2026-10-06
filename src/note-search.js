import { createHash } from 'node:crypto';

// Descriptions are derived data. Equal-length edits must invalidate them too.
export const phraseKey = n => 's2:' + createHash('sha256').update(JSON.stringify([
  n.title, n.body, n.answers || [], n.applies || '',
  (n.deps || []).map(d => [d.path, d.symbol || '']),
])).digest('hex');

export const searchText = n => n.search && n.saysFor === phraseKey(n) ? n.search : (n.body || '');
