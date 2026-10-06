// Select historical Autoscaler fixes before reviewing any model outputs.
// Each selected PR must be a small code fix whose net merge diff can be reversed
// cleanly at the fixed base. This keeps the candidate set deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = process.argv[2];
const output = process.argv[3];
if (!repo || !output) throw new Error('usage: node select.mjs <autoscaler-repo> <output.json>');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const base = git(['rev-parse', 'HEAD']).trim();
const commits = git(['log', '--first-parent', '--since=2026-05-01', '--format=%H%x09%s', base]).trim().split('\n');
const cases = [];
for (const row of commits) {
  if (cases.length === 10) break;
  const [sha, subject] = row.split('\t');
  const match = subject?.match(/^Merge pull request #(\d+) from .*\b(fix|bug|regress|panic|missing|wrong)\b/i);
  if (!match) continue;
  const pr = Number(match[1]);
  const parent = git(['rev-parse', `${sha}^1`]).trim();
  const numstat = git(['diff', '--numstat', parent, sha]).trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  const production = numstat.filter(([added, removed, file]) => added !== '-' && removed !== '-' && file.endsWith('.go') && !file.endsWith('_test.go') && !/(^|\/)(test|tests|e2e)(\/|$)/.test(file));
  const codeLines = production.reduce((sum, [added, removed]) => sum + Number(added) + Number(removed), 0);
  const totalLines = numstat.reduce((sum, [added, removed]) => sum + (added === '-' ? 0 : Number(added)) + (removed === '-' ? 0 : Number(removed)), 0);
  if (!production.length || codeLines > 120 || totalLines > 200 || numstat.length > 10) continue;
  const patch = git(['diff', '--binary', parent, sha]);
  const check = spawnSync('git', ['apply', '--reverse', '--check', '-'], { cwd: repo, input: patch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (check.status !== 0) continue;
  cases.push({ id: `A-${pr}`, pr, sha, parent, subject, codeLines, totalLines, files: numstat.map(([, , file]) => file) });
}
const result = { repo: 'kubernetes/autoscaler', base, rule: 'Newest first-parent merge since 2026-05-01 with a fix-like branch name, 1–120 changed production Go lines (excluding test/e2e paths), <=200 total changed lines, <=10 files, and a clean reverse application at the fixed base; first 10.', cases };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
