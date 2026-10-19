// Skill suggestions by file (src/skill-suggest.js): evidence, decay, Thompson sampling, holdout, delivery,
// the distillation's broken rules, and nothing at all with the switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { resetFallback } from '../src/llm.js';
import { distillEvents } from '../src/distill.js';
import { distillFile } from '../src/commands/learn.js';
import {
  areaKeys, creditSession, creditOutcome, decayed, emptyEvidence, seededRng, sampleBeta, suggestFrom, candidates,
  skillSuggestOn, skillSuggestLines, loadEvidence, saveEvidence, recordSkillEvidence, sessionSkillEvidence, seedSkillEvidence,
  sessionSuggestions, distillSkillContext, recordBrokenRules, eventSkillFacts, hookSkillFacts, SKILL_SUGGEST,
} from '../src/skill-suggest.js';

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

test('misses count as successes, broken-after-read as negatives that are logged, not scored', () => {
  const ev = emptyEvidence(), now = Date.now();
  creditSession(ev, { session: 'a', edited: ['posthog/migrations/0001_init.py'], now });
  const r = creditOutcome(ev, [{ skill: 'django-migrations', file: 'posthog/migrations/0001_init.py', read: false }, { skill: 'writing-tests', file: '', read: true }], { areas: ['dir1:posthog'], now });
  assert.deepEqual(r.map(x => x.verdict), ['missed', 'broken-after-read']);
  assert.equal(decayed(ev.areas['kind:migration'].skills['django-migrations'].missed, now), 1);
  assert.equal(decayed(ev.areas['dir1:posthog'].skills['writing-tests'].negative, now), 1);
  const c = candidates(ev, 'posthog/migrations/0002.py', { now }).get('django-migrations');
  assert.ok(c.every(p => p.alpha > SKILL_SUGGEST.a0));
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

test('the facts of a hook input and of distiller events: Codex patches, skill paths, the Skill tool', () => {
  const ev = { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: frontend/src/scenes/dashLogic.ts\n*** End Patch' } };
  assert.deepEqual(hookSkillFacts(ev, '/r').files, ['frontend/src/scenes/dashLogic.ts']);
  assert.deepEqual(hookSkillFacts({ tool_name: 'Read', tool_input: { file_path: '/r/.agents/skills/x-y/SKILL.md' } }, '/r', ['.agents/skills/x-y/SKILL.md']).opened, ['x-y']);
  assert.deepEqual(hookSkillFacts({ tool_name: 'Skill', tool_input: { skill: 'writing-tests' } }, '/r').opened, ['writing-tests']);
  const f = eventSkillFacts([{ t: 'tool', name: 'Edit', input: { file_path: '/r/a/bLogic.ts' } }, { t: 'tool', name: 'Read', input: { file_path: '/r/.agents/skills/k/SKILL.md' } }, { t: 'tool', name: 'Skill', input: { skill: 'z' } }], '/r');
  assert.deepEqual(f.edited, ['a/bLogic.ts']); assert.deepEqual([...f.read].sort(), ['k', 'z']);
});

// a model that records the prompt and schema it was given and answers with a fixed reply
function fakeModel(t, dir, reply) {
  const script = path.join(dir, 'model.cjs'), seen = path.join(dir, 'seen.json');
  fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify({prompt:s,schema:process.env.THINKER_SCHEMA||''}));console.log(${JSON.stringify(JSON.stringify(reply))});});`);
  withEnv(t, { THINKER_LLM_CMD: `node "${script}"`, THINKER_LLM: 'command', ANTHROPIC_API_KEY: undefined });
  t.after(() => resetFallback());
  return () => JSON.parse(fs.readFileSync(seen, 'utf8'));
}
const sessionEvents = dir => [
  { t: 'prompt', text: 'add a migration for the new column' },
  ...Array.from({ length: 4 }, () => ({ t: 'tool', name: 'Read', input: { file_path: `${dir}/posthog/migrations/0001_init.py` }, result: 'x = 1' })),
  { t: 'tool', name: 'Edit', input: { file_path: `${dir}/posthog/migrations/0001_init.py`, old_string: 'x = 1', new_string: 'x = 2' }, result: 'ok' },
  { t: 'say', text: 'Added the migration in posthog/migrations/0001_init.py.' },
];

test('the distillation names the rules a change broke and their skill: a miss when the skill was not read, logged; the schema keeps the notes', async t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_SUGGEST: undefined });
  const { dir, store } = repoWithSkills(t);
  const seen = fakeModel(t, dir, { notes: [], broken_rules: [{ rule: 'migrations must be non-blocking', file: 'posthog/migrations/0001_init.py', source: 'django-migrations' }, { rule: 'run lint', file: 'posthog/migrations/0001_init.py', source: 'AGENTS.md' }] });
  const events = sessionEvents(dir);
  const ctx = distillSkillContext(store, events);
  assert.deepEqual(ctx.edited, ['posthog/migrations/0001_init.py']);
  assert.ok(ctx.skills.some(s => s.name === 'django-migrations' && s.file === '.agents/skills/django-migrations/SKILL.md'), 'found by the words of the path when no evidence names it');
  const r = await distillEvents(events, { skills: ctx.skills });
  assert.equal(r.brokenRules.length, 2); assert.deepEqual(r.notes, []);
  const s = seen();
  assert.match(s.prompt, /SKILLS COVERING THE CHANGED FILES:\n- django-migrations \(\.agents\/skills\/django-migrations\/SKILL\.md\): Writing safe django migrations\./);
  assert.doesNotMatch(s.prompt, /Body of django-migrations/, 'never the skill text');
  const schema = JSON.parse(s.schema);
  assert.ok(schema.properties.broken_rules && schema.required.includes('broken_rules') && schema.required.includes('notes'));
  const credited = recordBrokenRules(store, r.brokenRules, ctx, { session: 'd1' });
  assert.deepEqual(credited.map(c => c.verdict), ['missed']);
  const ev = loadEvidence(store);
  assert.ok(decayed(ev.areas['kind:migration'].skills['django-migrations'].missed, Date.now()) > 0.9);
  const outs = logLines(store).filter(l => l.op === 'skill-outcome');
  assert.deepEqual(outs.map(o => o.verdict), ['missed', 'other-source']);
  // read in the session and broken all the same: a negative
  const read = recordBrokenRules(store, r.brokenRules.slice(0, 1), { ...ctx, read: new Set(['django-migrations']) }, { session: 'd2' });
  assert.deepEqual(read.map(c => c.verdict), ['broken-after-read']);
});

test('distillFile with the switch on credits the session and asks for broken rules in the same call', async t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_SUGGEST: undefined });
  const { dir, store } = repoWithSkills(t);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), learn: { auditRate: 1 } }));
  const seen = fakeModel(t, dir, { notes: [], broken_rules: [{ rule: 'non-blocking', file: 'posthog/migrations/0001_init.py', source: '.agents/skills/django-migrations/SKILL.md' }] });
  const trace = path.join(dir, 'session.jsonl');
  fs.writeFileSync(trace, sessionEvents(dir).map(e => JSON.stringify(e)).join('\n') + '\n');
  await distillFile({ repo: dir, store, out() {} }, trace, { incremental: true, session: 'ds', minExplore: 1, format: 'events' });
  assert.match(seen().prompt, /SKILLS COVERING THE CHANGED FILES/);
  assert.ok(logLines(store).some(l => l.op === 'skill-outcome' && l.skill === 'django-migrations' && l.verdict === 'missed'));
});

test('switched off, nothing changes: no hook line, no state, no evidence, no broken rules in the distillation', async t => {
  withEnv(t, { THINKER_LOG: 'local', THINKER_HARNESS_SKILL_SUGGEST: undefined, THINKER_HOLDOUT: 'off' });
  const { dir, store } = repoWithSkills(t, { config: {} });
  assert.equal(skillSuggestOn(store), false);
  assert.equal(skillSuggestOn(store, { THINKER_HARNESS_SKILL_SUGGEST: 'on' }), true);
  const on = repoWithSkills(t);
  assert.equal(skillSuggestOn(on.store, { THINKER_HARNESS_SKILL_SUGGEST: 'off' }), false, 'the env wins over the config');
  assert.equal(skillSuggestLines(store, { session: 's', client: 'claude', files: ['frontend/src/scenes/dashLogic.ts'] }), '');
  assert.equal(distillSkillContext(store, sessionEvents(dir)), null);
  const seen = fakeModel(t, dir, { notes: [] });
  const r = await distillEvents(sessionEvents(dir), {});
  assert.deepEqual(r.brokenRules, []);
  assert.doesNotMatch(seen().prompt, /SKILLS COVERING|broken_rules/);
  assert.equal(JSON.parse(seen().schema).properties.broken_rules, undefined);
  const trace = path.join(dir, 'session.jsonl');
  fs.writeFileSync(trace, sessionEvents(dir).map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), learn: { auditRate: 1 } }));
  await distillFile({ repo: dir, store, out() {} }, trace, { incremental: true, session: 'off', minExplore: 1, format: 'events' });
  assert.doesNotMatch(seen().prompt, /SKILLS COVERING/);
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
