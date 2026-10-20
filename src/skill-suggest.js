// Skills suggested by the file being worked on, from what past sessions here did with files like it.
//
// With a repository's skills switched off (harness.js), agents stop reading them: on PostHog under GPT-6
// Astra, 0.6 skills a session against 2.9 with the listing, and the conventions grader found more minor rule
// breaks (0.46 against 0.21 a session, 2026-10-19). `lookup` over the skill descriptions was right 42% of the
// time. An offline replay of 230 PostHog sessions (bench/worktrees/eval-support/skill-protocol/replay.py,
// leave-one-task-out) showed that the two skills past sessions opened most for that kind of file are right
// 83% of the time at the same recall. Suggesting what was opened most would feed itself (a skill suggested
// is opened because it was suggested), so the ranking here is driven by organic evidence and outcomes, with
// exploration (Thompson sampling) and the holdout:
//
//   evidence  .thinker/state/skill-evidence.json (local): rows keyed by (area, skill), an area being a key
//             of a file path (areaKeys). Per row: organic opens (no suggestion of that skill earlier in the
//             session), suggested, suggested-then-opened, unread (sessions that edited a file there without
//             the skill's text reaching the agent: not opened, whether suggested or not), missed (a rule of the skill broken in such a session, from the
//             sampled outcome check, skill-outcome.js), negative (broken although read); per area: exposures
//             (sessions that edited a file there). Every count decays with its age (halfLifeDays), on read.
//   record    once per session, from the transcript the harness parses (harness.js:sessionHarness,
//             harness-codex.js:codexSessionHarness), at the end-of-session distill (commands/learn.js:distillFile)
//   score     per (area, skill), only on the sessions where the skill was not read: a session that opened it
//             says nothing about whether it prevents a break (the read prevents the miss), and
//             counting those as failures suppressed a useful skill the more it was followed (check 1 of the
//             protocol review, 2026-10-19: equilibrium suggestion rate 0.4 for a skill preventing most
//             breaks). Beta(a0 + misses + organic·w, b0 + (unread − misses) + negatives), the best of the
//             file's areas, Thompson-sampled; top `max` samples above `floor`. Organic opens stay as weak
//             evidence that the skill is relevant there (w = `organic`), so a repository's habits seed the
//             ranking before any outcome is known. A suggestion the agent did not follow leaves the session
//             unread: the line is not the skill, and a skill suggested every time would otherwise only be
//             scored on held-out turns (the popular skill that prevents nothing stayed at 0.75 in check 1).
//             A skill whose description shares a word of the path
//             enters with a small prior only when the file's areas have no evidence-backed candidate at all.
//   deliver   the tool hook, the first time a file is opened or edited in a session, a line per skill, once
//             per skill a session; a held-out turn (ops.js:holdoutTurn) gets nothing and logs what it withheld.
//
// A new way of reaching the agent: off until an experiment shows it helps (AGENTS.md). `harness: { skillSuggest:
// true }` in .thinker/config.json, or THINKER_HARNESS_SKILL_SUGGEST=on, turns it on; =off wins over the config.
import fs from 'node:fs';
import path from 'node:path';
import { findSkills } from './skills.js';
import { sessionHarness } from './harness.js';
import { codexSessionHarness } from './harness-codex.js';
import { findSessions } from './transcripts.js';

// a0/b0: the prior of every (area, skill) row, mean 0.11 and worth 4.5 sessions, so one organic open in an
// area seen once (Beta(1.5, 4), mean 0.27) stays under the floor more often than not, while eight of ten
// (Beta(8.5, 6), mean 0.59) clears it nearly always. Chosen on the replay (replay_thompson.py, 230 PostHog
// sessions, leave-one-task-out, 10 seeds): b0 2 suggested 3.1 skills a session at precision 0.68, b0 4 2.7 at
// 0.78, b0 6 2.6 at 0.81 with less exploration; recall 0.66 throughout. lexical: the pseudo-successes a
// description sharing a word of the path adds; floor: the sample a suggestion must reach (the replay's 0.35 on
// its smoothed estimate); halfLifeDays: a month of work weighs half.
// lexical: cold start only, and small: in the replay of 8 PostHog eval tasks (check 2, 2026-10-19) none of
// the 24 suggestions it put forward was a skill the agent went on to open; it is there so a file in an area
// nobody has worked on yet can get a skill tried at all. organic: the weight of an organic open, as evidence
// of relevance (see score above): 1, the weight the simulation (check 1) and the replay (check 2) were run with.
// outcome*: the sampled outcome check (skill-outcome.js): the share of sessions checked, the skills of the
// evidence and those a matching rule file names, the diff and guidance sizes in characters.
export const SKILL_SUGGEST = {
  a0: 0.5, b0: 4, lexical: 0.25, lexicalMax: 3, organic: 1, floor: 0.35, max: 2, perSession: 6, halfLifeDays: 30,
  sessionsKept: 500, seedSessions: 40, seedDays: 60, seedMs: 3000,
  outcomeShare: 0.25, outcomeSkills: 3, outcomeRuleSkills: 2, outcomeDiffChars: 40_000, outcomeGuidanceChars: 80_000,
};
const DAY = 86_400_000;

export function skillSuggestOn(store, env = process.env) {
  const v = env.THINKER_HARNESS_SKILL_SUGGEST || '';
  if (/^(0|off|false)$/i.test(v)) return false;
  if (/^(1|on|true)$/i.test(v)) return true;
  try { return store.config().harness?.skillSuggest === true; } catch { return false; }
}
export function skillSuggestConfig(store) {
  let h = {}; try { h = store.config().harness || {}; } catch {}
  const days = Number(h.skillSuggestHalfLifeDays), share = Number(h.skillOutcomeShare);
  return { ...SKILL_SUGGEST, ...(days > 0 ? { halfLifeDays: days } : {}), ...('skillOutcomeShare' in h && share >= 0 && share <= 1 ? { outcomeShare: share } : {}) };
}

// --- areas ---------------------------------------------------------------------------------------------
// The keys of a file path, as in the replay: its first two directories, its top directory, a product's
// layer (products/<p>/<layer>), and the kind of file.
export function areaKeys(file) {
  const p = String(file || '').replace(/^\.\//, ''), name = p.split('/').pop(), parts = p.split('/');
  if (!p) return [];
  const ks = [`dir:${parts.slice(0, 2).join('/')}`, `dir1:${parts[0]}`];
  if (parts[0] === 'products' && parts.length > 3) ks.push(`layer:${parts.slice(0, 3).join('/')}`);
  if (p.endsWith('.py')) {
    ks.push(name.startsWith('test_') || /\/tests?\//.test(p) ? 'kind:py-test' : 'kind:py');
    if (p.includes('/migrations/')) ks.push('kind:migration');
    if (p.includes('/api/') || name.includes('serializer')) ks.push('kind:api');
  } else if (/\.(test|spec)\.tsx?$/.test(name)) ks.push('kind:ts-test');
  else if (/[lL]ogic\.ts$/.test(name)) ks.push('kind:kea-logic');
  else if (name.endsWith('.tsx')) ks.push('kind:tsx');
  else if (name.endsWith('.ts')) ks.push('kind:ts');
  else if (name.endsWith('.md')) ks.push('kind:md');
  return [...new Set(ks)];
}
// a file worth suggesting for: in the repository, not a skill file itself, not thinker's or an agent's own
export const suggestable = f => Boolean(f) && !f.startsWith('..') && !path.isAbsolute(f) && !/(^|\/)SKILL\.md$/.test(f) && !/^\.(thinker|git|claude|codex|cursor|agents)\//.test(f);

// --- decayed counts ------------------------------------------------------------------------------------
export const decayed = (c, now, halfLifeDays = SKILL_SUGGEST.halfLifeDays) => c && c.v ? c.v * Math.pow(0.5, Math.max(0, now - c.at) / (halfLifeDays * DAY)) : 0;
const bump = (c, n, now, hl) => ({ v: decayed(c, now, hl) + n, at: now });

// --- the evidence store --------------------------------------------------------------------------------
export const emptyEvidence = () => ({ version: 1, areas: {}, sessions: {}, skills: {} });
const evidenceFile = store => path.join(store.dir, 'state', 'skill-evidence.json');
export function loadEvidence(store) {
  try { const j = JSON.parse(fs.readFileSync(evidenceFile(store), 'utf8')); return { ...emptyEvidence(), ...j }; } catch { return null; }
}
export function saveEvidence(store, ev) {
  const f = evidenceFile(store), tmp = `${f}.${process.pid}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(ev));
  fs.renameSync(tmp, f);
}
const area = (ev, k) => (ev.areas[k] ||= { exposures: null, skills: {} });
// A row made for a skill that was there before it (not `added` to the registry since the evidence began)
// starts with every earlier session in the area as unread: none of them opened it, or the row would exist.
// Without this a skill opened once in a busy area scored as if that were its only session there (the replay's
// precision fell from 0.37 to 0.23). exposed: this session is already counted in the area's exposures.
const row = (ev, k, skill, { now = Date.now(), hl = SKILL_SUGGEST.halfLifeDays, exposed = false } = {}) => {
  const a = area(ev, k);
  if (!a.skills[skill]) {
    const prior = ev.skills?.[skill]?.added ? 0 : Math.max(0, decayed(a.exposures, now, hl) - (exposed ? 1 : 0));
    a.skills[skill] = prior > 0 ? { unread: { v: prior, at: now } } : {};
  }
  return a.skills[skill];
};

// One session's opens and edits credited, idempotently: what was credited for the session before is kept
// with it, so recording it again (a session that went on after a catch-up run) credits only what is new.
// opened: [{ skill, at }] in order; suggestions: [{ skill, areas, at, withheld }]. An open is organic unless
// a suggestion of that skill was shown earlier in the session (one without times counts as earlier). Every
// skill the area already has a row for and the session did not open (suggested or not) counts the session as
// unread there; a later recording that finds it opened takes that back.
export function creditSession(ev, { session, edited = [], opened = [], suggestions = [], now = Date.now(), halfLifeDays = SKILL_SUGGEST.halfLifeDays, kept = SKILL_SUGGEST.sessionsKept } = {}) {
  const areas = [...new Set(edited.filter(suggestable).flatMap(areaKeys))];
  const shown = suggestions.filter(s => !s.withheld);
  const before = (o, s) => o.at == null || s.at == null || Date.parse(s.at) <= Date.parse(o.at);
  const firstOpen = new Map(); for (const o of opened) if (o?.skill && !firstOpen.has(o.skill)) firstOpen.set(o.skill, o);
  const organic = [...firstOpen.values()].filter(o => !shown.some(s => s.skill === o.skill && before(o, s))).map(o => o.skill);
  const followed = [...firstOpen.values()].filter(o => shown.some(s => s.skill === o.skill && before(o, s))).map(o => o.skill);
  const prev = ev.sessions[session] || { areas: [], pairs: [], suggested: [], followed: [] };
  const have = k => new Set(prev[k] || []);
  const seenAreas = have('areas'), pairs = have('pairs'), sugg = have('suggested'), foll = have('followed'), unr = have('unread');
  for (const a of areas) if (!seenAreas.has(a)) { area(ev, a).exposures = bump(area(ev, a).exposures, 1, now, halfLifeDays); seenAreas.add(a); }
  for (const a of areas) for (const s of organic) { const k = `${a}\t${s}`; if (pairs.has(k)) continue; const r = row(ev, a, s, { now, hl: halfLifeDays, exposed: true }); r.organic = bump(r.organic, 1, now, halfLifeDays); pairs.add(k); }
  for (const s of shown) for (const a of s.areas || []) { const k = `${a}\t${s.skill}`; if (sugg.has(k)) continue; const r = row(ev, a, s.skill, { now, hl: halfLifeDays, exposed: seenAreas.has(a) }); r.suggested = bump(r.suggested, 1, now, halfLifeDays); sugg.add(k); }
  for (const skill of followed) for (const s of shown.filter(x => x.skill === skill)) for (const a of s.areas || []) { const k = `${a}\t${skill}`; if (foll.has(k)) continue; const r = row(ev, a, skill, { now, hl: halfLifeDays, exposed: seenAreas.has(a) }); r.followed = bump(r.followed, 1, now, halfLifeDays); foll.add(k); }
  const touched = new Set(firstOpen.keys());
  for (const a of areas) for (const [skill, r] of Object.entries(area(ev, a).skills)) {
    const k = `${a}\t${skill}`;
    if (!touched.has(skill) && !unr.has(k)) { r.unread = bump(r.unread, 1, now, halfLifeDays); unr.add(k); }
    else if (touched.has(skill) && unr.has(k)) { r.unread = { v: Math.max(0, decayed(r.unread, now, halfLifeDays) - 1), at: now }; unr.delete(k); }
  }
  if (session) {
    ev.sessions[session] = { ...prev, at: new Date(now).toISOString(), areas: [...seenAreas], pairs: [...pairs], suggested: [...sugg], followed: [...foll], unread: [...unr] };
    const ids = Object.keys(ev.sessions); for (const id of ids.slice(0, Math.max(0, ids.length - kept))) delete ev.sessions[id];
  }
  return { areas, organic, followed };
}

// Rules of a skill a session broke, from the outcome check (skill-outcome.js): [{ skill, file, read }]. Not read
// (suggested or not): a miss on the areas of the file (all the session's areas when the file is not named), the
// session counted unread there too if it was not already (a row the check created). Read and broken all the
// same: a negative.
export function creditOutcome(ev, broken, { areas = [], session, now = Date.now(), halfLifeDays = SKILL_SUGGEST.halfLifeDays } = {}) {
  const out = [], rec = session ? ev.sessions[session] : null, unr = new Set(rec?.unread || []);
  for (const b of broken || []) {
    if (!b?.skill) continue;
    const ks = b.file && suggestable(b.file) ? areaKeys(b.file) : areas;
    const verdict = b.read ? 'broken-after-read' : 'missed';
    for (const a of ks) {
      const r = row(ev, a, b.skill, { now, hl: halfLifeDays, exposed: Boolean(rec?.areas?.includes(a)) });
      if (verdict === 'broken-after-read') { r.negative = bump(r.negative, 1, now, halfLifeDays); continue; }
      r.missed = bump(r.missed, 1, now, halfLifeDays);
      const k = `${a}\t${b.skill}`;
      if (!unr.has(k)) { r.unread = bump(r.unread, 1, now, halfLifeDays); unr.add(k); }
    }
    out.push({ skill: b.skill, file: b.file, verdict, areas: ks.length, ...(b.shown ? { shown: true } : {}) });
  }
  if (rec) rec.unread = [...unr];
  return out;
}

// --- scoring -------------------------------------------------------------------------------------------
// A seeded generator for tests and the replay (mulberry32); Math.random otherwise.
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(rng) { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
// Marsaglia and Tsang; a shape under 1 through gamma(shape + 1) · U^(1/shape)
export function sampleGamma(shape, rng) {
  if (shape < 1) { let u = 0; while (!u) u = rng(); return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape); }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v; do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function sampleBeta(a, b, rng) { const x = sampleGamma(a, rng), y = sampleGamma(b, rng); return x + y > 0 ? x / (x + y) : 0; }

// words of a path that say what kind of change it is, against a skill's name and description
const GENERIC = new Set('src lib app apps frontend backend products product common utils util index test tests spec components component scenes scene types type models model views view api main core init file files mod package packages internal shared public private config posthog'.split(' '));
const KIND_WORDS = { 'kind:kea-logic': ['kea', 'logic'], 'kind:migration': ['migration', 'migrations'], 'kind:py-test': ['pytest', 'test'], 'kind:ts-test': ['jest', 'test'], 'kind:api': ['api', 'serializer', 'endpoint'], 'kind:tsx': ['react', 'component'] };
export function pathWords(file) {
  const raw = String(file).replace(/\.\w+$/, '').split(/[\/._-]+/).flatMap(w => w.split(/(?<=[a-z])(?=[A-Z])/)).map(w => w.toLowerCase());
  const words = raw.filter(w => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));
  for (const k of areaKeys(file)) words.push(...(KIND_WORDS[k] || []));
  return [...new Set(words)];
}
const skillWords = s => new Set(String(`${s.name || ''} ${s.description || ''}`).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3));
export function lexicalMatches(skills, file, { max = SKILL_SUGGEST.lexicalMax } = {}) {
  const words = pathWords(file);
  if (!words.length) return [];
  return Object.entries(skills || {}).map(([name, s]) => { const sw = skillWords({ name, ...s }); return { name, hits: words.filter(w => sw.has(w)).length }; })
    .filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)).slice(0, max).map(x => x.name);
}

// The candidates for a file, each with its posterior per area: Beta(a0 + missed + organic·w,
// b0 + (unread − missed) + negative), a row entering only with a miss or an organic open. With no such row in
// any of the file's areas (cold start), the skills whose description shares a word of the path, at a small prior.
export function candidates(ev, file, { now = Date.now(), cfg = SKILL_SUGGEST, exclude = new Set() } = {}) {
  const keys = areaKeys(file), out = new Map(), hl = cfg.halfLifeDays, w = cfg.organic ?? SKILL_SUGGEST.organic;
  const known = name => !Object.keys(ev.skills || {}).length || ev.skills[name];
  let backed = false;
  for (const k of keys) {
    const a = ev.areas[k]; if (!a) continue;
    for (const [skill, r] of Object.entries(a.skills)) {
      if (!known(skill)) continue;
      const m = decayed(r.missed, now, hl), org = decayed(r.organic, now, hl) * w;
      if (m + org <= 0) continue;
      backed = true;
      if (exclude.has(skill)) continue;
      const alpha = cfg.a0 + m + org, beta = cfg.b0 + Math.max(0, decayed(r.unread, now, hl) - m) + decayed(r.negative, now, hl);
      if (!out.has(skill)) out.set(skill, []);
      out.get(skill).push({ area: k, alpha, beta });
    }
  }
  if (!backed) for (const skill of lexicalMatches(ev.skills, file, { max: cfg.lexicalMax })) if (!exclude.has(skill)) out.set(skill, [{ area: null, alpha: cfg.a0 + cfg.lexical, beta: cfg.b0 }]);
  return out;
}

// The skills to suggest for a file: each candidate's best sample over its areas, the top `max` above the
// floor, less those already said in the session (they keep their place: a skill said for the last file does not
// make room for the next best, or every file would bring two more). `greedy` is the same by posterior mean, for
// the replay to count how often sampling explored.
export function suggestFrom(ev, file, { rng = Math.random, now = Date.now(), cfg = SKILL_SUGGEST, exclude = new Set(), max = cfg.max } = {}) {
  const scored = [];
  for (const [skill, posts] of candidates(ev, file, { now, cfg })) {
    let best = -1, mean = 0, areas = [];
    for (const p of posts) {
      const x = sampleBeta(p.alpha, p.beta, rng);
      if (x > best) best = x;
      mean = Math.max(mean, p.alpha / (p.alpha + p.beta));
      if (p.area) areas.push(p.area);
    }
    scored.push({ skill, score: best, mean, areas: areas.length ? areas : areaKeys(file) });
  }
  const picks = scored.filter(s => s.score >= cfg.floor).sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill)).slice(0, max).filter(s => !exclude.has(s.skill));
  const greedy = scored.filter(s => s.mean >= cfg.floor).sort((a, b) => b.mean - a.mean || a.skill.localeCompare(b.skill)).slice(0, max).map(s => s.skill).filter(s => !exclude.has(s));
  return Object.assign(picks, { greedy });
}

// --- the skills of the checkout ------------------------------------------------------------------------
// name → { file, description }: by the directory name, which is what an agent reads (skills/<dir>/SKILL.md)
// and, for Claude Code, what the Skill tool is called with when the front matter names it so.
export function skillRegistry(repo) {
  const out = {};
  for (const s of findSkills(repo)) {
    if (out[s.dir]) continue;
    out[s.dir] = { file: s.file, description: String(s.description || '').replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0].slice(0, 200), ...(s.name && s.name !== s.dir ? { alias: s.name } : {}) };
  }
  return out;
}
// The registry brought up to date with the checkout: a skill that appears after the evidence began is marked
// `added`, so its rows do not count the sessions from before it existed as unread (row above).
export function refreshRegistry(ev, repo, { now = Date.now() } = {}) {
  const fresh = skillRegistry(repo), had = Object.keys(ev.skills || {}).length > 0, out = {};
  for (const [n, s] of Object.entries(fresh)) {
    const added = ev.skills?.[n]?.added || (had && !ev.skills?.[n] ? new Date(now).toISOString() : null);
    out[n] = { ...s, ...(added ? { added } : {}) };
  }
  ev.skills = out;
  return ev;
}
const canonical = (skills, name) => {
  if (!name) return null;
  const n = String(name).replace(/^\//, '');
  if (!Object.keys(skills || {}).length || skills[n]) return n;
  const hit = Object.entries(skills).find(([, s]) => s.alias === n);
  return hit ? hit[0] : n;
};

// --- transcripts ---------------------------------------------------------------------------------------
// What a session edited and which skills it opened, in order, from the transcript the harness parses.
export function sessionSkillEvidence(file) {
  let codex = /\/\.codex\//.test(file) || /rollout-/.test(path.basename(file));
  if (!codex) { try { const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(4096); fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd); codex = /"type":"session_meta"/.test(buf.toString('utf8')); } catch {} }
  const h = codex ? codexSessionHarness(file) : sessionHarness(file);
  const rel = f => { const s = String(f); return h.cwd && path.isAbsolute(s) ? path.relative(h.cwd, s) : s.replace(/^\.\//, ''); };
  return { client: codex ? 'codex' : 'claude', id: h.id || path.basename(file).replace(/\.jsonl?$/, ''), cwd: h.cwd, start: h.start, edited: [...new Set((h.edited || []).map(rel))], opened: h.skillOpens || [], parent: h.parent };
}

// --- the store wrappers --------------------------------------------------------------------------------
const stateFile = store => path.join(store.dir, 'state', 'skill-suggest.json');
const readState = store => { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return { sessions: {} }; } };
const writeState = (store, st) => { const ids = Object.keys(st.sessions || {}); for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete st.sessions[id]; fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(st)); };
// what was suggested (or withheld) in a session, as the hook logged it
export const sessionSuggestions = (store, session) => readState(store).sessions?.[session]?.log || [];

// From a parsed session (sessionSkillEvidence): credited once, idempotently (creditSession).
export function recordSkillEvidence(store, h, { session, suggestions, now = Date.now(), ev: given } = {}) {
  const cfg = skillSuggestConfig(store), ev = given || loadEvidence(store) || emptyEvidence();
  if (!given) refreshRegistry(ev, store.repo, { now });
  else if (!Object.keys(ev.skills).length) ev.skills = skillRegistry(store.repo);
  const id = session || h.id;
  const opened = (h.opened || []).map(o => ({ ...o, skill: canonical(ev.skills, o.skill) })).filter(o => o.skill && (!Object.keys(ev.skills).length || ev.skills[o.skill]));
  const r = creditSession(ev, { session: id, edited: h.edited || [], opened, suggestions: suggestions ?? sessionSuggestions(store, id), now, halfLifeDays: cfg.halfLifeDays });
  if (!given) saveEvidence(store, ev);
  return r;
}

// Past sessions read as organic evidence (nothing was suggested in them). For the eval: seed from a chosen
// list of transcripts (the training tasks') only.
export function seedSkillEvidence(store, files, { now = Date.now(), deadline = Infinity } = {}) {
  const ev = loadEvidence(store) || emptyEvidence();
  ev.skills = skillRegistry(store.repo);
  let n = 0;
  for (const f of files) {
    if (Date.now() > deadline) break;
    let h; try { h = sessionSkillEvidence(f); } catch { continue; }
    if (h.parent || !h.edited.length) continue;
    recordSkillEvidence(store, h, { session: h.id, suggestions: [], now, ev });
    n++;
  }
  ev.seeded ||= new Date(now).toISOString();
  saveEvidence(store, ev);
  store.log({ op: 'skill-evidence-seed', sessions: n, files: files.length });
  return { sessions: n, files: files.length };
}
// On first use: the machine's recent Claude Code and Codex sessions of this repository, within a time budget.
export function ensureSeeded(store, { cfg = skillSuggestConfig(store), sessions } = {}) {
  const ev = loadEvidence(store);
  if (ev?.seeded) return ev;
  const found = sessions ?? findSessions(store.repo, { sinceMs: cfg.seedDays * DAY }).filter(s => s.client === 'claude' || s.client === 'codex').sort((a, b) => b.mtime - a.mtime).slice(0, cfg.seedSessions).map(s => s.file);
  seedSkillEvidence(store, found, { deadline: Date.now() + cfg.seedMs });
  return loadEvidence(store);
}

// The end-of-session path (commands/learn.js:distillFile): the session's opens and edits, credited once.
export function recordSessionSkills(store, file, { session } = {}) {
  if (!skillSuggestOn(store)) return null;
  const h = sessionSkillEvidence(file);
  if (h.parent) return null;
  const r = recordSkillEvidence(store, h, { session: session || h.id });
  if (r.areas.length) store.log({ op: 'skill-evidence', session: session || h.id, areas: r.areas.length, organic: r.organic, followed: r.followed });
  return r;
}

// --- delivery ------------------------------------------------------------------------------------------
// The tool hook: files the tool call opened or edited, each the first time in the session, a line per
// skill to suggest, once per skill a session. A held-out turn logs what it withheld and says nothing.
export function skillSuggestLines(store, { session, client, files = [], holdout = false, turn, rng = Math.random, now = Date.now(), opened = [] } = {}) {
  if (!skillSuggestOn(store) || !['claude', 'codex'].includes(client) || !session || session === 'unknown') return '';
  const cfg = skillSuggestConfig(store);
  const st = readState(store), ss = (st.sessions[session] ||= { seen: [], said: [], log: [] });
  const ev = ensureSeeded(store, { cfg }) || emptyEvidence();
  if (!Object.keys(ev.skills).length) { ev.skills = skillRegistry(store.repo); saveEvidence(store, ev); }
  // a skill the agent opened itself is not suggested to it afterwards
  for (const o of opened) { const c = canonical(ev.skills, o); if (c && !ss.said.includes(c)) ss.said.push(c); }
  const lines = [];
  // the cap counts what was said and what a held-out turn withheld alike, so both sides have the same cap
  const full = () => ss.log.length >= cfg.perSession;
  for (const f of [...new Set(files)].filter(suggestable)) {
    if (ss.seen.includes(f)) continue;
    ss.seen.push(f);
    if (full()) continue;
    const picks = suggestFrom(ev, f, { rng, now, cfg, exclude: new Set(ss.said) });
    for (const p of picks) {
      if (full()) break;
      const at = new Date(now).toISOString(), entry = { skill: p.skill, areas: p.areas, file: f, at, ...(holdout ? { withheld: true } : {}) };
      ss.said.push(p.skill); ss.log.push(entry);
      store.log({ op: 'skill-suggest', session, client, skill: p.skill, area: p.areas[0], areas: p.areas, file: f, score: Math.round(p.score * 100) / 100, turn: turn || undefined, ...(holdout ? { withheld: true } : {}) });
      if (holdout) continue;
      const s = ev.skills[p.skill];
      const run = client === 'claude' && /^\.claude\/skills\//.test(s.file) ? ` (or run /${s.alias || p.skill})` : '';
      lines.push(`<thinker-skill>Past sessions here used ${p.skill} for files like this one: read ${s.file}${run}</thinker-skill>`);
    }
  }
  ss.seen = ss.seen.slice(-500);
  writeState(store, st);
  return lines.join('\n');
}

const SKILL_PATH = /skills\/([\w.-]+)\/SKILL\.md/g;
// The files a tool call opened or edited, and the skills it opened, from a hook's input: the clients' file
// fields (clients.js:toolFiles, passed in), plus the files of a Codex patch.
export function hookSkillFacts(ev, repo, files = []) {
  const ti = ev.tool_input || {}, text = typeof ti === 'string' ? ti : JSON.stringify(ti);
  const out = [...files];
  for (const m of String(typeof ti === 'string' ? ti : ti.input || ti.patch || ti.command || '').matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) {
    const f = m[1].trim(); out.push(path.isAbsolute(f) ? path.relative(repo, f) : f);
  }
  const opened = [...text.matchAll(SKILL_PATH)].map(m => m[1]);
  if (/^Skill$/.test(ev.tool_name || '') && ti.skill) opened.push(String(ti.skill));
  return { files: [...new Set(out)], opened };
}
