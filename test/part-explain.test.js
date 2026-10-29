import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { partKey, viewParts, missingExplains, explainParts, attachExplains, readExplains, saveExplains, explainFile } from '../src/part-explain.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function machine(t) {
  const home = tmp('thinker-explain-');
  const saved = process.env.THINKER_HOME; process.env.THINKER_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = saved; fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}
const store = () => ({ repo: '/tmp/repo', dir: '/tmp/repo/.thinker', config: () => ({}), log: () => {} });

const VIEW = {
  instructions: { file: 'AGENTS.md', sections: [{ title: 'Releases', file: 'AGENTS.md', text: 'How a release is cut.', tokens: 900, wastedWindow: 40 }] },
  skills: [{ name: 'dataviz', text: 'charts', tokens: 500, wastedWindow: 10, client: 'claude' }],
  tools: [{ name: 'Artifact', kind: 'tool', group: 'builtin', text: 'publishes a page', tokens: 16000, wastedWindow: 900, client: 'claude' }],
  outputs: { tools: [{ name: 'Bash:sed', perCall: 1000, wastedWindow: 500 }] },
};

test('a part is keyed by what it is, so a tool is explained once for the machine and a rewritten section again', () => {
  // a tool or an output is the same thing in every repository: its name is the key, and nothing about this
  // repository or this week enters it, which is what lets one explanation be written once and kept
  assert.equal(partKey({ kind: 'tool', name: 'Artifact', builtin: true }), 'tool:builtin:Artifact');
  assert.equal(partKey({ kind: 'tool', name: 'Artifact', builtin: true, repo: 'other' }), 'tool:builtin:Artifact');
  assert.equal(partKey({ kind: 'output', name: 'Bash:sed' }), 'output:Bash:sed');
  // a custom tool is told apart from a built-in one of the same name
  assert.notEqual(partKey({ kind: 'tool', name: 'Artifact', toolKind: 'mcp' }), partKey({ kind: 'tool', name: 'Artifact', builtin: true }));
  // text that can be rewritten is in the key, so an explanation never describes what used to be there
  const a = partKey({ kind: 'section', name: 'Releases', file: 'AGENTS.md', text: 'one' });
  assert.equal(a, partKey({ kind: 'section', name: 'Releases', file: 'AGENTS.md', text: 'one' }));
  assert.notEqual(a, partKey({ kind: 'section', name: 'Releases', file: 'AGENTS.md', text: 'two' }));
  assert.notEqual(partKey({ kind: 'skill', name: 'dataviz', text: 'one' }), partKey({ kind: 'skill', name: 'dataviz', text: 'two' }));
});

test('every part of a view is listed, heaviest waste first, each seeded with what it is', () => {
  const ps = viewParts(VIEW);
  assert.deepEqual(ps.map(p => p.name), ['Artifact', 'Bash:sed', 'Releases', 'dataviz']);
  // a tool output carries no text of its own: the one-clause gloss (part-describe.js) stands in, so the
  // model is never asked to explain a bare name and never answers "no description was given"
  assert.equal(ps.find(p => p.name === 'Bash:sed').about, 'edits or prints lines of a file');
  assert.ok(ps.find(p => p.name === 'Bash:sed').text);
});

test('the suite never reads or writes the developer’s own explanations unless it names a home', () => {
  const saved = process.env.THINKER_HOME; delete process.env.THINKER_HOME;
  try { assert.equal(explainFile(), null); assert.deepEqual(readExplains(), {}); assert.equal(saveExplains({ a: { what: 'x' } }), 0); }
  finally { if (saved !== undefined) process.env.THINKER_HOME = saved; }
});

test('explanations are written in batches, kept for the machine, and put back on the rows they belong to', async t => {
  machine(t);
  const seen = [];
  const batchFn = async (_s, parts) => {
    seen.push(parts.map(p => p.name));
    return { explains: Object.fromEntries(parts.map(p => [p.key, { what: `what ${p.name} is`, why: `why ${p.name}`, keep: `lose ${p.name}`, name: p.name, kind: p.kind }])), tokens: 10 };
  };
  const r = await explainParts(store(), viewParts(VIEW), { per: 3, conc: 1, batchFn });
  assert.equal(r.saved, 4);
  assert.deepEqual(seen, [['Artifact', 'Bash:sed', 'Releases'], ['dataviz']]);
  // kept for the machine, so the next page visit and every other repository read them without spending again
  const have = readExplains();
  assert.equal(Object.keys(have).length, 4);
  const v = attachExplains(VIEW, have);
  assert.equal(v.tools[0].explain.what, 'what Artifact is');
  assert.equal(v.outputs.tools[0].explain.why, 'why Bash:sed');
  assert.equal(v.instructions.sections[0].explain.keep, 'lose Releases');
  assert.equal(v.skills[0].explain.what, 'what dataviz is');
  // nothing is asked for twice
  assert.deepEqual(missingExplains(VIEW, have), []);
});

test('a batch that fails costs its own parts only, and half an answer is never stored as the explanation', async t => {
  machine(t);
  const { explainBatch } = await import('../src/part-explain.js');
  // the model answered for one part and gave the other an empty why: only the usable one is kept
  const completeFn = async () => ({ json: { parts: [
    { n: 1, what: 'a tool that publishes a page you can share', why: 'nothing uses it unless you ask for pages', keep: 'you lose the shareable link' },
    { n: 2, what: 'ok', why: '', keep: '' },
  ] }, model: 'haiku' });
  const parts = viewParts(VIEW).slice(0, 2);
  const { explains } = await explainBatch(store(), parts, { completeFn });
  assert.deepEqual(Object.keys(explains), [parts[0].key]);

  let calls = 0;
  const batchFn = async (_s, g) => { calls++; if (g.some(p => p.name === 'dataviz')) throw new Error('model said no'); return { explains: Object.fromEntries(g.map(p => [p.key, { what: 'a'.repeat(20), why: 'b'.repeat(20), keep: 'c' }])), tokens: 1 }; };
  const r = await explainParts(store(), viewParts(VIEW), { per: 1, conc: 1, batchFn });
  assert.equal(calls, 4);
  assert.equal(r.failed, 1);
  assert.equal(r.saved, 3); // the three that answered are kept
});

// Desktop apps (AGENTS.md, MANDATORY): in Claude Desktop, the Codex app or Cursor the hooks have no agent CLI
// with a login to call, so a model-backed feature must queue for the session's own model (session-work.js)
// instead of failing. The page's button reaches the same command either way.
test('with no agent CLI signed in, explaining is queued for the app session instead of failing', async t => {
  const home = machine(t);
  const { commands } = await import('../src/commands/explain.js');
  const { writeSnapshot } = await import('../src/context-snapshot.js');
  const repo = tmp('thinker-explain-repo-');
  const st = { repo, dir: path.join(repo, '.thinker'), config: () => ({}), log: () => {} };
  fs.mkdirSync(path.join(repo, '.thinker', 'state'), { recursive: true });
  writeSnapshot(st, 30, VIEW);

  const said = [], queued = [];
  await commands.explain({ store: st, flags: {}, out: s => said.push(s),
    availableFn: () => [], appFn: () => 'Claude Desktop', enqueueFn: (_s, key, args) => queued.push([key, args]) });
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'explain');
  assert.deepEqual(queued[0][1].slice(0, 2), ['explain', '--repo']);
  assert.match(said.join(' '), /queued for your Claude Desktop session/);

  // and with a CLI signed in it just runs, within the day's token budget
  const ran = [];
  await commands.explain({ store: st, flags: { quiet: true }, out: s => said.push(s),
    availableFn: () => ['claude'], explainFn: async (_s, parts) => { ran.push(parts.length); return { saved: parts.length, failed: 0, tokens: 1 }; } });
  assert.deepEqual(ran, [4]);

  // the day's budget stops it rather than spending past the cap
  const stopped = [];
  await commands.explain({ store: st, flags: {}, out: s => stopped.push(s),
    availableFn: () => ['claude'], capFn: () => ({ ok: false, spent: 2e6, cap: 1e6 }), explainFn: async () => { throw new Error('must not spend'); } });
  assert.match(stopped.join(' '), /token budget is used up/);
  fs.rmSync(repo, { recursive: true, force: true });
});
