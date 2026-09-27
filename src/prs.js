// Mine merged pull requests as a note source: fix records (symptom → root
// cause → fix pattern → constraints), invariants and conventions enforced in
// review. Uses the GitHub CLI; notes are anchored against the current tree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.js';
import { KINDS } from './store.js';

const gh = (...a) => execFileSync('gh', a, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

export function listMergedPrs(slug, { before, after, limit = 100 }) {
  const q = [`merged:<${before}`, after ? `merged:>=${after}` : ''].filter(Boolean).join(' ');
  return JSON.parse(gh('pr', 'list', '--repo', slug, '--state', 'merged', '--limit', String(limit), '--search', q, '--json', 'number,title,body,mergedAt,additions,files'));
}

// The record of mined pull requests lives beside the notes (.thinker/prs.json) and is
// committed with them, so a teammate's run does not distill the same ones again.
//   { "<owner/repo>": { mined: [numbers], latest: <mergedAt>, oldest: <mergedAt> } }
const recordFile = store => path.join(path.dirname(store.notesDir), 'prs.json');

export function minedPrs(store, slug) {
  let all = {}; try { all = JSON.parse(fs.readFileSync(recordFile(store), 'utf8')); } catch {}
  const r = all[slug] || {};
  const mined = new Set(r.mined || []);
  // caches built before the record existed: the notes name the pull request they came from
  for (const n of store.list()) for (const s of [n.source, ...(n.history || []).map(h => h.source)]) {
    const m = s && s.type === 'pr' && String(s.ref || '').match(/^(.+)#(\d+)$/);
    if (m && m[1] === slug) mined.add(Number(m[2]));
  }
  return { mined, latest: r.latest || null, oldest: r.oldest || null };
}

export function recordMinedPrs(store, slug, prs) {
  if (!prs.length) return;
  const f = recordFile(store);
  let all = {}; try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const r = all[slug] || {};
  const dates = [r.latest, r.oldest, ...prs.map(p => p.mergedAt)].filter(Boolean).sort();
  all[slug] = { mined: [...new Set([...(r.mined || []), ...prs.map(p => p.number)])].sort((a, b) => a - b), latest: dates[dates.length - 1] || null, oldest: dates[0] || null };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(all, null, 1) + '\n');
}

// The next pull requests to mine, newest first: the most recent ones that are not in the
// record, whether merged since the last run or passed by when a busy repo outran the limit,
// then further back in history than any run has reached.
export function nextPrs(slug, rec, { limit = 20, now = new Date().toISOString(), list = listMergedPrs } = {}) {
  const fresh = prs => [...prs].sort((x, y) => String(y.mergedAt).localeCompare(String(x.mergedAt))).filter(p => !rec.mined.has(p.number));
  // the search limit counts pull requests already mined too, so ask for that many more (GitHub search stops at 1000)
  const out = fresh(list(slug, { before: now, limit: Math.min(limit + rec.mined.size, 1000) })).slice(0, limit);
  if (out.length < limit && rec.oldest) {
    const have = new Set(out.map(p => p.number));
    out.push(...fresh(list(slug, { before: rec.oldest, limit: limit - out.length })).filter(p => !have.has(p.number)).slice(0, limit - out.length));
  }
  return out;
}

function reviewComments(slug, n) {
  try {
    const cs = JSON.parse(gh('api', `repos/${slug}/pulls/${n}/comments?per_page=50`));
    return cs.filter(c => c.body && c.body.length > 40 && !/\[bot\]$/.test(c.user?.login || '')).slice(0, 12).map(c => `${c.path}: ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch { return []; }
}

const SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, kind: { type: 'string', enum: KINDS }, answers: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' }, applies: { type: 'string' },
    deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
    tags: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' },
  }, required: ['title', 'kind', 'answers', 'body', 'applies', 'deps', 'tags', 'confidence'] } } },
  required: ['notes'],
};

const SYSTEM = `You turn one merged pull request into 0-3 reusable notes for a knowledge cache that coding agents read before and while working in this repository. The reader is an agent facing a DIFFERENT future task in the same area.

Allowed kinds and what each must contain:
- fix: four labelled lines. "Symptom:" as a user would report it, in product vocabulary. "Root cause:" with file:symbol. "Fix pattern:" the kind of change that resolved it, general enough to reuse. "Constraints:" when the pattern applies and when it does not.
- invariant: a condition any change in this area must respect (permission/ownership checks, status or eligibility guards, feature-flag gating, things that must stay in sync, ordering). Say where it is enforced (file:symbol) and what breaks if skipped.
- convention: a local rule visible in the diff or enforced by a reviewer comment (naming, layering, where logic must live, generated files that must not be hand-edited, test placement).
- cochange: things this PR shows must change together (e.g. backend serializer + frontend type + generated client).

Rules:
- Only claims the diff, description or review comments support. No speculation.
- Do not restate the PR. A note that only says what this PR did is useless; extract what stays true afterwards.
- 3-8 lines per note, with file:symbol pointers to code that exists AFTER the PR. Paths must be exactly as in the diff.
- answers: 2-4 phrasings a future agent or user might use, including product-vocabulary phrasings of the symptom or feature.
- applies: one line on scope. confidence 0.8 when the diff shows it directly, 0.6 when inferred from description or comments.
- Return an empty list for dependency bumps, pure refactors, generated-file churn, or PRs with nothing reusable.`;

export async function distillPr(slug, pr, { model = 'sonnet' } = {}) {
  const diff = gh('pr', 'diff', String(pr.number), '--repo', slug).slice(0, 45000);
  const comments = reviewComments(slug, pr.number);
  const prompt = `PR #${pr.number}: ${pr.title}\n\nDESCRIPTION:\n${(pr.body || '').replace(/<!--[\s\S]*?-->/g, '').slice(0, 5000)}\n\nREVIEW COMMENTS:\n${comments.join('\n') || '(none)'}\n\nDIFF:\n${diff}`;
  const r = await complete({ system: SYSTEM, prompt, model, schema: SCHEMA, maxTokens: 6000 });
  return { notes: r.json?.notes || [], cost: r.cost };
}
