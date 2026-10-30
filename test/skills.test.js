import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { refresh, attest, lookup, orient } from '../src/ops.js';
import { rank, renderNote } from '../src/rank.js';
import { parseTranscript } from '../src/transcripts.js';
import { safeLearningAssessments } from '../src/learning-pending.js';
import { learningPlan } from '../src/learning-evidence.js';
import { maintain, maintenanceNotice, pickStale, DEFAULTS, renderMaintain } from '../src/maintain.js';
import { parseSkill, findSkills, scanSkills, auditSkill, reviewSkill, dedupeSkills, skillClusters, skillsInvoked, skillNotesFor, skillRows, renderSkills, markSkillBroken } from '../src/skills.js';
import { distillSpec, saveNotes } from '../src/distill.js';

const SKILL = (name, extra = '') => `---
name: ${name}
description: Run the billing test suite the way this repository expects, with the fixtures database up.
---

# Testing billing

Run \`npm run test:billing\` after starting the fixtures database. The suite lives beside the code it
tests: \`src/billing/charge.js\` holds the charge path and its tests call \`charge\` with an idempotency key,
which \`charge()\` requires. Never pass \`--no-key\`.
${extra}`;

function fixture(t, { twin = false } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-skills-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['config', 'commit.gpgsign', 'false']);
  const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
  write('src/billing/charge.js', 'export function charge(order, key) {\n  if (!key) throw new Error("idempotency key required");\n  return { order, key };\n}\n');
  write('src/billing/ledger.js', 'export function recordRefund(refund) {\n  return { ...refund, recorded: true };\n}\n');
  write('.claude/skills/testing-billing/SKILL.md', SKILL('testing-billing'));
  if (twin) write('.agents/skills/testing-billing/SKILL.md', SKILL('testing-billing', '\nAlso works for Codex.\n'));
  if (twin) write('.cursor/skills/refunds/SKILL.md', `---\nname: refunds\ndescription: Record a refund in the ledger before calling the provider.\n---\n\nCall \`recordRefund\` in \`src/billing/ledger.js\` first; the provider call comes after.\n`);
  write('.agents/skills/refunds/SKILL.md', `---\nname: refunds\ndescription: Record a refund in the ledger before calling the provider.\n---\n\nCall \`recordRefund\` in \`src/billing/ledger.js\` first; the provider call comes after.\n`);
  write('.claude/skills/not-a-skill/README.md', 'no SKILL.md here');
  git(['add', '.']); git(['commit', '-q', '-m', 'one']);
  return { repo, store: new Store(repo).init(), write, git };
}

// a model that writes a card from the skill text, with the deps the skill names
const cardModel = async ({ prompt }) => {
  const files = [...prompt.matchAll(/^- (\S+)$/gm)].map(m => m[1]);
  const name = /^SKILL (\S+)/m.exec(prompt)[1];
  return { json: { body: `${name}: the skill's rules.\nRests on ${files.join(', ')}.`, applies: `when ${name}`, answers: [`how do I ${name}`], deps: files.map(f => ({ path: f, symbol: /charge\.js$/.test(f) ? 'charge' : undefined })), tags: ['billing'] }, tokens: { totalTokens: 1000 } };
};
const env = { THINKER_LOG: 'off', THINKER_TELEMETRY: 'off', THINKER_NO_BG_VERIFY: '1' };
function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('skill files are found under the agents\' roots, with their front matter', t => {
  const { repo } = fixture(t, { twin: true });
  const found = findSkills(repo);
  assert.deepEqual(found.map(s => s.file), ['.agents/skills/refunds/SKILL.md', '.agents/skills/testing-billing/SKILL.md', '.claude/skills/testing-billing/SKILL.md', '.cursor/skills/refunds/SKILL.md']);
  assert.equal(found[0].name, 'refunds'); assert.match(found[0].description, /^Record a refund/);
  const p = parseSkill('---\nname: x\ndescription: >\n  folded over\n  two lines\n---\nbody');
  assert.equal(p.description, 'folded over two lines'); assert.equal(p.body, 'body');
});

test('a scan cards each skill with the file and the code it names as deps, settles duplicates, and reads a file once per content', t => withEnv(async () => {
  const { repo, store, write } = fixture(t, { twin: true });
  const r = await scanSkills(store, { completeFn: cardModel, limit: 10 });
  assert.equal(r.found, 4); assert.equal(r.read, 3); assert.equal(r.saved.length, 3); assert.equal(r.tokens, 3000);
  assert.deepEqual(r.aliases, [{ file: '.cursor/skills/refunds/SKILL.md', of: '.agents/skills/refunds/SKILL.md' }], 'an identical copy under another root is not carded');
  const cards = store.list().filter(n => n.kind === 'skill');
  assert.equal(cards.length, 3);
  const claude = cards.find(n => n.skill.file === '.claude/skills/testing-billing/SKILL.md');
  assert.equal(claude.title, 'Skill: testing-billing'); assert.equal(claude.skill.name, 'testing-billing'); assert.equal(claude.skill.root, '.claude/skills');
  assert.ok(claude.deps.some(d => d.path === '.claude/skills/testing-billing/SKILL.md' && !d.symbol), 'the file is a dep');
  assert.ok(claude.deps.some(d => d.path === 'src/billing/charge.js' && d.symbol === 'charge'), 'the code it names is a symbol dep');
  assert.equal(claude.source.type, 'skill'); assert.equal(claude.source.hash.length, 16);
  assert.ok(claude.answers.includes('how do I testing-billing'));
  // the same skill in two roots: one is served, the other archived as its duplicate
  assert.equal(r.duplicates.length, 1);
  const twin = cards.find(n => n.skill.file === '.agents/skills/testing-billing/SKILL.md');
  const kept = store.get(r.duplicates[0].kept), dropped = store.get(r.duplicates[0].dropped[0]);
  assert.equal(kept.id, claude.id, 'the root the agents look in first wins when nothing else separates them');
  assert.equal(dropped.id, twin.id); assert.equal(dropped.archived.reason, `duplicate of ${claude.id}`);
  assert.equal(store.list().find(n => n.skill?.name === 'refunds').archived, undefined, 'a different skill with a card of the same shape is not a duplicate');
  // nothing to read again
  const again = await scanSkills(store, { completeFn: async () => { throw new Error('must not be called'); } });
  assert.equal(again.read, 0); assert.equal(again.skills.length, 0);
  // the dry run names what a change would read
  write('.agents/skills/refunds/SKILL.md', fs.readFileSync(path.join(repo, '.agents/skills/refunds/SKILL.md'), 'utf8') + '\nMore.\n');
  const dry = await scanSkills(store, { dry: true, completeFn: cardModel });
  assert.deepEqual(dry.skills, ['.agents/skills/refunds/SKILL.md', '.cursor/skills/refunds/SKILL.md'], 'the copy no longer matches: it is a skill of its own now');
  const upd = await scanSkills(store, { completeFn: cardModel });
  assert.equal(upd.updated.length, 1); assert.equal(upd.saved.length, 1);
  const refunds = store.get(upd.updated[0].id);
  assert.equal(refunds.history.at(-1).reason, 'skill file changed');
  assert.equal(upd.duplicates.length, 2, 'two refunds skills now, the same name in two roots, beside the testing-billing pair');
  assert.equal(store.get(upd.saved[0].id).archived.reason, `duplicate of ${refunds.id}`);
  // a removed file retires its card, free
  fs.rmSync(path.join(repo, '.agents/skills/refunds'), { recursive: true });
  fs.rmSync(path.join(repo, '.cursor/skills/refunds'), { recursive: true });
  const gone = await scanSkills(store, { completeFn: async () => { throw new Error('must not be called'); } });
  assert.equal(gone.removed.length, 2); assert.equal(store.get(refunds.id).status, 'invalid');
  // a session cannot write a skill card; the distiller is not even offered the kind
  assert.ok(!distillSpec().schema.properties.notes.items.properties.kind.enum.includes('skill'));
  const s = saveNotes(store, [{ title: 'x', kind: 'skill', answers: [], body: 'y', deps: [{ path: 'src/billing/charge.js' }], tags: [], confidence: 0.9 }], { source: { type: 'agent' } });
  assert.equal(s.saved.length, 0); assert.match(s.skipped[0].reason, /skill files/);
}));

test('a skill the code contradicts is marked out of date with its issues, leaves serving and audit, and comes back on a file change or a review', t => withEnv(async () => {
  const { repo, store, write, git } = fixture(t);
  await scanSkills(store, { completeFn: cardModel });
  const card = store.list().find(n => n.skill?.name === 'testing-billing');
  // served while fresh
  assert.ok(rank(store.list(), { query: 'how do I run the billing tests', mode: 'lookup' }).some(r => r.note.id === card.id));
  assert.match(renderNote(card), /Invoke the skill `testing-billing` \(\.claude\/skills\/testing-billing\/SKILL\.md\)/);
  // the code moves: the key is optional now, so the skill's rule is wrong
  write('src/billing/charge.js', 'export function charge(order, key) {\n  return { order, key: key || null };\n}\n');
  git(['add', '.']); git(['commit', '-q', '-m', 'two']);
  const [stale] = refresh(store, [store.get(card.id)]);
  assert.equal(stale.status, 'pending'); assert.ok(stale.recheck.changed.some(c => c.symbol === 'charge'));
  assert.deepEqual(pickStale([stale], DEFAULTS, { now: Date.now() }).stale.map(n => n.id), [], 'not served lately: waits for a serving');
  assert.deepEqual(pickStale([{ ...stale, lastUsed: new Date().toISOString() }], DEFAULTS).stale.map(n => n.id), [card.id]);
  const fileChanged = { ...stale, lastUsed: new Date().toISOString(), recheck: { changed: [...stale.recheck.changed, { path: card.skill.file, reason: 'file changed' }] } };
  assert.deepEqual(pickStale([fileChanged], DEFAULTS).stale, [], 'a card whose own file changed is rewritten by the scan, not audited');
  const prompts = [];
  const audit = async ({ prompt }) => { prompts.push(prompt); return { json: { verdict: 'broken', reason: 'the key is optional now', issues: [{ claim: 'charge() requires an idempotency key', actual: 'charge accepts a missing key', pointer: 'src/billing/charge.js:charge' }] }, tokens: { totalTokens: 500 } }; };
  const r = await auditSkill(store, stale, { completeFn: audit });
  assert.equal(r.verdict, 'broken'); assert.equal(r.issues.length, 1);
  assert.match(prompts[0], /SKILL testing-billing/); assert.match(prompts[0], /Never pass/); assert.match(prompts[0], /CURRENT CODE OF EACH DEPENDENCY/);
  const broken = store.get(card.id);
  assert.equal(broken.status, 'broken'); assert.equal(broken.broken.source, 'audit'); assert.equal(broken.broken.issues[0].claim, 'charge() requires an idempotency key');
  assert.equal(broken.stale, undefined, 'the deps are re-baselined: broken, not stale');
  // out of serving: ranking, lookup by kind, orientation; still there by id, with the banner
  assert.ok(!rank(store.list(), { query: 'how do I run the billing tests', mode: 'lookup' }).some(x => x.note.id === card.id));
  const byKind = await lookup(store, { query: '', kind: 'skill' });
  assert.ok(!byKind.included.some(n => n.id === card.id));
  const o = await orient(store, { task: 'how do I run the billing tests', client: 'cli', recordUsage: false });
  assert.ok(!o.included.some(n => n.id === card.id));
  assert.match(renderNote(broken), /OUT OF DATE: this skill contradicts the code: the key is optional now/);
  assert.match(renderNote(broken), /thinker skills review/);
  // out of audit: a further code change does not make it stale, and maintenance never picks it
  write('src/billing/charge.js', 'export function charge(order, key) {\n  return { order, key: key ?? null, v: 2 };\n}\n');
  const [still] = refresh(store, [store.get(card.id)]);
  assert.equal(still.status, 'broken'); assert.equal(pickStale([still], DEFAULTS).stale.length, 0);
  // the report and the notice carry the issues
  const rows = skillRows(store); assert.equal(rows[0].status, 'broken'); assert.equal(rows[0].broken.issues.length, 1);
  assert.match(renderSkills(rows), /OUT OF DATE\s+testing-billing/); assert.match(renderSkills(rows), /charge\(\) requires an idempotency key → charge accepts a missing key/);
  assert.match(maintenanceNotice(store), /1 skill is out of date \(testing-billing\); not served until fixed or reviewed; see thinker skills/);
  // a person fixes the file: the card is rewritten and the skill is back
  write('.claude/skills/testing-billing/SKILL.md', SKILL('testing-billing', '\nThe key is optional since v2.\n'));
  const upd = await scanSkills(store, { completeFn: cardModel });
  assert.equal(upd.updated[0].wasBroken, true);
  const back = store.get(card.id);
  assert.equal(back.status, 'fresh'); assert.equal(back.broken, undefined); assert.ok(back.history.at(-1).broken, 'the issues stay in the history');
  assert.ok(rank(store.list(), { query: 'how do I run the billing tests', mode: 'lookup' }).some(x => x.note.id === card.id));
  // or reviews it without touching the file
  markSkillBroken(store, back, { reason: 'again', issues: [{ claim: 'c', actual: 'a' }] });
  assert.equal(store.get(card.id).status, 'broken');
  const rv = reviewSkill(store, card.id);
  assert.equal(rv.note.status, 'fresh'); assert.equal(store.get(card.id).broken, undefined);
  assert.equal(reviewSkill(store, 'nope').error, 'no such note');
}));

test('maintenance cards new skill files and counts a skill found out of date apart from violated behaviors', t => withEnv(async () => {
  const { repo, store, write, git } = fixture(t);
  await scanSkills(store, { completeFn: cardModel });
  const card = store.list().find(n => n.skill?.name === 'testing-billing');
  card.uses = 1; card.lastUsed = new Date().toISOString(); store.put(card);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), maintain: { skills: true } }));  // the scan is off by default since 2026-10-21
  write('src/billing/charge.js', 'export function charge(order) {\n  return { order };\n}\n');
  git(['add', '.']); git(['commit', '-q', '-m', 'two']);
  const verified = [];
  const r = await maintain(store, repo, { fns: {
    spentToday: () => 0,
    verify: async (s, n) => { verified.push(n.id); return { verdict: 'broken', tokens: 100 }; },
    phrase: async (s, notes) => ({ done: notes, tokens: 0 }),
    skills: async ({ limit }) => ({ saved: [{ id: 'a' }], updated: [], removed: [], duplicates: [], tokens: 700, limit }),
  } });
  assert.deepEqual(verified, [card.id]);
  assert.equal(r.skillsBroken, 1); assert.equal(r.violated, undefined);
  assert.equal(r.skills, 1); assert.equal(r.tokens, 800);
  assert.match(renderMaintain(r), /1 skill card/); assert.match(renderMaintain(r), /1 skill found out of date/);
}));

test('an invoked skill is read from the transcript and assessed; a contradiction records the issue and takes the skill out', t => withEnv(async () => {
  const { repo, store } = fixture(t);
  await scanSkills(store, { completeFn: cardModel });
  const card = store.list().find(n => n.skill?.name === 'testing-billing');
  const file = path.join(repo, 's1.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { role: 'user', content: 'run the billing tests' } },
    { type: 'assistant', message: { model: 'claude-test-1', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'testing-billing' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill: testing-billing' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${repo}/.claude/skills/testing-billing\n\n# Testing billing\n...` }] } },
    { type: 'assistant', message: { model: 'claude-test-1', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run test:billing' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'npm ERR! missing script: test:billing' }] } },
    { type: 'assistant', message: { model: 'claude-test-1', content: [{ type: 'text', text: 'the script the skill names does not exist; ran node --test instead' }] } },
  ].map(j => JSON.stringify(j)).join('\n') + '\n');
  const { events } = parseTranscript(file);
  const inv = skillsInvoked(events);
  assert.equal(inv.length, 1); assert.equal(inv[0].name, 'testing-billing'); assert.equal(inv[0].dir, `${repo}/.claude/skills/testing-billing`);
  assert.equal(events.filter(e => e.t === 'prompt').length, 1, 'the loaded skill is not a prompt');
  const served = skillNotesFor(store, inv);
  assert.equal(served.length, 1); assert.equal(served[0].id, card.id); assert.match(served[0].text, /^---\nname: testing-billing/);
  // a session that ended before the skill's present text was committed cannot judge it
  assert.equal(skillNotesFor(store, inv, { sessionEnd: Date.now() - 365 * 86400_000 }).length, 0);
  assert.equal(skillNotesFor(store, inv, { sessionEnd: Date.now() + 1000 }).length, 1);
  // a plugin-qualified name and a name known only by its directory both resolve
  assert.equal(skillNotesFor(store, [{ name: 'testing-billing', raw: 'plugin:testing-billing' }])[0].id, card.id);
  assert.equal(skillNotesFor(store, [{ name: 'other', raw: 'other', dir: '/x/.claude/skills/testing-billing' }])[0].id, card.id);
  // the invoked skill is always assessed, even in a session that mentions no note id
  const plan = learningPlan(events, { served, repo, key: 's1' });
  assert.ok(['assessment', 'evidence', 'audit'].includes(plan.mode)); assert.ok(plan.served.some(n => n.id === card.id));
  // a contradiction is accepted at once (no investigation queue) and marks the skill broken, body untouched
  const a = { id: card.id, verdict: 'contradicted', evidence: 'npm run test:billing: missing script', correction: '' };
  const safe = safeLearningAssessments(store, [a], served);
  assert.equal(safe.accepted.length, 1); assert.equal(safe.deferred.length, 0);
  const applied = attest(store, safe.accepted, { session: 's1', client: 'claude' });
  assert.equal(applied[0].broken, true);
  const n = store.get(card.id);
  assert.equal(n.status, 'broken'); assert.equal(n.broken.source, 'session'); assert.equal(n.broken.session, 's1');
  assert.equal(n.body, card.body, 'the card is not rewritten'); assert.equal(n.attest.contradicted, 1);
  assert.match(n.broken.issues[0].actual, /missing script/);
  // a broken skill is not offered for assessment again
  assert.equal(skillNotesFor(store, inv).length, 0);
  // a confirmation raises confidence as for any note
  reviewSkill(store, card.id);
  attest(store, [{ id: card.id, verdict: 'confirmed', evidence: 'ran the suite as the skill says' }], { session: 's2' });
  assert.equal(store.get(card.id).attest.confirmed, 1); assert.ok(store.get(card.id).confidence > n.confidence);
}));

test('duplicates: a pin wins, then not broken, then the sessions\' verdicts', t => {
  const { repo, store } = fixture(t);
  const mk = (id, file, root, extra = {}) => ({ id, kind: 'skill', title: id, skill: { name: 'testing-billing', file, root, description: 'run the billing suite' }, body: 'the same card', applies: 'when billing', deps: [{ path: file }], status: 'fresh', confidence: 0.8, ...extra });
  const a = mk('a', '.claude/skills/testing-billing/SKILL.md', '.claude/skills'), b = mk('b', '.agents/skills/testing-billing/SKILL.md', '.agents/skills');
  const other = { id: 'c', kind: 'skill', title: 'c', skill: { name: 'refunds', file: '.agents/skills/refunds/SKILL.md', root: '.agents/skills', description: 'record a refund' }, body: 'the same card', applies: 'refunds', deps: [], status: 'fresh' };
  assert.deepEqual(skillClusters([a, b, other]).map(g => g.map(n => n.id)), [['a', 'b']]);
  for (const n of [a, b, other]) store.put(n);
  assert.deepEqual(dedupeSkills(store), [{ kept: 'a', dropped: ['b'] }]);
  assert.equal(store.get('b').archived.reason, 'duplicate of a'); assert.equal(store.get('c').archived, undefined);
  // the sessions confirmed b: it takes over, and a is the duplicate now
  store.put({ ...store.get('b'), attest: { confirmed: 3, contradicted: 0, unused: 0 } });
  assert.deepEqual(dedupeSkills(store), [{ kept: 'b', dropped: ['a'] }]);
  assert.equal(store.get('b').archived, undefined); assert.equal(store.get('a').archived.reason, 'duplicate of b');
  // a broken skill never wins
  store.put({ ...store.get('b'), status: 'broken', broken: { issues: [] } });
  assert.deepEqual(dedupeSkills(store), [{ kept: 'a', dropped: ['b'] }]);
  // a person's pin wins over everything
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ skills: { prefer: ['b'] } }));
  assert.deepEqual(dedupeSkills(store), [{ kept: 'b', dropped: ['a'] }]);
});
