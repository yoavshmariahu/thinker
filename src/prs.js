// Mine merged pull requests as a note source: fix records (symptom → root
// cause → fix pattern → constraints), invariants and conventions enforced in
// review. Uses the GitHub CLI; notes are anchored against the current tree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.js';
import { tokensOf } from './model-usage.js';
import { KINDS } from './store.js';
import { directoryPathspecs } from './project.js';

const gh = (...a) => execFileSync('gh', a, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

export function listMergedPrs(slug, { before, after, limit = 100 }) {
  const q = [`merged:<${before}`, after ? `merged:>=${after}` : ''].filter(Boolean).join(' ');
  return JSON.parse(gh('pr', 'list', '--repo', slug, '--state', 'merged', '--limit', String(limit), '--search', q, '--json', 'number,title,body,mergedAt,additions,files'));
}

// Changes whose message says they fix something: the records review draws on most (bench/RESULTS.md,
// "Review strategies": the one PostHog bug the notes caught over the baseline came from a fix PR's
// note). `thinker mine-prs --fixes` keeps only these; a repository developed by direct commits has
// no pull requests, and its fix commits are what review wants.
export const FIX_LIKE = /\b(fix(e[sd])?|bug|regression|crash|broke|broken|wrong|incorrect|leak|race|hang|flak\w*|off[- ]by[- ]one|corrupt\w*)\b/i; // not "stale" or "revert": a word of this repository, and a revert is not a fix record
export function listMergedCommits(repo, { before, after, limit = 100, directories = null } = {}) {
  const args = ['log', '--first-parent', '-n', String(Math.max(limit * 2, 60)), '--format=%H%x1f%P%x1f%aI%x1f%s%x1f%b%x1e'];
  if (before) args.push(`--before=${before}`);
  if (after) args.push(`--after=${after}`);
  if (directories) args.push('--', ...directoryPathspecs(directories));

  let raw = '';
  try {
    raw = execFileSync('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }

  const entries = raw.split('\x1e').map(s => s.trim()).filter(Boolean);
  const candidates = [];

  for (const entry of entries) {
    const [hash, parents = '', date = '', subject = '', body = ''] = entry.split('\x1f');
    if (!hash || !subject) continue;

    const parentList = parents.split(' ').filter(Boolean);
    let title = subject;
    let cleanBody = body.trim();

    // If it's a merge commit, pull the subject & body from the merged branch
    if (parentList.length > 1) {
      try {
        const branchLog = execFileSync('git', ['log', `${parentList[0]}..${parentList[1]}`, '--format=%s%n%b'], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (branchLog) {
          const lines = branchLog.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length) {
            title = lines[0];
            cleanBody = (lines.slice(1).join('\n').trim() || cleanBody);
          }
        }
      } catch {}
    }

    const prMatch = subject.match(/Merge pull request #(\d+)/i) ||
                    title.match(/\(#(\d+)\)/) ||
                    subject.match(/\(#(\d+)\)/) ||
                    cleanBody.match(/\(#(\d+)\)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

    let additions = 0;
    const files = [];
    try {
      const numstat = execFileSync('git', ['show', '-m', '--first-parent', '--numstat', '--format=', hash], {
        cwd: repo,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of numstat.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const added = parseInt(parts[0], 10);
          if (!isNaN(added)) additions += added;
          files.push(parts.slice(2).join(' '));
        }
      }
    } catch {}

    candidates.push({
      number: prNumber || parseInt(hash.slice(0, 8), 16),
      prNumber,
      hash,
      title,
      body: cleanBody,
      mergedAt: date,
      additions,
      files,
      isGitCommit: true,
    });
  }

  return candidates;
}

// The record of mined pull requests lives beside the notes (.thinker/prs.json) and is
// committed with them, so a teammate's run does not distill the same ones again.
//   { "<owner/repo>": { mined: [numbers], latest: <mergedAt>, oldest: <mergedAt> } }
const recordFile = store => path.join(path.dirname(store.notesDir), 'prs.json');

export function minedPrs(store, slug) {
  slug = slug || 'local';
  let all = {}; try { all = JSON.parse(fs.readFileSync(recordFile(store), 'utf8')); } catch {}
  const r = all[slug] || {};
  const mined = new Set(r.mined || []);
  // caches built before the record existed: the notes name the pull request they came from
  for (const n of store.list()) for (const s of [n.source, ...(n.history || []).map(h => h.source)]) {
    const m = s && s.type === 'pr' && String(s.ref || '').match(/^(.+)#(.+)$/);
    if (m && m[1] === slug) {
      const val = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
      mined.add(val);
    }
  }
  // A partially saved PR is not complete just because one note names its source.
  for (const id of r.retry || []) {
    mined.delete(id);
    if (typeof id === 'string' && !isNaN(Number(id))) mined.delete(Number(id));
  }
  return { mined, latest: r.latest || null, oldest: r.oldest || null };
}

export function recordMinedPrs(store, slug, prs, { failed = [] } = {}) {
  slug = slug || 'local';
  if (!prs.length && !failed.length) return;
  const f = recordFile(store);
  let all = {}; try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const r = all[slug] || {};
  const dates = [r.latest, r.oldest, ...prs.map(p => p.mergedAt)].filter(Boolean).sort();
  const ids = prs.map(p => p.prNumber || (p.hash ? p.hash.slice(0, 8) : p.number));
  const retry = new Set((r.retry || []).filter(id => !ids.includes(id)));
  for (const p of failed) retry.add(p.prNumber || (p.hash ? p.hash.slice(0, 8) : p.number));
  all[slug] = {
    ...(retry.size ? { retry: [...retry] } : {}),
    mined: [...new Set([...(r.mined || []), ...ids])].filter(id => !retry.has(id)).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    }),
    latest: dates[dates.length - 1] || null,
    oldest: dates[0] || null,
  };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(all, null, 1) + '\n');
}

// The next pull requests to mine, newest first: the most recent ones that are not in the
// record, whether merged since the last run or passed by when a busy repo outran the limit,
// then further back in history than any run has reached.
export function nextPrs(slug, rec, { limit = 20, now = new Date().toISOString(), list = listMergedPrs, repo } = {}) {
  const fetcher = (s, opts) => repo && list === listMergedCommits ? list(repo, opts) : list(s, opts);
  const fresh = prs => [...prs].sort((x, y) => String(y.mergedAt).localeCompare(String(x.mergedAt))).filter(p => !rec.mined.has(p.number) && (!p.hash || !rec.mined.has(p.hash.slice(0, 8))));
  // the search limit counts pull requests already mined too, so ask for that many more (GitHub search stops at 1000)
  const out = fresh(fetcher(slug, { before: now, limit: Math.min(limit + rec.mined.size, 1000) })).slice(0, limit);
  if (out.length < limit && rec.oldest) {
    const have = new Set(out.map(p => p.number));
    out.push(...fresh(fetcher(slug, { before: rec.oldest, limit: limit - out.length })).filter(p => !have.has(p.number)).slice(0, limit - out.length));
  }
  return out;
}

// Stratify candidate PRs across subsystems and prioritize high-signal bug fixes and invariants.
export function stratifyPrs(prs, limit = 20) {
  if (prs.length <= limit) return prs;
  const groups = new Map();
  for (const pr of prs) {
    const files = pr.files || [];
    let sub = 'general';
    for (const f of files) {
      const p = (typeof f === 'string' ? f : f.path || '').replace(/\\/g, '/');
      const parts = p.split('/');
      if (parts.length > 2) {
        sub = parts.slice(0, 2).join('/');
        break;
      } else if (parts.length === 2) {
        sub = parts[0];
        break;
      }
    }
    if (!groups.has(sub)) groups.set(sub, []);
    groups.get(sub).push(pr);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => {
      const aFix = FIX_LIKE.test(a.title) ? 2 : 0;
      const bFix = FIX_LIKE.test(b.title) ? 2 : 0;
      const aBody = (a.body || '').length > 250 ? 1 : 0;
      const bBody = (b.body || '').length > 250 ? 1 : 0;
      return (bFix + bBody) - (aFix + aBody) || String(b.mergedAt).localeCompare(String(a.mergedAt));
    });
  }

  const selected = [];
  const groupKeys = [...groups.keys()];
  let idx = 0;
  while (selected.length < limit && groupKeys.length > 0) {
    const key = groupKeys[idx % groupKeys.length];
    const group = groups.get(key);
    if (group && group.length > 0) {
      selected.push(group.shift());
      if (group.length === 0) {
        groups.delete(key);
        groupKeys.splice(idx % groupKeys.length, 1);
        continue;
      }
    }
    idx++;
  }
  return selected;
}

// Which of the candidates to distill this run: fixes first, since the record of a fix is what a
// review draws on most (on the PostHog regressions every bug the cache caught and the diff alone
// missed rested on a note mined from the fix; bench/RESULTS.md, "Real bugs on PostHog"), up to two
// thirds of the run when other changes wait, so a busy repository's features are not starved; the
// rest stratified across subsystems as before. A candidate passed over is not recorded as mined
// (learn.js:minePrs), so it is offered again next run rather than lost to the cap.
export function pickPrs(candidates, limit = 20) {
  const isFix = p => FIX_LIKE.test(`${p.title}\n${(p.body || '').slice(0, 400)}`);
  const fixes = candidates.filter(isFix), rest = candidates.filter(p => !isFix(p));
  const share = rest.length ? Math.max(1, Math.ceil(limit * 2 / 3), limit - rest.length) : limit; // the rest fills what is left, never idle slots
  const first = stratifyPrs(fixes, Math.min(share, limit));
  return [...first, ...stratifyPrs(rest, limit - first.length)];
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
    title: { type: 'string' }, kind: { type: 'string', enum: KINDS.filter(k => k !== 'behavior') }, answers: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' }, applies: { type: 'string' },
    deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
    tags: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' },
    extends: { type: 'string', description: 'Existing note id when adding to its rule; body must preserve every existing claim, scope limit and exception. Empty for a new note.' },
  }, required: ['title', 'kind', 'answers', 'body', 'applies', 'deps', 'tags', 'confidence'] } } },
  required: ['notes'],
};

const SYSTEM = `You turn one merged pull request into 0-3 reusable notes for a knowledge cache that coding agents read before and while working in this repository. The reader is an agent facing a DIFFERENT future task in the same area.

Allowed kinds and what each must contain:
- rule (most of what a pull request teaches): a bug that was fixed, as four labelled lines, "Symptom:" as a user would report it in product vocabulary, "Root cause:" with file:symbol, "Fix pattern:" the kind of change that resolved it, general enough to reuse, "Constraints:" when the pattern applies and when it does not; an invariant any change in this area must respect (permission/ownership checks, status or eligibility guards, feature-flag gating, things that must stay in sync, ordering), with where it is enforced (file:symbol) and what breaks if skipped; a local convention visible in the diff or enforced by a reviewer comment (naming, layering, where logic must live, generated files that must not be hand-edited, test placement); or things this PR shows must change together because of a mechanism (a serializer and the type generated from it, a registry and its entries), naming the mechanism.
- map: where a concern this PR touched is handled, when the diff makes that clearer than the code alone.
- howto: a way of building, testing or running that the PR introduced or relies on, with its non-obvious flags.

Rules:
- Only claims the diff, description or review comments support. No speculation. Prefer 1-2 narrow notes over a broad summary.
- Each body line states one independently supported fact. Do not infer a symptom, root cause, security exploit, universal convention or future requirement merely because code changed. If the symptom/root cause is not documented, write a direct invariant or mechanism instead of inventing the four bug-fix labels.
- Titles and applicability must be no broader than the demonstrated facts. Keep historical before-change behavior explicitly separate from the resulting behavior.
- Do not restate the PR. A note that only says what this PR did is useless; extract what stays true afterwards.
- 1-3 concise lines per note, with file:symbol pointers to code that exists AFTER the PR. Paths must be exactly as in the diff. A dep on a code file names the definition it rests on (symbol); a dep on a whole file is for configs, scripts and documents only, since a whole code file changes with every unrelated commit.
- answers: 2-4 phrasings a future agent or user might use, including product-vocabulary phrasings of the symptom or feature.
- applies: one line on scope. confidence 0.8 when the diff shows it directly, 0.6 when inferred from description or comments.
- Return an empty list for dependency bumps, pure refactors, generated-file churn, or PRs with nothing reusable.`;

export async function distillPr(slug, pr, { model = 'sonnet', repo, accounting, existing = [] } = {}) {
  let diff = pr.diff || '';
  if (!diff && repo && pr.hash) {
    try {
      diff = execFileSync('git', ['show', '-m', '--first-parent', '--format=', pr.hash], {
        cwd: repo,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {}
  }
  if (!diff && slug && pr.number && !pr.isGitCommit) {
    try {
      diff = gh('pr', 'diff', String(pr.number), '--repo', slug);
    } catch {}
  }
  diff = (diff || '').slice(0, 45000);
  // review comments: as given (CI sends them with the diff), else from GitHub
  const comments = Array.isArray(pr.comments) ? pr.comments : slug && !pr.isGitCommit ? reviewComments(slug, pr.number) : [];
  const label = pr.prNumber ? `PR #${pr.prNumber}` : (pr.hash ? `Commit ${pr.hash.slice(0, 8)}` : `PR #${pr.number}`);
  const evidence = `${label}: ${pr.title}\n\nDESCRIPTION:\n${(pr.body || '').replace(/<!--[\s\S]*?-->/g, '').slice(0, 5000)}\n\nREVIEW COMMENTS:\n${comments.join('\n') || '(none)'}\n\nDIFF:\n${diff}`;
  const prompt = evidence + (existing.length ? '\n\nEXISTING NOTES (context, not source evidence):\n' + existing.map(n => `id=${n.id} [${n.kind}] ${n.title}\n${n.body || ''}\nApplies: ${n.applies || '(unspecified)'}`).join('\n\n') + '\nDo not repeat covered understanding. For an extension, return extends: id and a complete merged body preserving existing constraints. Do not rewrite human behavior notes or resolve contradictions automatically.' : '');
  const r = await complete({ system: SYSTEM, prompt, model, schema: SCHEMA, maxTokens: 6000, accounting });
  return { notes: r.json?.notes || [], cost: r.cost, tokens: tokensOf(r), evidence };
}
