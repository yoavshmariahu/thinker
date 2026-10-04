#!/usr/bin/env node
// Regression cases for review-eval: fix commits merged before the base (the commit the noteset was
// built at) whose revert still applies to it, so the bug the fix removed comes back as the change
// under review. Marked with whether the noteset holds a note mined from that very pull request
// (`noted`: the cache knows the fix) so the two can be reported apart.
//
//   node bench/review-eval-mine-reverts.js --repo bench/repos/posthog --base a3b3c3685bc --notes bench/notesets/posthog-v3/notes
//        [--days 21] [--max-fix-lines 120] [--limit 30] --out file.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { FIX_LIKE } from '../src/prs.js';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const repo = path.resolve(flags.repo || 'bench/repos/posthog'), base = String(flags.base), notesDir = flags.notes ? path.resolve(flags.notes) : null;
const days = Number(flags.days || 21), maxFixLines = Number(flags['max-fix-lines'] || 120), limit = Number(flags.limit || 30);
const git = (args, cwd = repo) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }); } catch (e) { return null; } };
const CODE = /\.(py|ts|tsx|js|jsx|mjs|go|rs|rb|java|kt|cs|sql)$/;
const SKIP = /(^|\/)(test|tests|__tests__|__snapshots__|stories|fixtures|migrations)(\/|$)|\.(test|spec|stories)\.|_test\.|test_|\.snap$|\.generated\.|\.d\.ts$|schema\.json|\.lock$/;
const isCode = p => CODE.test(p) && !SKIP.test(p);
const prNumber = s => { const m = s.match(/\(#(\d+)\)\s*$/); return m ? Number(m[1]) : null; };

const noted = new Map(); // pr -> kinds of the notes mined from it
if (notesDir) for (const f of fs.readdirSync(notesDir)) {
  if (!f.endsWith('.json')) continue;
  try { const n = JSON.parse(fs.readFileSync(path.join(notesDir, f), 'utf8')); const m = String(n.source?.ref || '').match(/#(\d+)/); if (n.source?.type === 'pr' && m) (noted.get(Number(m[1])) || noted.set(Number(m[1]), []).get(Number(m[1]))).push(n.kind); } catch {}
}
const baseSha = git(['rev-parse', base]).trim();
const baseDate = git(['log', '-1', '--format=%cI', baseSha]).trim();
const since = new Date(new Date(baseDate).getTime() - days * 86400e3).toISOString();
const log = git(['log', '--first-parent', `--since=${since}`, '--format=%H%x09%ad%x09%s', '--date=short', baseSha]).trim().split('\n').filter(Boolean).map(l => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject, pr: prNumber(subject) }; });
const fixes = log.filter(c => c.pr && (FIX_LIKE.test(c.subject) || noted.has(c.pr)) && !/^revert/i.test(c.subject) && c.sha !== baseSha);
process.stderr.write(`${log.length} commits in the ${days} days before ${base}; ${fixes.length} fixes or noted PRs (${fixes.filter(f => noted.has(f.pr)).length} noted)\n`);

const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-revert-'));
git(['worktree', 'add', '-f', '--detach', wt, baseSha]);
const cases = [];
try {
  for (const f of fixes.sort((a, b) => (noted.has(b.pr) ? 1 : 0) - (noted.has(a.pr) ? 1 : 0))) {
    if (cases.length >= limit) break;
    const numstat = (git(['show', '--numstat', '--format=', f.sha]) || '').trim().split('\n').filter(Boolean).map(l => l.split('\t'));
    const codeFiles = numstat.filter(([a, r, p]) => a !== '-' && isCode(p));
    const lines = codeFiles.reduce((t, [a, r]) => t + Number(a) + Number(r), 0);
    if (!codeFiles.length || lines > maxFixLines || numstat.length > 12) continue;
    const fixLike = FIX_LIKE.test(f.subject);
    if (!fixLike && !/fix|bug|correct|handle|guard|prevent|avoid|ensure|stop|missing|wrong/i.test(f.subject)) continue;
    git(['reset', '-q', '--hard', baseSha], wt); git(['clean', '-qfd'], wt);
    const ok = git(['-c', 'core.hooksPath=/dev/null', 'revert', '--no-commit', '--no-edit', f.sha], wt);
    if (ok === null) { git(['revert', '--abort'], wt); git(['reset', '-q', '--hard', baseSha], wt); continue; }
    const changed = (git(['diff', '--cached', '--numstat'], wt) || '').trim().split('\n').filter(Boolean).map(l => l.split('\t')[2]);
    if (!changed.some(isCode)) continue;
    cases.push({ id: `V-${f.pr}-${f.subject.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').replace(/\s*\(#\d+\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`, kind: 'revert', pr: f.pr, sha: f.sha.slice(0, 11), date: f.date, subject: f.subject, noted: noted.get(f.pr) || [], size: { lines, files: codeFiles.length } });
    process.stderr.write(`  ${f.date} #${f.pr} ${noted.has(f.pr) ? `[noted: ${noted.get(f.pr).join(',')}]` : '[no note]'} ${lines}L ${codeFiles.length}f  ${f.subject.slice(0, 80)}\n`);
  }
} finally { git(['worktree', 'remove', '--force', wt]); }
process.stderr.write(`${cases.length} revert cases (${cases.filter(c => c.noted.length).length} with a note from the fix PR)\n`);
const doc = { repo: path.basename(repo), base, minedAt: new Date().toISOString().slice(0, 10), cases };
if (flags.out) { fs.writeFileSync(path.resolve(flags.out), JSON.stringify(doc, null, 1) + '\n'); process.stderr.write(`wrote ${flags.out}\n`); } else process.stdout.write(JSON.stringify(doc, null, 1) + '\n');
