// Anchoring guard: identifiers the request mentions that none of the served
// notes cover. The agent tends to stop exploring once it has a pointer, so we
// name what the notes do NOT cover and ask it to search for those.
import { execFileSync } from 'node:child_process';

const TRIGGER = /\b(option|options|setting|settings|flag|flags|config|command|field|property|hook|event|env(?:ironment)? var(?:iable)?|parameter|param|endpoint|route|cookie|header|metric|action|reducer|model|table|column)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'into', 'not', 'are', 'was', 'were', 'its', 'has', 'have', 'been', 'should', 'would', 'could', 'make', 'sure', 'like', 'also', 'them', 'then', 'than', 'only', 'each', 'both', 'does', 'did', 'new', 'old']);

// Explicit identifiers: snake_case, camelCase, dotted, CONSTANTS, backticked, file-ish.
export function explicitIdents(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/\b([a-z]+_[a-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][A-Z0-9]+_[A-Z0-9_]+|[\w-]+\.(?:py|ts|tsx|js|jsx|go|rs|rb|java|yaml|yml|json|toml))\b/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([a-z_]\w*\.[a-z_]\w*(?:\.[a-z_]\w*)*)\b/g)) if (!/^\d|\.(com|org|io|net)$/.test(m[1])) out.add(m[1]);
  for (const m of text.matchAll(/(--[a-z][\w-]+)/g)) out.add(m[1]);
  return [...out].filter(s => s.length >= 3 && !/^(e\.g|i\.e)/.test(s));
}

// Phrases next to trigger words ("reverse view order option") → snake_case
// permutations; kept only if they exist in the repo.
export function phraseCandidates(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9_\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const cands = new Set();
  for (let i = 0; i < words.length; i++) {
    if (!TRIGGER.test(words[i])) continue;
    // only the words immediately before the trigger ("reverse view order option")
    // or immediately after it ("option view_order_reversed"), 2-3 content words
    const before = words.slice(Math.max(0, i - 3), i).filter(w => !STOP.has(w) && w.length > 2 && !TRIGGER.test(w));
    const after = words.slice(i + 1, i + 3).filter(w => !STOP.has(w) && w.length > 2 && !TRIGGER.test(w));
    for (const seg of [before.slice(-2), before.slice(-3), after.slice(0, 2)]) {
      if (seg.length < 2) continue;
      for (const p of perms(seg)) { const c = p.join('_'); if (c.length >= 10) cands.add(c); }
    }
  }
  return [...cands].slice(0, 40);
}
function perms(a) { if (a.length <= 1) return [a]; const out = []; for (let i = 0; i < a.length; i++) for (const p of perms([...a.slice(0, i), ...a.slice(i + 1)])) out.push([a[i], ...p]); return out; }

export function existsInRepo(repo, ident) {
  try {
    const r = execFileSync('git', ['grep', '-I', '-l', '--fixed-strings', '--', ident], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 }).toString().trim();
    return r ? r.split('\n').length : 0;
  } catch { return 0; }
}

// Returns {uncovered: [{ident, files}], text}
export function anchoringGuard(repo, task, servedNotes, { maxGreps = 40, explicitOnly = false, max = 6 } = {}) {
  const covered = servedNotes.map(n => `${n.title} ${n.body} ${(n.deps || []).map(d => d.path + ' ' + (d.symbol || '')).join(' ')}`).join('\n').toLowerCase();
  const isCovered = id => covered.includes(id.toLowerCase()) || (id.includes('.') && covered.includes(id.split('.').pop().toLowerCase()));
  const uncovered = [];
  let greps = 0;
  const seen = new Set();
  for (const id of [...explicitIdents(task), ...(explicitOnly ? [] : phraseCandidates(task))]) {
    if (seen.has(id) || isCovered(id)) continue;
    seen.add(id);
    if (greps++ >= maxGreps) break;
    const files = existsInRepo(repo, id);
    if (files > 0) uncovered.push({ ident: id, files });
    if (uncovered.length >= max) break;
  }
  const text = uncovered.length ? `Not covered by these notes, present in the repo: ${uncovered.map(u => `\`${u.ident}\` (${u.files} file${u.files > 1 ? 's' : ''})`).join(', ')}` : '';
  return { uncovered, text };
}
