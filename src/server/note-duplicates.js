import { kindOf } from '../store.js';
import { tokenize } from '../rank.js';

export function nearDuplicate(a, b) {
  if (kindOf(a.kind) !== kindOf(b.kind)) return false;
  const words = n => new Set(tokenize(`${n.title || ''} ${Array.isArray(n.answers) ? n.answers.join(' ') : ''}`));
  const x = words(a), y = words(b), union = new Set([...x, ...y]);
  return union.size > 0 && [...x].filter(w => y.has(w)).length / union.size >= 0.5;
}

