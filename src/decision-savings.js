// Which Find Savings decisions count as a saving, and for how long: the half of the `decisions` series that reads the
// machine (the history, the instruction file, git). The arithmetic is report-savings.js:decisionSavings, which is given
// what this returns and reads nothing itself.
//
// A decision counts only where what it took out can be stated without a guess:
// - **A section change that merged**, of the repository's root instruction file, by the tokens the edit itself
//   recorded (`tokens.before - tokens.after`). The merge commit is what lets a session's checkout be asked whether it
//   holds the change, so a change written to one working tree and never merged is not counted: nothing says which
//   checkouts have it, or whether it was kept. A file in a directory below is read only by the sessions that open
//   something there, which the log does not tell, so it is not counted either.
// - **A machine-wide switch turned off** (a tool, a server), by the tokens a prompt it was measured at when it was
//   decided (`saving`), in the sessions of its own agent. A switch kept in one checkout's settings is not counted.
// - **Never a tool's output.** Those are the tokens the clearing removes, and its series may already hold them.
// Each from when it took effect (report.js's own effectSpan) until it was reverted, the same thing was decided again,
// or DECISION_DAYS passed -- and a section only for what it is still smaller by (sectionSteps).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changeHistory } from './context-suggest.js';
import { instructionFile, sections, sectionId } from './instruction-value.js';
import { DECISION_DAYS } from './report-savings.js';
import { Store, repoId } from './store.js';

const DAY = 86400_000;

// From when an action is in effect, and until when: a dismissal and a pull request not merged never were, nor a section's
// change still running in the background or failed (context-suggest.js:startSectionJob); a merged one from its merge; a
// change written when its job was done from then; anything else from the decision, until it was reverted.
export const effectSpan = (e, now) => e.decision === 'dismissed' || (e.job && e.job.state !== 'done') ? null
  : e.pr ? (e.pr.state === 'merged' && e.pr.at ? { from: Date.parse(e.pr.at), to: now } : null)
  : { from: Date.parse(e.job?.finishedAt || e.at), to: e.revertedAt ? Date.parse(e.revertedAt) : now };

// The decisions of one checkout's history that count, as decisionSavings takes them.
export function decisionsOf(store, { now = Date.now(), history } = {}) {
  // no `git merge-base` per entry and no banner to draw: whether this checkout has pulled a change is the page's business
  try { history ??= changeHistory(store, { now, git: () => null }); } catch { return []; }
  let root; const rootFile = () => (root === undefined ? (root = (() => { try { return instructionFile(store.repo); } catch { return null; } })()) : root);
  const origin = repoId(store.repo), out = [];
  for (const e of history) {
    const span = effectSpan(e, now);
    if (!span || !Number.isFinite(span.from)) continue;
    // a later decision on the same thing takes over from where it is in effect (report.js:withEffects), a revert ends
    // a merged change as it ends any other, and the horizon ends them all
    const later = history.filter(o => o !== e && o.key === e.key && Date.parse(o.at) > Date.parse(e.at)).map(o => effectSpan(o, now)?.from).filter(Number.isFinite);
    const to = Math.min(span.to, span.from + DECISION_DAYS * DAY, ...later, ...(e.revertedAt ? [Date.parse(e.revertedAt)] : []));
    if (!(to > span.from)) continue;
    const row = { id: e.id || `${e.at}:${e.key}`, key: e.key, kind: e.kind, from: span.from, to };
    if (e.kind === 'section') {
      const tokens = (e.tokens?.before ?? NaN) - (e.tokens?.after ?? NaN), f = rootFile();
      if (!(tokens > 0) || !e.pr?.mergeCommit || !f || f.file !== (e.file || '')) continue;
      out.push({ ...row, origin, tokens, commit: e.pr.mergeCommit, repo: store.repo, before: e.tokens.before, removed: e.act === 'remove' || e.tokens.after === 0, file: f.file, section: String(e.key).slice(`section:${f.file}:`.length).toLowerCase(), ...(f.onlyClients ? { onlyClients: f.onlyClients } : { notClients: f.notClients || [] }) });
    } else if (e.kind !== 'output' && e.scope === 'machine' && e.act === 'off' && e.saving > 0) {
      out.push({ ...row, origin: null, tokens: e.saving, onlyClients: [String(e.key).split(':')[0]] });
    }
  }
  return out;
}

// Every checkout the machine's log has named, for the footer's ledger: each decision once (a machine-wide one is in
// every checkout's history; a repository's worktrees may share one).
export function machineDecisions(events, { now = Date.now() } = {}) {
  const seen = new Set(), out = [], checkouts = new Set();
  for (const e of events) if (e.repo) checkouts.add(e.repo);
  for (const checkout of checkouts) {
    try {
      if (!fs.existsSync(path.join(checkout, '.thinker'))) continue;
      for (const d of decisionsOf(new Store(checkout, { readonly: true }), { now })) {
        const k = `${d.origin || ''}:${d.id}`;
        if (!seen.has(k)) { seen.add(k); out.push(d); }
      }
    } catch {}
  }
  return out;
}

const SHA = /^[0-9a-f]{7,64}$/i;
const git = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 << 20, ...opts });
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, f); } catch {} };

// Whether a session's checkout held a merged change: its recorded head contains the merge commit. Asked of git once a
// head for every merge commit of its repository together (the commits `rev-list ... --not <head>` does not list are
// the head's ancestors), and kept (`decision-ancestry.json` in `dir`: the cache's state for a report, the ledger's own
// for the footer), since neither commit can change. Where git cannot answer (a commit not fetched here, a checkout
// gone) nothing is kept and the session is not counted this time.
export function ancestry(dir, decisions = []) {
  const file = path.join(dir, 'decision-ancestry.json'), asked = new Map(), commits = new Map();
  for (const d of decisions) if (d.commit && SHA.test(d.commit)) { if (!commits.has(d.repo)) commits.set(d.repo, new Set()); commits.get(d.repo).add(d.commit); }
  let kept = null, dirty = false;
  const has = (d, head) => {
    kept ??= readJson(file);
    const k = `${d.commit}:${head}`;
    if (k in kept) return kept[k];
    if (asked.has(k)) return asked.get(k);
    if (!SHA.test(d.commit) || !SHA.test(head)) return null;
    const all = [...new Set([d.commit, ...(commits.get(d.repo) || [])])];
    try {
      const missing = new Set(git(d.repo, ['rev-list', ...all, '--not', head]).split('\n'));
      for (const c of all) kept[`${c}:${head}`] = !missing.has(c);
      dirty = true;
    } catch {
      // one commit git does not know fails the whole question: ask for this one alone
      let r = null;
      try { git(d.repo, ['merge-base', '--is-ancestor', d.commit, head]); r = true; } catch (err) { r = err?.status === 1 ? false : null; }
      if (r == null) asked.set(k, r); else { kept[k] = r; dirty = true; }
    }
    return k in kept ? kept[k] : null;
  };
  has.save = () => { if (dirty) { dirty = false; writeJson(file, kept); } };
  return has;
}

// A section is credited for what it is still smaller by than before the decision, not for what the edit took out on
// the day. The edit's own figure assumes the section then stood as the edit left it, and here it never did: one
// compressed from 22k tokens to 2k had a paragraph added by the next pull request thirteen minutes later, and two
// compressed in October were rewritten whole inside a fortnight. So the section is sized at every later commit on the
// default branch that touches its file, and each stretch counts `before - size`, never more than the edit took out
// and never less than nothing: a section that has grown back past its old size counts nothing, a compressed one
// that was since deleted counts nothing (the long one would have gone with it), and a removed one counts in full
// until something by its name is written again. Sized once a commit and kept (`decision-sections.json`), read on
// from the last tip looked at, and not at all once the decision's time is up.
const sizeOf = text => Math.ceil(String(text).length / 4); // instruction-edit.js's own count, which `tokens` was recorded in
export function sectionSteps(decisions, dir, { now = Date.now() } = {}) {
  const mine = decisions.filter(d => d.kind === 'section' && d.commit && SHA.test(d.commit));
  if (!mine.length) return decisions;
  const file = path.join(dir, 'decision-sections.json'), kept = readJson(file), tips = new Map(), sizes = new Map();
  let dirty = false;
  const tipOf = repo => {
    if (!tips.has(repo)) tips.set(repo, (() => { for (const ref of ['refs/remotes/origin/HEAD', 'HEAD']) { try { return git(repo, ['rev-parse', '--verify', '-q', ref]).trim(); } catch {} } return null; })());
    return tips.get(repo);
  };
  // the section's size at a commit: null where the file or the section is not there
  const sizeAt = (d, commit) => {
    const k = `${d.repo}\0${commit}\0${d.file}`;
    if (!sizes.has(k)) sizes.set(k, (() => { try { const f = { file: d.file, kind: 'root' }; return new Map(sections(git(d.repo, ['show', `${commit}:${d.file}`])).map(x => [sectionId(f, x).toLowerCase(), sizeOf(x.text)])); } catch { return new Map(); } })());
    return sizes.get(k).get(d.section) ?? null;
  };
  for (const d of mine) {
    const tip = tipOf(d.repo), was = kept[d.id];
    if (!tip || was?.done || was?.tip === tip) continue;
    try {
      let from = d.commit, steps = [];
      if (was?.tip) { try { git(d.repo, ['merge-base', '--is-ancestor', was.tip, tip]); from = was.tip; steps = was.steps || []; } catch {} }
      let last = steps.length ? steps[steps.length - 1][1] : sizeAt(d, d.commit);
      // --first-parent: the commits as they landed on the branch, each dated when it did (a merged branch's own
      // commits are older than the merge that brought them)
      for (const line of git(d.repo, ['log', '--first-parent', '--reverse', '--format=%H %ct', `${from}..${tip}`, '--', d.file]).split('\n').filter(Boolean)) {
        const [commit, ct] = line.split(' '), t = Number(ct) * 1000;
        if (t >= d.to) break;
        const size = sizeAt(d, commit);
        if (size !== last) { steps.push([t, size]); last = size; }
      }
      kept[d.id] = { tip, start: sizeAt(d, d.commit), steps, ...(now >= d.to ? { done: true } : {}) }; dirty = true;
    } catch {}
  }
  if (dirty) writeJson(file, kept);
  const credit = (d, size) => size == null ? (d.removed ? d.tokens : 0) : Math.max(0, Math.min(d.tokens, d.before - size));
  return decisions.flatMap(d => {
    const k = kept[d.id];
    if (!mine.includes(d)) return [d];
    if (!k) return []; // git could not size it: not counted
    const marks = [[d.from, k.start], ...k.steps.filter(([t]) => t < d.to).map(([t, size]) => [Math.max(d.from, t), size])];
    return marks.map(([t, size], i) => ({ ...d, since: d.from, from: t, to: marks[i + 1]?.[0] ?? d.to, tokens: credit(d, size) })).filter(x => x.tokens > 0 && x.to > x.from);
  });
}

// What decisionSavings is given: the decisions, a section's cut into the stretches it was each size, and the question a
// session's head is asked.
export function decisionInputs(decisions, dir, { now = Date.now() } = {}) {
  let settled = decisions.filter(d => d.kind !== 'section');
  try { settled = sectionSteps(decisions, dir, { now }); } catch {}
  return { decisions: settled, has: ancestry(dir, settled) };
}
