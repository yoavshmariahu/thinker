#!/usr/bin/env node
// A stand-in model for local end-to-end runs of thinker-server (THINKER_LLM_CMD="node mock-llm.mjs").
// Reads the prompt on stdin and answers the JSON the request's schema asks for: distilled notes
// (with assessments of injected notes), a pull request's notes, a verification verdict, phrasings.
// The notes point at thinker's own code so they resolve against a checkout of this repository.
import fs from 'node:fs';
const input = fs.readFileSync(0, 'utf8');
const has = s => input.includes(s);
const note = (title, kind, body, dep) => ({ title, kind, answers: [`how does ${title.toLowerCase()} work`, title.toLowerCase()], body, applies: 'thinker itself', deps: [dep], tags: ['mock'], confidence: 0.85 });
let out;
if (has('still_valid')) out = { verdict: 'still_valid', reason: 'mock: unchanged in substance', body: '', confidence: 0.8 };
else if (has('"says"')) {
  const n = (input.match(/^\[(\d+)\] kind=/gm) || []).length || 1;
  out = { notes: Array.from({ length: n }, (_, i) => ({ n: i + 1, says: ['notes from one teammate show up for everyone', 'the cache is shared across the team'] })) };
} else if (has('REVIEW COMMENTS:')) {
  const pr = (input.match(/^(?:PR #|Commit )(\S+): (.+)$/m) || [])[0] || 'a pull request';
  out = { notes: [note('Repository identity comes from the origin url', 'invariant', `Every checkout of a repository is one repository: store.js:repoId normalizes the origin url (store.js:normalizeOrigin), so worktrees and clones share logs and sync as one. Learned while distilling ${pr.slice(0, 60)}.`, { path: 'src/store.js', symbol: 'repoId' })], };
} else {
  const assessIds = [...input.matchAll(/^id=([\w-]+) \[/gm)].map(m => m[1]);
  out = { notes: [note('Notes are stored one JSON file per note', 'location', 'store.js:Store writes each note to its own file with writeJson (atomic rename), under .thinker/notes for the committed tier and .thinker/local/notes for the checkout tier.', { path: 'src/store.js', symbol: 'Store' })] };
  if (has('"assessments"')) out.assessments = assessIds.map(id => ({ id, verdict: 'confirmed', evidence: 'mock: the agent read what the note points at', correction: '' }));
}
process.stdout.write(JSON.stringify(out) + '\n');
