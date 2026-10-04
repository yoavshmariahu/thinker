#!/usr/bin/env node
// Real bugs for review-eval: the pull requests that introduced them. For every fix commit merged
// since a base (the commit the noteset was built at), the lines the fix removed are blamed on the
// parent of the fix; when most of them came from one commit that is itself after the base, that
// commit is the bug-introducing pull request, and reviewing it as a commit scope is the question
// "would thinker review have caught this at pull request time, with this cache". The expected
// lines are where the blamed lines sit in the inducing commit's version of the file (git's
// `orig_line`), so the harness's hit rule (an error or warning within six lines) applies unchanged.
//
//   node bench/review-eval-mine.js --repo bench/repos/posthog --base a3b3c3685bc [--head origin/master]
//        [--max-fix-lines 80] [--max-pr-lines 1500] [--max-pr-files 40] [--min-share 0.6] [--limit 30]
//        [--controls 10] --out bench/review-eval-cases-posthog-inducing.json
//
// Controls: non-fix commits in the same range that no later fix blamed, matched in size.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIX_LIKE } from '../src/prs.js';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const repo = path.resolve(flags.repo || 'bench/repos/posthog');
const base = String(flags.base || ''); if (!base) { console.error('--base required'); process.exit(1); }
const head = String(flags.head || 'origin/master');
const maxFixLines = Number(flags['max-fix-lines'] || 80), maxPrLines = Number(flags['max-pr-lines'] || 1500), maxPrFiles = Number(flags['max-pr-files'] || 40), minShare = Number(flags['min-share'] || 0.6), limit = Number(flags.limit || 30), controls = Number(flags.controls || 10);
const git = args => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch { return ''; } };
const CODE = /\.(py|ts|tsx|js|jsx|mjs|go|rs|rb|java|kt|cs|sql)$/;
const SKIP = /(^|\/)(test|tests|__tests__|__snapshots__|stories|fixtures|migrations)(\/|$)|\.(test|spec|stories)\.|_test\.|test_|\.snap$|\.generated\.|\.d\.ts$|schema\.json|\.lock$/;
const isCode = p => CODE.test(p) && !SKIP.test(p);
const prNumber = subject => { const m = subject.match(/\(#(\d+)\)\s*$/); return m ? Number(m[1]) : null; };

function stat(sha) {
  const out = git(['show', '--numstat', '--format=', sha]).trim().split('\n').filter(Boolean);
  let added = 0, removed = 0; const files = [];
  for (const l of out) { const [a, r, f] = l.split('\t'); if (a === '-' || !f) continue; files.push(f); if (isCode(f)) { added += Number(a); removed += Number(r); } }
  return { added, removed, files, codeFiles: files.filter(isCode) };
}

// The ranges of lines a fix removed or replaced, per file, in the parent's numbering; an addition
// with no removal is anchored to the line before it.
function removedRanges(sha) {
  const text = git(['diff', '--no-color', '-U0', `${sha}^`, sha, '--', '.']);
  const ranges = {}; let file = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^diff --git a\/(.*) b\/(.*)$/); // the header, not a removed line that happens to start with "--"
    if (h) { file = h[1]; continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m && file && isCode(file)) {
      const start = Number(m[1]), len = m[2] === undefined ? 1 : Number(m[2]);
      (ranges[file] ||= []).push(len ? [start, start + len - 1] : [Math.max(1, start), Math.max(1, start)]);
    }
  }
  return ranges;
}

function blame(sha, file, ranges) {
  const args = ['blame', '--line-porcelain', '-w', '-M', '-C'];
  for (const [a, b] of ranges) args.push('-L', `${a},${b}`);
  const out = git([...args, `${sha}^`, '--', file]);
  const hits = []; // {sha, origLine, origFile}
  let cur = null;
  for (const l of out.split('\n')) {
    const h = l.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (h) { cur = { sha: h[1], origLine: Number(h[2]), origFile: file }; hits.push(cur); continue; }
    if (cur && l.startsWith('filename ')) cur.origFile = l.slice(9);
  }
  return hits;
}


// Controls: non-fix commits of similar size, never blamed by any fix in the range, oldest first so
// they sit close to the base.
const sizes = cases.map(c => c.size.lines);
const median = sizes.length ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 300;
const ctrl = [];
for (const c of [...log].reverse()) {
  if (ctrl.length >= controls) break;
  if (FIX_LIKE.test(c.subject) || /^(revert|chore\(deps\)|chore: update|chore\(release\))/i.test(c.subject) || !c.pr || blamed.has(c.sha)) continue;
  const s = stat(c.sha);
  if (!s.codeFiles.length || s.added + s.removed < median / 3 || s.added + s.removed > Math.max(maxPrLines, median * 2) || s.codeFiles.length > maxPrFiles) continue;
  ctrl.push({ id: `C-${c.pr}`, kind: 'commit', sha: c.sha.slice(0, 11), pr: c.pr, date: c.date, subject: c.subject, size: { lines: s.added + s.removed, files: s.codeFiles.length } });
}
process.stderr.write(`${cases.length} inducing cases, ${ctrl.length} controls (median inducing size ${median} lines)\n`);
const outFile = flags.out ? path.resolve(flags.out) : null;
const doc = { repo: path.basename(repo), base, head: git(['rev-parse', head]).trim().slice(0, 11), minedAt: new Date().toISOString().slice(0, 10), cases: [...cases, ...ctrl] };
if (outFile) { fs.writeFileSync(outFile, JSON.stringify(doc, null, 1) + '\n'); process.stderr.write(`wrote ${outFile}\n`); } else process.stdout.write(JSON.stringify(doc, null, 1) + '\n');
