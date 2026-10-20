// A change to the team's instruction file, made by the person from the Context tab or `thinker instructions`:
// a section removed, or compressed (a model rewrites it shorter, keeping every rule, command and path). Nothing is
// written until the person has seen the diff: `previewEdit` keeps the proposed file in .thinker/state, and
// `applyEdit` writes exactly that text to the working tree, uncommitted, when the file has not changed since. The
// person reviews it with `git diff` and commits it, or `git checkout` drops it. No commit, no pull request.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sections } from './instructions-core.js';
import { instructionFile } from './instruction-value.js';
import { complete, DEFAULT_DISTILL_MODEL } from './llm.js';
import { tokensOf } from './model-usage.js';

const sha = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const idOf = s => slug(s.parent ? `${s.parent} ${s.title}` : s.title);

// Where a section's lines are in the file: from its heading to the next heading of any level. A "##" section with
// "###" sections under it owns only its heading and the prose before them.
export function locate(text, id) {
  const lines = String(text).split('\n'), all = sections(text);
  const s = all.find(x => idOf(x) === id);
  if (!s) return null;
  let parent = null, at = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3}) (.+?)\s*$/);
    if (!m) continue;
    if (m[1].length === 2) parent = m[2];
    if (m[2] === s.title && (m[1].length === 2 ? !s.parent : parent === s.parent)) { at = i; break; }
  }
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
  const hasChildren = s.level === 2 && all.some(c => c.parent === s.title);
  return { section: s, start: at, end, hasChildren, lines };
}

// Asked for a third of the length: told only to keep everything, a model gave back two thirds of it (5.9k of 5.9k
// tokens became 4k on this repository's "Serving"), mostly history and measurements it judged worth keeping.
export const COMPRESS_SYSTEM = `You shorten one section of a repository's instruction file for coding agents. The result must be at most a third of the original length.

KEEP, exactly: every instruction the agent must follow (rules, requirements, MUST / MANDATORY / never statements), every command and flag, every config key and default, every path and file:symbol pointer.
DROP: history (what was tried, when, what changed and why), measurements and benchmark numbers, rationale, examples, explanations of how things work internally unless the agent needs them to act, and repetition.
Write terse markdown: short bullets, no preamble. Keep the heading line exactly as given. Answer with the new section only.`;

// The proposed text of the section, without writing anything.
export async function proposeSection(store, text, id, action, { completeFn = complete, model } = {}) {
  const loc = locate(text, id);
  if (!loc) return { error: `no section "${id}" in the file` };
  const old = loc.lines.slice(loc.start, loc.end).join('\n').replace(/\n+$/, '');
  if (action === 'remove') return { loc, old, next: loc.hasChildren ? loc.lines[loc.start] : '' };
  if (action !== 'compress') return { error: `unknown action ${action}` };
  const res = await completeFn({ system: COMPRESS_SYSTEM, prompt: old, model: model || store.config().distillModel || DEFAULT_DISTILL_MODEL, maxTokens: 4000, thinkingTokens: 0, accounting: { store, phase: 'manual', purpose: 'instruction-compress' } });
  let next = String(res.text || '').trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1').trim();
  if (!next) return { error: 'the model returned nothing' };
  const heading = loc.lines[loc.start];
  if (next.split('\n')[0].trim() !== heading.trim()) next = `${heading}\n\n${next.replace(/^#{1,4} .*\n+/, '')}`;
  return { loc, old, next, tokens: tokensOf(res) };
}

// A line diff of two short texts (a section): '-' removed, '+' added, ' ' kept.
export function lineDiff(a, b) {
  const x = String(a).split('\n'), y = b ? String(b).split('\n') : [];
  const n = x.length, m = y.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
  while (i < n) out.push(['-', x[i++]]); while (j < m) out.push(['+', y[j++]]);
  return out;
}

const stateFile = store => path.join(store.dir, 'state', 'instruction-edits.json');
const readEdits = store => { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return {}; } };
const writeEdits = (store, e) => { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(e)); };

// The diff of a change to one or several sections (the model's calls side by side for compress), kept for
// `applyEdit` under `key` (the id of a single section, else "bulk"). Writes nothing to the file.
export async function previewEdit(store, ids, action, opts = {}) {
  ids = [...new Set((Array.isArray(ids) ? ids : String(ids).split(',')).map(s => String(s).trim()).filter(Boolean))];
  if (!ids.length) return { error: 'no section chosen' };
  const src = instructionFile(store.repo);
  if (!src) return { error: 'no AGENTS.md or CLAUDE.md here' };
  const props = await Promise.all(ids.map(id => proposeSection(store, src.text, id, action, opts)));
  const bad = props.find(p => p.error); if (bad) return bad;
  // every location is in the original text and sections do not overlap: replaced from the last one up
  const lines = src.text.split('\n');
  for (const p of [...props].sort((a, b) => b.loc.start - a.loc.start)) lines.splice(p.loc.start, p.loc.end - p.loc.start, ...(p.next ? [...p.next.split('\n'), ''] : []));
  const newText = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const key = ids.length === 1 ? ids[0] : 'bulk';
  const edits = readEdits(store);
  edits[key] = { file: src.file, from: sha(src.text), text: newText, action, ids, at: new Date().toISOString() };
  writeEdits(store, edits);
  const tok = s => Math.ceil(String(s).length / 4);
  const sections = props.map((p, i) => ({ id: ids[i], title: p.loc.section.title, diff: lineDiff(p.old, p.next), tokensBefore: tok(p.old), tokensAfter: tok(p.next) }));
  return { key, action, file: src.file, sections, title: sections[0].title, diff: sections.length === 1 ? sections[0].diff : null,
    tokensBefore: sections.reduce((a, x) => a + x.tokensBefore, 0), tokensAfter: sections.reduce((a, x) => a + x.tokensAfter, 0),
    modelTokens: props.reduce((a, p) => a + (p.tokens || 0), 0) || null };
}

// Write the previewed change to the working tree, when the file is still what the preview was made from.
export function applyEdit(store, id) {
  const edits = readEdits(store), e = edits[id];
  if (!e) return { error: 'preview the change first' };
  const file = path.join(store.repo, e.file);
  let now; try { now = fs.readFileSync(file, 'utf8'); } catch { return { error: `${e.file} is gone` }; }
  if (sha(now) !== e.from) { delete edits[id]; writeEdits(store, edits); return { error: `${e.file} changed since the preview; preview again` }; }
  fs.writeFileSync(file, e.text);
  delete edits[id]; writeEdits(store, edits);
  store.log({ op: 'instruction-edit', file: e.file, sections: e.ids || [id], action: e.action });
  const what = (e.ids || [id]).length === 1 ? 'it' : `${e.ids.length} sections`;
  return { said: `${e.action === 'remove' ? 'Removed' : 'Compressed'} ${what} in ${e.file} (uncommitted: git diff ${e.file} to review, git checkout ${e.file} to undo)` };
}
