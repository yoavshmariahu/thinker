// Desired behaviors from the design documents checked into the repository: the READMEs that sit beside
// the code, and the design, architecture and decision documents. A person wrote those to say how the
// system must behave, so a rule one of them states is a behavior in force (behavior.js:proposed lets a
// `doc` source stand), saved `mutable`: a change that breaks it gets a warning until a person makes it
// blocking. This is where a repository's behaviors come from: a build and
// `thinker system docs` run it, and nothing interviews the person for more.
//
// The documents are tracked: a document that changed is read again (by maintenance, a build, or
// `thinker system docs`), and the behaviors it produced follow it. One whose quoted sentence is
// still there stands; one whose sentence was reworded takes the new sentence; one the document no
// longer states is marked (source.unstated) for the person to keep or discard, never removed on a
// model's word. A behavior a person edited keeps its link to the document (docSource), and one a
// person discarded does not come back when the document changes.
//
// One bounded model call per document. The model sees the document and the definitions near it, and
// a behavior is kept only when the sentence it quotes is in the document and every pointer names a
// definition that was shown and still resolves. A document is read once per content: its hash is on
// the behaviors it produced and in a local file, so a later run reads only new and changed documents.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.js';
import { TRANSIENT, repoFile } from './deps.js';
import { resolveDeps } from './ops.js';
import { slugify } from './store.js';
import { CODE_EXT, isTestPath, outline, findDefinitions, findSymbols, countable } from './codegraph.js';
import { addBehavior, isBehavior } from './behavior.js';

const fileOf = store => path.join(store.localDir, 'behavior-docs.json');
const readState = store => { try { return JSON.parse(fs.readFileSync(fileOf(store), 'utf8')).docs || {}; } catch { return {}; } };
function writeState(store, docs) {
  fs.mkdirSync(store.localDir, { recursive: true });
  fs.writeFileSync(fileOf(store), JSON.stringify({ docs }, null, 2) + '\n');
}
const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const extOf = p => String(p).split('.').pop().toLowerCase();
const isCode = p => CODE_EXT.has(extOf(p)) && !isTestPath(p) && !TRANSIENT.test(p);

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc)$/i;
const README = /^readme(\.(md|mdx|markdown|rst|adoc|txt))?$/i;
const DESIGN_NAME = /(^|[-_. ])(design|architecture|adr|rfc|spec|invariants?|decisions?)([-_. ]|$)/i;
const DESIGN_DIR = /(^|\/)(design|designs|adrs?|rfcs?|architecture|decisions|specs?)\//i;
const DOCS_DIR = /(^|\/)docs?\//i;
// not design: release history, legal and community files, and the instructions written for agents
const SKIP_NAME = /^(changelog|changes|history|news|licen[sc]e|contributing|code_of_conduct|security|authors|maintainers|notice|releas|onboarding|agents|claude|gemini|system)\b/i;
const SKIP_PATH = /(^|\/)(\.[^/]+|node_modules|vendor|third_party|fixtures?|testdata|examples?|samples?|bench|benchmarks?|research|experiments?|prototypes?|playground|scratch|i18n|locales?|translations?)\//i;
const MIN_CHARS = 400;

function tracked(repo, specs = []) {
  try { return execFileSync('git', ['ls-files', '-z', '--', ...specs], { cwd: repo, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); }
  catch { return []; }
}

// The design documents of a checkout, the ones most likely to state rules first: design and decision
// documents, the root README, the READMEs beside a real part of the code (the directories with most
// code first), the rest of docs/, then READMEs beside a file or two. `directories` (a project selection) keeps the documents under them,
// and the root README.
export function designDocs(repo, { directories = null } = {}) {
  const files = tracked(repo);
  const codeDirs = new Map(); // directory -> code files under it
  for (const f of files) if (isCode(f)) { let d = path.dirname(f); while (d && d !== '.') { codeDirs.set(d, (codeDirs.get(d) || 0) + 1); d = path.dirname(d); } }
  const inScope = f => !directories?.length || !f.includes('/') || directories.some(d => f === d || f.startsWith(String(d).replace(/\/+$/, '') + '/'));
  const out = [];
  for (const f of files) {
    const base = path.basename(f), dir = path.dirname(f), stem = base.replace(/\.[^.]+$/, '');
    const readme = README.test(base);
    if (!readme && !DOC_EXT.test(base)) continue;
    if (SKIP_NAME.test(base) || SKIP_PATH.test(f) || TRANSIENT.test(f) || isTestPath(f) || !inScope(f)) continue;
    const design = DESIGN_NAME.test(stem) || DESIGN_DIR.test(f);
    const code = codeDirs.get(dir) || 0;
    const tier = design ? 0 : readme && dir === '.' ? 1 : readme && code >= 3 ? 2 : DOCS_DIR.test(f) ? 3 : readme && code ? 4 : -1;
    if (tier < 0) continue;
    let size = 0; try { size = fs.statSync(path.join(repo, f)).size; } catch { continue; }
    if (size < MIN_CHARS) continue;
    out.push({ path: f, tier, readme, code, depth: f.split('/').length });
  }
  return out.sort((a, b) => a.tier - b.tier || (a.readme && b.readme ? b.code - a.code : 0) || a.depth - b.depth || a.path.localeCompare(b.path));
}

// The definitions a rule in this document could rest on: the ones the document names (paths and
// identifiers in backticks), the code in the document's own directory, and, where that leaves
// little (a document in docs/ names no code), the definitions carrying the words of its headings.
const MAX_DEFS = 160;
export function nearbyDefinitions(repo, doc, text) {
  const byFile = new Map();
  let n = 0;
  const add = (file, name) => {
    if (!name || n >= MAX_DEFS || !isCode(file)) return;
    if (!byFile.has(file)) byFile.set(file, new Set());
    const s = byFile.get(file); if (!s.has(name)) { s.add(name); n++; }
  };
  const addFile = (file, limit) => { for (const d of outline(repo, file, { limit }) || []) add(file, d.parent ? `${d.parent}.${d.name}` : d.name); };
  const ticks = [...new Set([...text.matchAll(/`([^`\n]{2,80})`/g)].map(m => m[1].trim()))];
  const dir = path.dirname(doc.path);
  for (const t of ticks) {
    const p = t.replace(/[:#].*$/, '');
    if (!/[/.]/.test(p) || !CODE_EXT.has(extOf(p))) continue;
    for (const cand of [p, path.join(dir, p)]) { const abs = repoFile(repo, cand); if (abs && fs.existsSync(abs)) { addFile(path.normalize(cand), 20); break; } }
  }
  // a backticked plain word (`usage`, `fixed`) is prose more often than a name: camelCase, snake_case or name()
  for (const t of ticks.filter(t => /^[A-Za-z_$][\w$]*(\(\))?$/.test(t) && /[a-z][A-Z]|_|\d|\(\)$|^[A-Z][a-z]+[A-Z]/.test(t)).map(t => t.replace(/\(\)$/, '')).filter(countable).slice(0, 25))
    for (const d of (findDefinitions(repo, t, { limit: 2 }) || [])) add(d.path, t);
  if (dir !== '.') {
    const files = tracked(repo, [dir]).filter(isCode).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 30);
    for (const f of files) addFile(f, 20);
  }
  if (n < 12) {
    const words = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1]).join(' ').slice(0, 300);
    for (const h of findSymbols(repo, words, { limit: 30 })?.hits || []) add(h.path, h.symbol || h.name);
  }
  return byFile;
}

// The document a behavior came from: its own source, or the one kept when a person edited it
// (behavior-workbench.js:editBehavior moves the source to source.from).
export function docSource(n) {
  const s = n?.source;
  return s?.type === 'doc' ? s : s?.type === 'human' && s.from?.type === 'doc' ? s.from : null;
}
function setDocSource(store, n, patch) {
  const src = { ...docSource(n), ...patch };
  for (const k of Object.keys(src)) if (src[k] === undefined) delete src[k];
  store.put({ ...n, source: n.source.type === 'doc' ? src : { ...n.source, from: src } });
}

// A person took this behavior out: its sentence is remembered beside the document, so a later
// reading of the changed document does not save it again.
export function rememberDiscarded(store, n) {
  const src = docSource(n); if (!src?.ref) return;
  const state = readState(store), e = state[src.ref] || {};
  state[src.ref] = { ...e, discarded: [...new Set([...(e.discarded || []), plain(src.quote), slugify(n.title)].filter(Boolean))] };
  writeState(store, state);
}

const SCHEMA = { type: 'object', properties: { kept: { type: 'array', items: {
  type: 'object', properties: { id: { type: 'string' }, quote: { type: 'string' } }, required: ['id', 'quote'],
} }, behaviors: { type: 'array', items: {
  type: 'object', properties: {
    title: { type: 'string' }, body: { type: 'string' }, quote: { type: 'string' },
    answers: { type: 'array', items: { type: 'string' } },
    deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path', 'symbol'] } },
  }, required: ['title', 'body', 'quote', 'answers', 'deps'],
} } }, required: ['behaviors'] };

const PER_DOC = 5, DOC_CHARS = 14000;
const SYSTEM = `You read one design document checked into a repository and write down the desired behaviors it states. A desired behavior is a rule every future change must keep: something the system must always or never do, in product terms (what users and other systems rely on, security and privacy rules, data that must not be lost or exposed, how failures are handled, limits and defaults that matter).

Take only what the document itself states as intended. Not installation or usage steps, examples, roadmap or history, descriptions of structure with no requirement in them, or anything you infer from the code alone: the code says what the system does, the document says what it must do.

For each behavior, at most ${PER_DOC} for the document, the most important first:
- title: the requirement as one sentence.
- body: two to five sentences stating the rule and where the code upholds it, with path:Symbol pointers.
- quote: one sentence or phrase copied exactly from the document that states the rule.
- deps: the definitions that enforce it, each one taken from DEFINITIONS exactly as listed (path and symbol). Leave a behavior out when no listed definition enforces it.
- answers: two or three ways someone would ask about it.

Do not repeat an existing behavior. Return an empty list when the document states no such rule.

REWORDED lists behaviors read from an earlier version of this document whose quoted sentence is no longer in it. For each one the document still states, add {id, quote} to kept, with the sentence or phrase of the document as it is now that states it, copied exactly. Leave out the ones the document no longer states.`;

// lowercase, markup and spacing aside: a quote is the document's words when this matches
const plain = s => String(s || '').toLowerCase().replace(/[`*_~>#|[\]()"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();

function check(store, raw, { text, allowed, taken, quotes, discarded }) {
  const title = String(raw.title || '').trim(), body = String(raw.body || '').trim(), quote = String(raw.quote || '').trim();
  if (!title || !body || !quote) return 'incomplete';
  if (plain(quote).length < 12 || !plain(text).includes(plain(quote))) return 'quote is not in the document';
  const deps = (raw.deps || []).filter(d => d?.path && d.symbol && allowed.has(`${d.path}|${d.symbol}`));
  if (!deps.length || deps.length !== (raw.deps || []).length) return 'points at code that was not shown';
  const r = resolveDeps(store.repo, deps);
  if (r.deps.length !== deps.length || r.dropped.length) return 'pointer does not resolve';
  if (taken.has(slugify(title)) || quotes?.has(plain(quote))) return 'already a behavior';
  if (discarded?.has(slugify(title)) || discarded?.has(plain(quote))) return 'discarded by a person';
  return { title, body, quote, deps, answers: (raw.answers || []).map(s => String(s).trim()).filter(Boolean) };
}

// Read the design documents not read yet (or changed since) and save the behaviors they state.
// limit: documents per run, the rest are left for the next one. again: read unchanged documents too.
// dry: list what would be read, without a model call.
export async function deriveDocBehaviors(store, { model, limit = 12, again = false, dry = false, directories = null, completeFn = complete, phase = 'init', conc = 4, onDoc } = {}) {
  const repo = store.repo, all = designDocs(repo, { directories }), state = readState(store);
  const behaviors = store.list().filter(isBehavior);
  const readHashes = new Set(behaviors.filter(docSource).map(n => `${docSource(n).ref}|${docSource(n).hash}`));
  const pending = [];
  for (const d of all) {
    let text; try { text = fs.readFileSync(path.join(repo, d.path), 'utf8'); } catch { continue; }
    const hash = hashOf(text);
    if (!again && (state[d.path]?.hash === hash || readHashes.has(`${d.path}|${hash}`))) continue;
    pending.push({ ...d, text, hash });
  }
  const batch = pending.slice(0, limit);
  const res = { found: all.length, docs: batch.map(d => d.path), read: 0, saved: [], rejected: [], reworded: [], unstated: [], tokens: 0, failed: 0, lastError: null, remaining: pending.length - batch.length };
  if (dry) return res;
  // a behavior whose document is gone, or is no longer read as a design document and lost the
  // sentence, is no longer stated anywhere: free, no model call. A document waiting to be read is
  // left to its reading, which can find the sentence reworded.
  const waiting = new Set(pending.map(d => d.path));
  const mark = n => { if (!docSource(n).unstated) { setDocSource(store, n, { unstated: new Date().toISOString() }); res.unstated.push({ id: n.id, title: n.title, doc: docSource(n).ref }); store.log({ op: 'behavior', id: n.id, action: 'doc-unstated', doc: docSource(n).ref }); } };
  const live = () => store.list().filter(n => isBehavior(n) && n.status !== 'invalid' && docSource(n));
  for (const n of live()) {
    const src = docSource(n); if (waiting.has(src.ref)) continue;
    let text = null; try { text = fs.readFileSync(path.join(repo, src.ref), 'utf8'); } catch {}
    if (text === null || !plain(text).includes(plain(src.quote))) mark(n);
    else if (src.unstated) setDocSource(store, n, { unstated: undefined }); // the sentence is back
  }
  if (!batch.length) return res;
  const taken = new Set(behaviors.filter(n => n.status !== 'invalid').map(n => slugify(n.title)));
  const titles = behaviors.filter(n => n.status !== 'invalid').map(n => n.title);
  const readOne = async d => {
    onDoc?.(d.path);
    const defs = nearbyDefinitions(repo, d, d.text);
    const ids = [];
    // what this document produced before: a sentence still there stands, the rest are asked about
    const mine = live().filter(n => docSource(n).ref === d.path), docText = plain(d.text);
    const stands = n => docText.includes(plain(docSource(n).quote));
    for (const n of mine.filter(stands)) setDocSource(store, n, { hash: d.hash, unstated: undefined });
    const moved = mine.filter(n => !stands(n));
    const quotes = new Set(mine.filter(stands).map(n => plain(docSource(n).quote)));
    const discarded = new Set(state[d.path]?.discarded || []);
    if (!defs.size) moved.forEach(mark); // nothing to ask with: the sentence is gone, say so
    if (defs.size) {
      const allowed = new Set([...defs].flatMap(([f, names]) => [...names].map(s => `${f}|${s}`)));
      const prompt = `EXISTING BEHAVIORS (do not repeat): ${titles.slice(-40).join('; ') || '(none)'}\n\nDEFINITIONS (path: symbols)\n${[...defs].map(([f, names]) => `${f}: ${[...names].join(', ')}`).join('\n')}\n\n${moved.length ? `REWORDED (id: title, the sentence it quoted)\n${moved.map(n => `${n.id}: ${n.title} — "${docSource(n).quote}"`).join('\n')}\n\n` : ''}DOCUMENT ${d.path}\n${d.text.slice(0, DOC_CHARS)}`;
      let drafted, kept;
      try {
        const out = await completeFn({ system: SYSTEM, prompt, model, schema: SCHEMA, maxTokens: 6000, thinkingTokens: 0, structuredRetries: 1, accounting: { store, purpose: 'behavior-docs', phase } });
        drafted = out.json?.behaviors || []; kept = out.json?.kept || [];
        res.tokens += out.tokens?.totalTokens || 0;
      } catch (e) { res.failed++; res.lastError = e; return; } // not marked read: the next run tries it again
      for (const n of moved) {
        const q = String(kept.find(k => k?.id === n.id)?.quote || '').trim();
        if (plain(q).length >= 12 && docText.includes(plain(q))) { setDocSource(store, n, { quote: q, hash: d.hash, unstated: undefined }); quotes.add(plain(q)); res.reworded.push({ id: n.id, title: n.title, doc: d.path }); }
        else mark(n);
      }
      for (const raw of drafted.slice(0, PER_DOC)) {
        const ok = check(store, raw, { text: d.text, allowed, taken, quotes, discarded });
        if (typeof ok === 'string') { res.rejected.push({ doc: d.path, title: String(raw.title || '').slice(0, 120), reason: ok }); continue; }
        const r = addBehavior(store, { title: ok.title, body: ok.body, answers: ok.answers, deps: ok.deps },
          { mutability: 'mutable', source: { type: 'doc', ref: d.path, quote: ok.quote, hash: d.hash } });
        if (r.error) { res.rejected.push({ doc: d.path, title: ok.title, reason: r.error }); continue; }
        taken.add(slugify(ok.title)); titles.push(ok.title); ids.push(r.note.id);
        res.saved.push({ id: r.note.id, title: r.note.title, doc: d.path });
        store.log({ op: 'behavior', id: r.note.id, action: 'from-doc', doc: d.path });
      }
    }
    res.read++;
    const now = readState(store); // read again: other documents are being read beside this one
    now[d.path] = { ...now[d.path], hash: d.hash, at: new Date().toISOString(), behaviors: [...new Set([...mine.map(n => n.id), ...ids])] };
    writeState(store, now);
  };
  // a few documents at a time: each is one model call, and an agent session is waiting on the result
  const queue = [...batch];
  await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, async () => { while (queue.length) await readOne(queue.shift()); }));
  if (res.failed && !res.read) throw res.lastError;
  return res;
}

// One line for the build and for `thinker system docs`.
export function docBehaviorsLine(r) {
  if (!r.found) return 'no design documents (READMEs beside the code, design or docs/ files) are checked in';
  if (!r.docs.length) return `${r.found} design document${r.found === 1 ? '' : 's'}, all read already` + (r.unstated?.length ? `; ${r.unstated.length} behavior${r.unstated.length === 1 ? '' : 's'} of a removed document no longer stated (keep or discard in thinker ui)` : '');
  const from = `${r.read} design document${r.read === 1 ? '' : 's'}`;
  return `${r.saved.length} behavior${r.saved.length === 1 ? '' : 's'} from ${from}` +
    (r.rejected.length ? `; ${r.rejected.length} left out (no rule quoted from the document, or no code upholding it)` : '') +
    (r.unstated?.length ? `; ${r.unstated.length} no longer stated by ${r.unstated.length === 1 ? 'its document' : 'their documents'} (keep or discard in thinker ui)` : '') +
    (r.failed ? `; ${r.failed} not read (${String(r.lastError?.message || '').slice(0, 100)})` : '') +
    (r.remaining ? `; ${r.remaining} more to read: thinker system docs` : '');
}
