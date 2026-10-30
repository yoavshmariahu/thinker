// Skill suggestions by file (src/skill-suggest.js): evidence, decay, Thompson sampling, holdout, delivery,
// the scoring on unread sessions, the sampled outcome check (skill-outcome.js), and nothing at all with the switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { resetFallback } from '../src/llm.js';
import { distillEvents } from '../src/distill.js';
import { markBuild, nextRequest, answerRequest } from '../src/session-llm.js';
import { distillFile } from '../src/commands/learn.js';
import {
  areaKeys, creditSession, creditOutcome, decayed, emptyEvidence, seededRng, sampleBeta, suggestFrom, candidates,
  skillSuggestOn, skillSuggestLines, loadEvidence, saveEvidence, recordSkillEvidence, sessionSkillEvidence, seedSkillEvidence,
  sessionSuggestions, hookSkillFacts, refreshRegistry, SKILL_SUGGEST,
} from '../src/skill-suggest.js';
import {
  skillOutcomeOn, outcomeSampled, sessionDiff, outcomeGuidance, matchingRules, ruleGlobs, globRegex, skillsNamedIn,
  agentsSections, violationSkill, judgeSkillOutcome, skillOutcomeCheck, OUTCOME_SCHEMA,
} from '../src/skill-outcome.js';
// Ranking is not what these tests check, so the cross-encoder (dense.js) stays out of the hook spawns:
// it has its own test, and loading an ONNX session in each spawn is most of what they cost.
process.env.THINKER_CE = 'off';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const DAY = 86_400_000;
const git = (repo, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
function repoWithSkills(t, { config = { harness: { skillSuggest: true } } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-skill-suggest-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  const skill = (root, name, desc) => { fs.mkdirSync(path.join(dir, root, name), { recursive: true }); fs.writeFileSync(path.join(dir, root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}.\n`); };
  skill('.agents/skills', 'writing-kea-logics', 'How to write kea logic files. Use for any kea logic.');
  skill('.agents/skills', 'django-migrations', 'Writing safe django migrations.');
  skill('.claude/skills', 'writing-tests', 'How tests are written here.');
  fs.mkdirSync(path.join(dir, 'frontend/src/scenes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend/src/scenes/dashLogic.ts'), 'export const x = 1\n');
  fs.writeFileSync(path.join(dir, 'frontend/src/scenes/otherLogic.ts'), 'export const y = 1\n');
  fs.mkdirSync(path.join(dir, 'posthog/migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'posthog/migrations/0001_init.py'), 'x = 1\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), ...config }));
  return { dir, store };
}
function withEnv(t, vars) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  t.after(() => { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}
const logLines = store => { try { return fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
// evidence that kea logic files were worked on with writing-kea-logics in 8 of 10 sessions
function keaEvidence(now = Date.now()) {
  const ev = emptyEvidence();
  ev.skills = { 'writing-kea-logics': { file: '.agents/skills/writing-kea-logics/SKILL.md', description: 'How to write kea logic files.' }, 'django-migrations': { file: '.agents/skills/django-migrations/SKILL.md', description: 'Writing safe django migrations.' }, 'writing-tests': { file: '.claude/skills/writing-tests/SKILL.md', description: 'How tests are written here.' } };
  for (let i = 0; i < 10; i++) creditSession(ev, { session: `s${i}`, edited: ['frontend/src/scenes/aLogic.ts'], opened: i < 8 ? [{ skill: 'writing-kea-logics' }] : [], now });
  return ev;
}

test('area keys follow the replay: two directories, the top one, a product layer, the kind of file', () => {
  assert.deepEqual(areaKeys('frontend/src/scenes/dashLogic.ts'), ['dir:frontend/src', 'dir1:frontend', 'kind:kea-logic']);
  assert.deepEqual(areaKeys('products/llm/backend/api/views.py'), ['dir:products/llm', 'dir1:products', 'layer:products/llm/backend', 'kind:py', 'kind:api']);
  assert.ok(areaKeys('posthog/migrations/0001_init.py').includes('kind:migration'));
  assert.ok(areaKeys('posthog/test/test_x.py').includes('kind:py-test'));
  assert.ok(areaKeys('a/b.test.tsx').includes('kind:ts-test'));
});

test('an open after a suggestion of the same skill is not organic; recording a session again credits only what is new', () => {
  const ev = emptyEvidence(), now = Date.parse('2026-10-19T10:00:00Z');
  const r = creditSession(ev, { session: 'x', edited: ['frontend/src/scenes/aLogic.ts'], now,
    opened: [{ skill: 'writing-kea-logics', at: '2026-10-19T09:10:00Z' }, { skill: 'writing-tests', at: '2026-10-19T09:05:00Z' }],
    suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:00Z' }, { skill: 'writing-tests', areas: ['kind:kea-logic'], at: '2026-10-19T09:30:00Z' }] });
  assert.deepEqual(r.organic, ['writing-tests'], 'opened before its suggestion: organic');
  assert.deepEqual(r.followed, ['writing-kea-logics']);
  const k = ev.areas['kind:kea-logic'];
  assert.equal(decayed(k.exposures, now), 1);
  assert.equal(k.skills['writing-kea-logics'].organic, undefined);
  assert.equal(decayed(k.skills['writing-kea-logics'].suggested, now), 1);
  assert.equal(decayed(k.skills['writing-kea-logics'].followed, now), 1);
  assert.equal(decayed(k.skills['writing-tests'].organic, now), 1);
  // the same session again, grown by one edit elsewhere: the first area is not counted twice
  creditSession(ev, { session: 'x', edited: ['frontend/src/scenes/aLogic.ts', 'posthog/migrations/0002.py'], now, opened: [{ skill: 'writing-tests', at: '2026-10-19T09:05:00Z' }], suggestions: [] });
  assert.equal(decayed(k.exposures, now), 1);
  assert.equal(decayed(k.skills['writing-tests'].organic, now), 1);
  assert.equal(decayed(ev.areas['kind:migration'].exposures, now), 1);
  assert.equal(decayed(ev.areas['kind:migration'].skills['writing-tests'].organic, now), 1);
  // a withheld suggestion was never shown: the open stays organic
  const ev2 = emptyEvidence();
  assert.deepEqual(creditSession(ev2, { session: 'y', edited: ['a/bLogic.ts'], opened: [{ skill: 's1', at: '2026-10-19T09:10:00Z' }], suggestions: [{ skill: 's1', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:00Z', withheld: true }] }).organic, ['s1']);
});

test('counts decay by their age with the half-life, applied on read', () => {
  const now = Date.now();
  assert.equal(decayed({ v: 4, at: now - 30 * DAY }, now, 30), 2);
  assert.ok(Math.abs(decayed({ v: 4, at: now - 60 * DAY }, now, 30) - 1) < 1e-9);
  const ev = keaEvidence(now - 90 * DAY);
  const fresh = candidates(keaEvidence(now), 'frontend/src/scenes/dashLogic.ts', { now }).get('writing-kea-logics');
  const old = candidates(ev, 'frontend/src/scenes/dashLogic.ts', { now }).get('writing-kea-logics');
  const mean = ps => Math.max(...ps.map(p => p.alpha / (p.alpha + p.beta)));
  assert.ok(mean(old) < mean(fresh), 'three half-lives later the evidence weighs an eighth, and the posterior falls back towards the prior');
});

test('Beta draws with a fixed seed are repeatable and centred on the mean; Thompson sampling picks the skill the evidence favours, top two above the floor', () => {
  const xs = (seed, a, b) => { const rng = seededRng(seed); return Array.from({ length: 4000 }, () => sampleBeta(a, b, rng)); };
  assert.deepEqual(xs(7, 2, 5).slice(0, 5), xs(7, 2, 5).slice(0, 5));
  const m = xs(1, 2, 5).reduce((s, x) => s + x, 0) / 4000; assert.ok(Math.abs(m - 2 / 7) < 0.02, `mean ${m}`);
  const ms = xs(2, 0.5, 2).reduce((s, x) => s + x, 0) / 4000; assert.ok(Math.abs(ms - 0.2) < 0.02, `shape under 1: mean ${ms}`);
  const ev = keaEvidence(), file = 'frontend/src/scenes/dashLogic.ts';
  const a = suggestFrom(ev, file, { rng: seededRng(3) }), b = suggestFrom(ev, file, { rng: seededRng(3) });
  assert.deepEqual(a.map(p => p.skill), b.map(p => p.skill));
  let won = 0; for (let s = 0; s < 100; s++) if (suggestFrom(ev, file, { rng: seededRng(s) })[0]?.skill === 'writing-kea-logics') won++;
  assert.ok(won > 90, `won ${won} of 100`);
  assert.ok(suggestFrom(ev, file, { rng: seededRng(1) }).length <= SKILL_SUGGEST.max);
  assert.deepEqual(suggestFrom(ev, file, { rng: seededRng(1) }).greedy, ['writing-kea-logics']);
  // nothing above the floor: nothing at all
  assert.deepEqual([...suggestFrom(ev, file, { rng: seededRng(1), cfg: { ...SKILL_SUGGEST, floor: 1.01 } })], []);
  // a skill whose description shares a word of the path enters with a small prior and is tried now and then
  const lex = suggestFrom(ev, 'posthog/migrations/0003_x.py', { rng: seededRng(5), max: 2 });
  assert.ok(candidates(ev, 'posthog/migrations/0003_x.py').has('django-migrations'));
  let tried = 0; for (let s = 0; s < 200; s++) if (suggestFrom(ev, 'posthog/migrations/0003_x.py', { rng: seededRng(s) }).some(p => p.skill === 'django-migrations')) tried++;
  assert.ok(tried > 20 && tried < 180, `explored ${tried} of 200`); void lex;
  // excluded skills (already suggested or opened) are not candidates
  assert.ok(!candidates(ev, file, { exclude: new Set(['writing-kea-logics']) }).has('writing-kea-logics'));
});

test('misses count as successes on unread sessions, broken-after-read as failures', () => {
  const ev = emptyEvidence(), now = Date.now();
  creditSession(ev, { session: 'a', edited: ['posthog/migrations/0001_init.py'], now });
  const r = creditOutcome(ev, [{ skill: 'django-migrations', file: 'posthog/migrations/0001_init.py', read: false, shown: true }, { skill: 'writing-tests', file: '', read: true }], { areas: ['dir1:posthog'], session: 'a', now });
  assert.deepEqual(r.map(x => x.verdict), ['missed', 'broken-after-read']);
  assert.equal(r[0].shown, true, 'a suggestion not followed is still a miss: the line is not the skill');
  const m = ev.areas['kind:migration'].skills['django-migrations'];
  assert.equal(decayed(m.missed, now), 1);
  assert.equal(decayed(m.unread, now), 1, 'the session that missed it is an unread session of the row the check created');
  assert.equal(decayed(ev.areas['dir1:posthog'].skills['writing-tests'].negative, now), 1);
  const c = candidates(ev, 'posthog/migrations/0002.py', { now }).get('django-migrations');
  assert.ok(c.every(p => p.alpha > SKILL_SUGGEST.a0));
  // a negative adds to beta: the same row read and broken twice more falls
  const before = Math.max(...c.map(p => p.alpha / (p.alpha + p.beta)));
  creditOutcome(ev, [{ skill: 'django-migrations', file: 'posthog/migrations/0001_init.py', read: true }, { skill: 'django-migrations', file: 'posthog/migrations/0001_init.py', read: true }], { session: 'a', now });
  const after = Math.max(...candidates(ev, 'posthog/migrations/0002.py', { now }).get('django-migrations').map(p => p.alpha / (p.alpha + p.beta)));
  assert.ok(after < before, `${after} < ${before}`);
});

test('scoring counts only the sessions where the skill was not read: a followed suggestion costs nothing, an ignored one counts', () => {
  const now = Date.parse('2026-10-19T12:00:00Z'), file = 'frontend/src/scenes/dashLogic.ts';
  const mean = (ev, skill) => Math.max(...candidates(ev, file, { now }).get(skill).map(p => p.alpha / (p.alpha + p.beta)));
  const ev = keaEvidence(now), m0 = mean(ev, 'writing-kea-logics');
  const k = ev.areas['kind:kea-logic'].skills['writing-kea-logics'];
  assert.equal(decayed(k.unread, now), 2, 'two of ten seeded sessions did not open it');
  // ten sessions suggested it and the agent followed: nothing for or against it
  for (let i = 0; i < 10; i++) creditSession(ev, { session: `f${i}`, edited: [file], now, suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:00Z' }], opened: [{ skill: 'writing-kea-logics', at: '2026-10-19T09:01:00Z' }] });
  assert.equal(decayed(k.unread, now), 2);
  assert.ok(Math.abs(mean(ev, 'writing-kea-logics') - m0) < 1e-9, 'followed suggestions leave the posterior where it was');
  // suggested and ignored: an unread session; with a miss it rises, without one it falls
  const ign = (id, miss) => {
    creditSession(ev, { session: id, edited: [file], now, suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:00Z' }] });
    if (miss) creditOutcome(ev, [{ skill: 'writing-kea-logics', file, read: false, shown: true }], { session: id, now });
  };
  for (let i = 0; i < 6; i++) ign(`m${i}`, true);
  assert.equal(decayed(k.unread, now), 8, 'a miss in an already-unread session is not counted twice');
  const m1 = mean(ev, 'writing-kea-logics'); assert.ok(m1 > m0, `${m1} > ${m0}`);
  for (let i = 0; i < 12; i++) ign(`n${i}`, false);
  assert.ok(mean(ev, 'writing-kea-logics') < m1);
  // recording a session again that turns out to have opened it takes its unread count back
  creditSession(ev, { session: 'n0', edited: [file], now, opened: [{ skill: 'writing-kea-logics', at: '2026-10-19T10:00:00Z' }], suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:00Z' }] });
  assert.equal(decayed(k.unread, now), 19);
});

test('a row made late counts the earlier sessions of its area as unread, unless the skill was added since', () => {
  const now = Date.now(), file = 'frontend/src/scenes/dashLogic.ts';
  const ev = emptyEvidence(); ev.skills = { old: { file: '.agents/skills/old/SKILL.md' }, fresh: { file: '.agents/skills/fresh/SKILL.md' } };
  for (let i = 0; i < 9; i++) creditSession(ev, { session: `q${i}`, edited: [file], now });
  // opened once, in the tenth session: one success against nine unread sessions, not a lone success
  creditSession(ev, { session: 'q9', edited: [file], now, opened: [{ skill: 'old' }] });
  assert.equal(decayed(ev.areas['kind:kea-logic'].skills.old.unread, now), 9);
  assert.ok(candidates(ev, file, { now }).get('old').every(p => p.alpha / (p.alpha + p.beta) < 0.15));
  // a skill that appeared after the evidence began has no history to be unread in
  refreshRegistry(ev, fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-empty-')), { now });
  assert.deepEqual(ev.skills, {}, 'the registry follows the checkout');
  ev.skills = { old: { file: 'x' }, fresh: { file: 'y', added: new Date(now).toISOString() } };
  creditOutcome(ev, [{ skill: 'fresh', file, read: false }], { session: 'q9', now });
  assert.equal(decayed(ev.areas['kind:kea-logic'].skills.fresh.unread, now), 1);
  assert.equal(decayed(ev.areas['kind:kea-logic'].skills.fresh.missed, now), 1);
});

test('the words of the path only bring a skill in when the file has no evidence-backed candidate at all', () => {
  const now = Date.now(), ev = keaEvidence(now);
  ev.skills['kea-forms'] = { file: '.agents/skills/kea-forms/SKILL.md', description: 'Forms in kea logic files.' };
  // the kea logic file has evidence (writing-kea-logics): no lexical newcomer
  assert.deepEqual([...candidates(ev, 'frontend/src/scenes/dashLogic.ts', { now }).keys()], ['writing-kea-logics']);
  // a migration nobody has worked on: the description's words decide, at the small prior
  const c = candidates(ev, 'posthog/migrations/0003_x.py', { now });
  assert.ok(c.has('django-migrations'));
  assert.deepEqual(c.get('django-migrations'), [{ area: null, alpha: SKILL_SUGGEST.a0 + SKILL_SUGGEST.lexical, beta: SKILL_SUGGEST.b0 }]);
  assert.ok(SKILL_SUGGEST.lexical <= 0.25);
});

test('the per-turn cap holds inside a file: a direct call never returns more lines than perTurn', t => {
  withEnv(t, { THINKER_LOG: 'off' });
  const { store } = repoWithSkills(t);
  const now = Date.now(), ev = emptyEvidence(); ev.seeded = 'x';
  ev.skills = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { file: `.agents/skills/s${i}/SKILL.md`, description: 'x' }]));
  const files = Array.from({ length: 6 }, (_, i) => `d${i}/aLogic.ts`);
  for (let j = 0; j < 10; j++) creditSession(ev, { session: `c${j}`, edited: files, opened: Object.keys(ev.skills).map(skill => ({ skill })), now });
  saveEvidence(store, ev);
  const out = skillSuggestLines(store, { session: 'cap', client: 'codex', files, rng: seededRng(4), now });
  assert.equal(out.split('\n').length, SKILL_SUGGEST.perTurn);
  assert.equal(skillSuggestLines(store, { session: 'cap', client: 'codex', files: ['d9/bLogic.ts'], rng: seededRng(5), now }), '');
  // a held-out session is capped the same way, in what it withholds
  skillSuggestLines(store, { session: 'cap-h', client: 'codex', files, holdout: true, rng: seededRng(4), now });
  assert.equal(sessionSuggestions(store, 'cap-h').length, SKILL_SUGGEST.perTurn);
});

test('suggestions are scoped to the turn: a new turn or a compaction can say a skill again, one turn never repeats it', t => {
  withEnv(t, { THINKER_LOG: 'off' });
  const { store, dir } = repoWithSkills(t);
  const now = Date.now(), ev = emptyEvidence(); ev.seeded = 'x';
  ev.skills = { 'writing-kea-logics': { file: '.agents/skills/writing-kea-logics/SKILL.md', description: 'kea logic' } };
  for (let j = 0; j < 12; j++) creditSession(ev, { session: `k${j}`, edited: ['frontend/src/scenes/dashLogic.ts'], opened: [{ skill: 'writing-kea-logics' }], now });
  saveEvidence(store, ev);
  const say = (o) => skillSuggestLines(store, { session: 's', client: 'codex', rng: seededRng(1), now, ...o });
  assert.match(say({ turn: 1, files: ['frontend/src/scenes/dashLogic.ts'] }), /writing-kea-logics/);
  assert.equal(say({ turn: 1, files: ['frontend/src/scenes/otherLogic.ts'] }), '', 'said once in a turn, across files');
  assert.equal(say({ turn: 1, files: ['frontend/src/scenes/dashLogic.ts'] }), '', 'a file is seen once in a turn');
  assert.match(say({ turn: 2, files: ['frontend/src/scenes/otherLogic.ts'] }), /writing-kea-logics/, 'a new turn may say it again');
  // opened by the agent in this turn: not suggested again in it
  assert.equal(say({ turn: 3, files: ['frontend/src/scenes/dashLogic.ts'], opened: ['writing-kea-logics'] }), '');
  // a compaction in the transcript resets the turn's state too
  const tr = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tr, '{"type":"user"}\n');
  assert.equal(say({ turn: 3, files: ['frontend/src/scenes/otherLogic.ts'], transcript: tr }), '');
  fs.appendFileSync(tr, '{"type":"system","subtype":"compact_boundary"}\n');
  assert.match(say({ turn: 3, files: ['frontend/src/scenes/otherLogic.ts'], transcript: tr }), /writing-kea-logics/, 'compacted: said again');
  fs.appendFileSync(tr, '{"type":"compacted","payload":{}}\n'.replace('"type":"compacted"', '"type": "compacted"'));
  assert.match(say({ turn: 3, files: ['frontend/src/scenes/dashLogic.ts'], transcript: tr }), /writing-kea-logics/, 'a Codex compaction counts too');
  // the session's log keeps every suggestion, for learning
  assert.equal(sessionSuggestions(store, 's').length, 4);
});

test('the hook says each skill once a session, for a file the first time it is seen; a held-out turn withholds and logs', t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_SUGGEST: undefined });
  const { store } = repoWithSkills(t);
  const ev = keaEvidence(); ev.seeded = new Date().toISOString(); saveEvidence(store, ev);
  const rng = seededRng(11);
  const one = skillSuggestLines(store, { session: 's1', client: 'codex', files: ['frontend/src/scenes/dashLogic.ts'], rng });
  assert.match(one, /^<thinker-skill>Past sessions here used writing-kea-logics for files like this one: read \.agents\/skills\/writing-kea-logics\/SKILL\.md<\/thinker-skill>$/m);
  assert.doesNotMatch(one, /\(or run \//, 'a skill outside .claude/skills has no slash command');
  assert.equal(skillSuggestLines(store, { session: 's1', client: 'codex', files: ['frontend/src/scenes/dashLogic.ts'], rng }), '', 'a file seen before');
  assert.doesNotMatch(skillSuggestLines(store, { session: 's1', client: 'codex', files: ['frontend/src/scenes/otherLogic.ts'], rng }), /writing-kea-logics/, 'once per skill a session');
  assert.deepEqual(sessionSuggestions(store, 's1').map(s => s.skill).filter(s => s === 'writing-kea-logics'), ['writing-kea-logics']);
  // the agent opened it itself: not suggested afterwards
  assert.equal(skillSuggestLines(store, { session: 's2', client: 'claude', files: ['frontend/src/scenes/dashLogic.ts'], opened: ['writing-kea-logics'], rng }).includes('writing-kea-logics'), false);
  // held out: nothing said, the withheld suggestion logged and kept apart from what was shown
  assert.equal(skillSuggestLines(store, { session: 's3', client: 'claude', files: ['frontend/src/scenes/dashLogic.ts'], holdout: true, turn: 2, rng }), '');
  const w = logLines(store).filter(l => l.op === 'skill-suggest' && l.session === 's3');
  assert.equal(w.length >= 1, true); assert.equal(w[0].withheld, true); assert.equal(w[0].skill, 'writing-kea-logics'); assert.equal(w[0].turn, 2);
  assert.equal(sessionSuggestions(store, 's3')[0].withheld, true);
  // other clients, an unknown session, a skill file itself: nothing
  assert.equal(skillSuggestLines(store, { session: 's4', client: 'cursor', files: ['frontend/src/scenes/dashLogic.ts'], rng }), '');
  assert.equal(skillSuggestLines(store, { session: 'unknown', client: 'claude', files: ['frontend/src/scenes/dashLogic.ts'], rng }), '');
  assert.equal(skillSuggestLines(store, { session: 's5', client: 'claude', files: ['.agents/skills/writing-kea-logics/SKILL.md'], rng }), '');
});

test('a Claude Code skill keeps its slash command in the line', t => {
  withEnv(t, { THINKER_LOG: 'off' });
  const { store } = repoWithSkills(t);
  const ev = emptyEvidence(); ev.seeded = 'x'; ev.skills = { 'writing-tests': { file: '.claude/skills/writing-tests/SKILL.md', description: 'tests' } };
  for (let i = 0; i < 6; i++) creditSession(ev, { session: `s${i}`, edited: ['posthog/test/test_a.py'], opened: [{ skill: 'writing-tests' }] });
  saveEvidence(store, ev);
  assert.match(skillSuggestLines(store, { session: 'c', client: 'claude', files: ['posthog/test/test_b.py'], rng: seededRng(1) }), /read \.claude\/skills\/writing-tests\/SKILL\.md \(or run \/writing-tests\)<\/thinker-skill>/);
});

test('evidence is read from Claude Code and Codex transcripts: edits in order, skill opens with their times; seeding counts them as organic', t => {
  withEnv(t, { THINKER_LOG: 'local' });
  const { dir, store } = repoWithSkills(t);
  const claude = path.join(dir, 'c1.jsonl');
  const row = j => JSON.stringify(j);
  fs.writeFileSync(claude, [
    row({ type: 'user', cwd: dir, timestamp: '2026-10-19T09:00:00Z', message: { role: 'user', content: 'fix the dash logic' } }),
    row({ type: 'assistant', timestamp: '2026-10-19T09:01:00Z', message: { content: [{ type: 'tool_use', id: '1', name: 'Read', input: { file_path: path.join(dir, '.agents/skills/writing-kea-logics/SKILL.md') } }] } }),
    row({ type: 'assistant', timestamp: '2026-10-19T09:02:00Z', message: { content: [{ type: 'tool_use', id: '2', name: 'Edit', input: { file_path: path.join(dir, 'frontend/src/scenes/dashLogic.ts'), old_string: 'a', new_string: 'b' } }] } }),
    row({ type: 'assistant', timestamp: '2026-10-19T09:03:00Z', message: { content: [{ type: 'tool_use', id: '3', name: 'Skill', input: { skill: 'writing-tests' } }] } }),
  ].join('\n') + '\n');
  const h = sessionSkillEvidence(claude);
  assert.equal(h.client, 'claude');
  assert.deepEqual(h.edited, ['frontend/src/scenes/dashLogic.ts']);
  assert.deepEqual(h.opened.map(o => o.skill), ['writing-kea-logics', 'writing-tests']);
  assert.equal(h.opened[0].at, '2026-10-19T09:01:00Z');
  const codex = path.join(dir, 'rollout-2026-10-19-x.jsonl');
  const patch = `*** Begin Patch\n*** Update File: ${path.join(dir, 'posthog/migrations/0001_init.py')}\n@@\n-x\n+y\n*** End Patch`;
  fs.writeFileSync(codex, [
    row({ type: 'session_meta', timestamp: '2026-10-19T09:00:00Z', payload: { id: 'cx1', cwd: dir, timestamp: '2026-10-19T09:00:00Z' } }),
    row({ type: 'response_item', timestamp: '2026-10-19T09:01:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `sed -n 1,80p ${dir}/.agents/skills/django-migrations/SKILL.md` }) } }),
    row({ type: 'response_item', timestamp: '2026-10-19T09:02:00Z', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } }),
  ].join('\n') + '\n');
  const hc = sessionSkillEvidence(codex);
  assert.equal(hc.client, 'codex'); assert.equal(hc.id, 'cx1');
  assert.deepEqual(hc.edited, ['posthog/migrations/0001_init.py']);
  assert.deepEqual(hc.opened.map(o => o.skill), ['django-migrations']);
  const r = seedSkillEvidence(store, [claude, codex]);
  assert.equal(r.sessions, 2);
  const ev = loadEvidence(store), now = Date.now();
  assert.ok(ev.seeded);
  assert.ok(decayed(ev.areas['kind:kea-logic'].skills['writing-kea-logics'].organic, now) > 0.9);
  assert.ok(decayed(ev.areas['kind:migration'].skills['django-migrations'].organic, now) > 0.9);
  assert.equal(logLines(store).find(l => l.op === 'skill-evidence-seed').sessions, 2);
  // a session whose suggestion came first: the open counts as followed, not organic, and recording twice changes nothing
  const ev2 = emptyEvidence();
  recordSkillEvidence(store, h, { session: 'c1', suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:30Z' }], ev: ev2 });
  recordSkillEvidence(store, h, { session: 'c1', suggestions: [{ skill: 'writing-kea-logics', areas: ['kind:kea-logic'], at: '2026-10-19T09:00:30Z' }], ev: ev2 });
  assert.equal(ev2.areas['kind:kea-logic'].skills['writing-kea-logics'].organic, undefined);
  assert.equal(decayed(ev2.areas['kind:kea-logic'].skills['writing-kea-logics'].followed, now), 1);
  assert.equal(decayed(ev2.areas['kind:kea-logic'].exposures, now), 1);
});

test('the facts of a hook input: Codex patches, skill paths, the Skill tool', () => {
  const ev = { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: frontend/src/scenes/dashLogic.ts\n*** End Patch' } };
  assert.deepEqual(hookSkillFacts(ev, '/r').files, ['frontend/src/scenes/dashLogic.ts']);
  assert.deepEqual(hookSkillFacts({ tool_name: 'Read', tool_input: { file_path: '/r/.agents/skills/x-y/SKILL.md' } }, '/r', ['.agents/skills/x-y/SKILL.md']).opened, ['x-y']);
  assert.deepEqual(hookSkillFacts({ tool_name: 'Skill', tool_input: { skill: 'writing-tests' } }, '/r').opened, ['writing-tests']);
});

// a model that records the prompt and schema it was given and answers with a fixed reply
function fakeModel(t, dir, reply) {
  const script = path.join(dir, 'model.cjs'), seen = path.join(dir, 'seen.jsonl');
  fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(seen)},JSON.stringify({prompt:s,schema:process.env.THINKER_SCHEMA||''})+'\\n');console.log(${JSON.stringify(JSON.stringify(reply))});});`);
  withEnv(t, { THINKER_LLM_CMD: `node "${script}"`, THINKER_LLM: 'command', ANTHROPIC_API_KEY: undefined });
  t.after(() => resetFallback());
  const all = () => { try { return fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return Object.assign(() => all().at(-1), { all });
}
const sessionEvents = dir => [
  { t: 'prompt', text: 'add a migration for the new column' },
  ...Array.from({ length: 4 }, () => ({ t: 'tool', name: 'Read', input: { file_path: `${dir}/posthog/migrations/0001_init.py` }, result: 'x = 1' })),
  { t: 'tool', name: 'Edit', input: { file_path: `${dir}/posthog/migrations/0001_init.py`, old_string: 'x = 1', new_string: 'x = 2' }, result: 'ok' },
  { t: 'say', text: 'Added the migration in posthog/migrations/0001_init.py.' },
];
// a checkout with a rule naming writing-tests for test files, an AGENTS.md, evidence for migrations, and a
// Claude Code session that changed a migration, added a test and read writing-tests
function outcomeRepo(t, { config = { harness: { skillSuggest: true, skillOutcome: true, skillOutcomeShare: 1 } } } = {}) {
  const r = repoWithSkills(t, { config });
  const { dir, store } = r;
  fs.mkdirSync(path.join(dir, '.claude/rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/rules/writing-tests.md'), "---\npaths:\n  - '**/test_*.py'\n---\nYou MUST invoke the `/writing-tests` skill before writing a test.\n");
  fs.writeFileSync(path.join(dir, '.claude/rules/kea.md'), "---\nglobs: ['frontend/src/**/*Logic.ts']\n---\nKea rule.\n");
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\n\n## Commits and Pull Requests\nUse conventional commits.\n\n## Code Style\nNo bare excepts.\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'guidance');
  const ev = emptyEvidence(); ev.skills = refreshRegistry(emptyEvidence(), dir).skills; ev.seeded = 'x';
  for (let i = 0; i < 6; i++) creditSession(ev, { session: `m${i}`, edited: ['posthog/migrations/0002_x.py'], opened: [{ skill: 'django-migrations' }] });
  saveEvidence(store, ev);
  fs.writeFileSync(path.join(dir, 'posthog/migrations/0001_init.py'), 'x = 2\n');
  fs.mkdirSync(path.join(dir, 'posthog/test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'posthog/test/test_new.py'), 'def test_x():\n    assert True\n');
  const at = s => new Date(Date.now() - 60_000 + s * 1000).toISOString(), row = j => JSON.stringify(j);
  const file = path.join(dir, 'outcome-session.jsonl');
  fs.writeFileSync(file, [
    row({ type: 'user', sessionId: 'os1', cwd: dir, timestamp: at(0), message: { role: 'user', content: 'add the column' } }),
    row({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: '1', name: 'Read', input: { file_path: path.join(dir, '.claude/skills/writing-tests/SKILL.md') } }] } }),
    row({ type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', id: '2', name: 'Edit', input: { file_path: path.join(dir, 'posthog/migrations/0001_init.py'), old_string: 'x = 1', new_string: 'x = 2' } }] } }),
    row({ type: 'assistant', timestamp: at(3), message: { content: [{ type: 'tool_use', id: '3', name: 'Write', input: { file_path: path.join(dir, 'posthog/test/test_new.py'), content: 'def test_x():\n    assert True\n' } }] } }),
    row({ type: 'assistant', timestamp: at(4), message: { content: [{ type: 'text', text: 'Added the column and a test.' }] } }),
  ].join('\n') + '\n');
  return { ...r, file };
}
const REPLY = { notes: [], violations: [
  { rule: 'Migrations must be non-blocking', source: 'skill django-migrations (.agents/skills/django-migrations/SKILL.md)', file: 'posthog/migrations/0001_init.py', evidence: '+x = 2 blocks' },
  { rule: 'Tests assert behaviour', source: 'skill writing-tests (.claude/skills/writing-tests/SKILL.md)', file: 'posthog/test/test_new.py', evidence: '+assert True' },
  { rule: 'No bare excepts', source: 'AGENTS.md', file: 'posthog/migrations/0001_init.py', evidence: '+x' },
] };

test('the outcome check: its own switch, never in test mode unless forced, a share of sessions by id', t => {
  const { store } = outcomeRepo(t);
  assert.equal(skillOutcomeOn(store, { THINKER_TEST: '1' }), false, 'the config alone does not run it in test mode');
  assert.equal(skillOutcomeOn(store, { THINKER_TEST: '1', THINKER_HARNESS_SKILL_OUTCOME: 'on' }), true, 'forced');
  assert.equal(skillOutcomeOn(store, {}), true);
  assert.equal(skillOutcomeOn(store, { THINKER_HARNESS_SKILL_OUTCOME: 'off' }), false);
  const plain = repoWithSkills(t);
  assert.equal(skillOutcomeOn(plain.store, {}), false, 'off by default, with suggestions on');
  assert.equal(outcomeSampled('abc', 0), false); assert.equal(outcomeSampled('abc', 1), true);
  assert.equal(outcomeSampled('abc', 0.25), outcomeSampled('abc', 0.25));
  const n = Array.from({ length: 4000 }, (_, i) => outcomeSampled(`s-${i}`, 0.25)).filter(Boolean).length;
  assert.ok(n > 900 && n < 1100, `${n} of 4000`);
});

test('the guidance helpers: rule globs, skills a rule names, process sections left out, a violation credited by name or path', t => {
  assert.deepEqual(ruleGlobs("---\npaths:\n  - '**/test_*.py'\n  - \"a/*.ts\"\n---\nx"), ['**/test_*.py', 'a/*.ts']);
  assert.deepEqual(ruleGlobs("---\nglobs: ['x/**/*Logic.ts', y.md]\n---\n"), ['x/**/*Logic.ts', 'y.md']);
  assert.ok(globRegex('**/test_*.py').test('posthog/test/test_new.py') && globRegex('**/test_*.py').test('test_a.py'));
  assert.ok(globRegex('frontend/src/**/*Logic.ts').test('frontend/src/scenes/aLogic.ts') && !globRegex('frontend/src/**/*Logic.ts').test('frontend/aLogic.ts'));
  assert.ok(globRegex('a/*.{ts,tsx}').test('a/b.tsx'));
  assert.deepEqual(skillsNamedIn('invoke the `/writing-tests` skill, then /django-migrations.', ['writing-tests', 'django-migrations', 'writing']), ['writing-tests', 'django-migrations']);
  const skills = [{ name: 'writing-tests', file: '.claude/skills/writing-tests/SKILL.md' }, { name: 'writing-tests-e2e', file: '.agents/skills/writing-tests-e2e/SKILL.md' }];
  assert.equal(violationSkill('skill writing-tests (.claude/skills/writing-tests/SKILL.md)', skills), 'writing-tests');
  assert.equal(violationSkill('AGENTS.md (Tests) / writing-tests-e2e skill', skills), 'writing-tests-e2e');
  assert.equal(violationSkill('AGENTS.md', skills), null);
  const { dir } = outcomeRepo(t);
  assert.deepEqual(matchingRules(dir, ['posthog/test/test_new.py']).map(r => r.path), ['.claude/rules/writing-tests.md']);
  const a = agentsSections(dir, ['posthog/test/test_new.py']);
  assert.match(a[0].text, /No bare excepts/); assert.doesNotMatch(a[0].text, /conventional commits/);
});

test('the outcome check sees the change, the skills that bear on it in full and the rules that match; a miss when unread, a negative when read', async t => {
  withEnv(t, { THINKER_LOG: 'local' });
  const { dir, store, file } = outcomeRepo(t);
  const prompts = [];
  const completeFn = async o => { prompts.push(o); return { json: REPLY, cost: 0.12, usage: { input_tokens: 1000, output_tokens: 100 } }; };
  const env = { ...process.env, THINKER_HARNESS_SKILL_OUTCOME: 'on' };
  const r = await skillOutcomeCheck(store, file, { session: 'os1', completeFn, env });
  assert.equal(prompts.length, 1);
  const p = prompts[0].prompt;
  assert.match(p, /^-x = 1\n\+x = 2$/m, 'the edited file, diffed from the commit before the session');
  assert.match(p, /\+\+\+ b\/posthog\/test\/test_new\.py/, 'a file the session created');
  assert.match(p, /===== skill django-migrations \(\.agents\/skills\/django-migrations\/SKILL\.md\) =====\n---\nname: django-migrations/, 'the evidence names it; its full text');
  assert.match(p, /===== skill writing-tests \(\.claude\/skills\/writing-tests\/SKILL\.md\) =====/, 'named by a matching rule');
  assert.match(p, /===== \.claude\/rules\/writing-tests\.md =====/); assert.doesNotMatch(p, /Kea rule/);
  assert.match(p, /No bare excepts/); assert.doesNotMatch(p, /conventional commits/);
  assert.equal(prompts[0].schema, OUTCOME_SCHEMA);
  assert.deepEqual(r.guidance.skills.map(s => [s.name, s.by]), [['django-migrations', 'evidence'], ['writing-tests', 'rule']]);
  assert.deepEqual(r.credited.map(c => [c.skill, c.verdict]), [['django-migrations', 'missed'], ['writing-tests', 'broken-after-read']]);
  const ev = loadEvidence(store), now = Date.now();
  assert.ok(decayed(ev.areas['kind:migration'].skills['django-migrations'].missed, now) > 0.9);
  assert.ok(decayed(ev.areas['kind:py-test'].skills['writing-tests'].negative, now) > 0.9);
  const log = logLines(store).filter(l => l.op === 'skill-outcome');
  assert.equal(log.length, 1); assert.equal(log[0].cost, 0.12); assert.equal(log[0].violations.length, 3);
  assert.deepEqual(log[0].credited.map(c => c.verdict), ['missed', 'broken-after-read']);
  assert.equal(await skillOutcomeCheck(store, file, { session: 'os1', completeFn, env }), null, 'once a session');
  assert.equal(prompts.length, 1);
  // not sampled, not on, or nothing with skills to check: no call
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), harness: { skillSuggest: true, skillOutcome: true, skillOutcomeShare: 0 } }));
  assert.equal(await skillOutcomeCheck(store, file, { session: 'os2', completeFn, env }), null);
  assert.equal(await skillOutcomeCheck(store, file, { session: 'os3', completeFn, env: { ...env, THINKER_HARNESS_SKILL_OUTCOME: undefined } }), null);
  assert.equal(prompts.length, 1);
  void dir;
});

test('the outcome check in a desktop app: its model call goes through the session queue like a distillation', async t => {
  withEnv(t, { THINKER_LOG: 'local' });
  const { store, file } = outcomeRepo(t);
  const queue = path.join(store.dir, 'state/session-llm');
  withEnv(t, { THINKER_LLM: 'session', THINKER_SESSION_QUEUE: queue, THINKER_HARNESS_SKILL_OUTCOME: 'on', ANTHROPIC_API_KEY: undefined });
  t.after(() => resetFallback());
  markBuild(queue, process.pid);
  const done = skillOutcomeCheck(store, file, { session: 'app1' });
  const { request } = await nextRequest(queue, { waitMs: 5000, pollMs: 10 });
  assert.ok(request, 'the request reached the session queue');
  assert.match(request.prompt, /^GUIDANCE:/); assert.ok(request.schema.properties.violations);
  assert.deepEqual(answerRequest(queue, request.id, JSON.stringify({ violations: REPLY.violations })), { ok: true });
  const r = await done;
  assert.deepEqual(r.credited.map(c => c.verdict), ['missed', 'broken-after-read']);
});

test('distillFile runs the outcome check apart from the distillation, which is as on main', async t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_OUTCOME: 'on' });
  const { dir, store, file } = outcomeRepo(t);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), learn: { auditRate: 1, quietExplore: 0 } }));
  const seen = fakeModel(t, dir, REPLY);
  await distillFile({ repo: dir, store, out() {} }, file, { incremental: true, session: 'os1', minExplore: 0 });
  const calls = seen.all();
  assert.equal(calls.length, 2, 'the outcome check, then the distillation');
  assert.ok(calls.some(c => /GUIDANCE:/.test(c.prompt)), 'the outcome check');
  assert.ok(calls.every(c => !/broken_rules|SKILLS COVERING/.test(c.prompt + c.schema)), 'the distillation is not asked for broken rules');
  assert.ok(logLines(store).some(l => l.op === 'skill-outcome' && l.credited?.some(c => c.skill === 'django-migrations' && c.verdict === 'missed')));
  assert.ok(logLines(store).some(l => l.op === 'skill-evidence'));
});

test('switched off, nothing changes: no hook line, no state, no evidence, no outcome check, a distillation as before', async t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_SUGGEST: undefined, THINKER_HOLDOUT: 'off' });
  const { dir, store } = repoWithSkills(t, { config: {} });
  assert.equal(skillSuggestOn(store), false);
  assert.equal(skillSuggestOn(store, { THINKER_HARNESS_SKILL_SUGGEST: 'on' }), true);
  const on = repoWithSkills(t);
  assert.equal(skillSuggestOn(on.store, { THINKER_HARNESS_SKILL_SUGGEST: 'off' }), false, 'the env wins over the config');
  assert.equal(skillSuggestLines(store, { session: 's', client: 'claude', files: ['frontend/src/scenes/dashLogic.ts'] }), '');
  assert.equal(skillOutcomeOn(store, { THINKER_HARNESS_SKILL_OUTCOME: 'on' }), false, 'the outcome check needs suggestions on');
  const seen = fakeModel(t, dir, { notes: [] });
  const r = await distillEvents(sessionEvents(dir), {});
  assert.equal(r.brokenRules, undefined);
  assert.doesNotMatch(seen().prompt, /SKILLS COVERING|broken_rules/);
  assert.equal(JSON.parse(seen().schema).properties.broken_rules, undefined);
  const trace = path.join(dir, 'session.jsonl');
  fs.writeFileSync(trace, sessionEvents(dir).map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), learn: { auditRate: 1 } }));
  await distillFile({ repo: dir, store, out() {} }, trace, { incremental: true, session: 'off', minExplore: 1, format: 'events' });
  assert.doesNotMatch(seen().prompt, /SKILLS COVERING|GUIDANCE:/);
  const out = execFileSync('node', [CLI, 'hook', 'tool', '--repo', dir], { input: JSON.stringify({ session_id: 'h-off', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'frontend/src/scenes/dashLogic.ts') } }), encoding: 'utf8', env: { ...process.env, THINKER_NO_LEARN: '1' } });
  assert.doesNotMatch(out, /thinker-skill/);
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'skill-evidence.json')), false);
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'skill-suggest.json')), false);
  assert.equal(logLines(store).some(l => /^skill-/.test(l.op)), false);
});

test('the tool hook delivers the line to Claude Code and to Codex', t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HOLDOUT: 'off' });
  const { dir, store } = repoWithSkills(t);
  const ev = keaEvidence(); ev.seeded = new Date().toISOString(); saveEvidence(store, ev);
  const env = { ...process.env, THINKER_NO_LEARN: '1' };
  for (const client of ['claude', 'codex']) {
    const out = execFileSync('node', [CLI, 'hook', 'tool', '--repo', dir, '--client', client, ...(client === 'codex' ? ['--late'] : [])], { input: JSON.stringify({ session_id: `h-${client}`, tool_name: 'Read', tool_input: { file_path: path.join(dir, 'frontend/src/scenes/dashLogic.ts') } }), encoding: 'utf8', env });
    const j = JSON.parse(out.trim());
    assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(j.hookSpecificOutput.additionalContext, /<thinker-skill>Past sessions here used writing-kea-logics for files like this one: read \.agents\/skills\/writing-kea-logics\/SKILL\.md<\/thinker-skill>/, client);
  }
  const lines = logLines(store).filter(l => l.op === 'skill-suggest');
  assert.deepEqual(lines.map(l => l.client), ['claude', 'codex']);
  assert.equal(lines[0].file, 'frontend/src/scenes/dashLogic.ts');
});
