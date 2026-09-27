// Mine merged pull requests as a note source: fix records (symptom → root
// cause → fix pattern → constraints), invariants and conventions enforced in
// review. Uses the GitHub CLI; notes are anchored against the current tree.
import { execFileSync } from 'node:child_process';
import { complete } from './llm.js';
import { KINDS } from './store.js';

const gh = (...a) => execFileSync('gh', a, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

export function listMergedPrs(slug, { before, after, limit = 100 }) {
  const q = [`merged:<${before}`, after ? `merged:>=${after}` : ''].filter(Boolean).join(' ');
  return JSON.parse(gh('pr', 'list', '--repo', slug, '--state', 'merged', '--limit', String(limit), '--search', q, '--json', 'number,title,body,mergedAt,additions,files'));
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
