// What the sessions show (session-evidence.js, factory.js:loopDetail): the evidence the chat reads when it is asked
// why. Transcripts here are written to a scratch directory; no model and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-evidence-home-')));
for (const [k, v] of Object.entries({ THINKER_LOG: 'local', THINKER_TELEMETRY: 'off', THINKER_HOME: HOME })) process.env[k] = v;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });

const { loopDetail, sessionFactory, LOOP_KINDS } = await import('../src/factory.js');
const { sessionEvidence, evidenceLines, evidenceSaid, evidenceQuery, EVIDENCE } = await import('../src/session-evidence.js');
const { Store } = await import('../src/store.js');

const PRICE = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 };
// a call of a million fresh tokens costs a dollar at this price, so costs read as call counts
const call = () => ({ fresh: 1_000_000, read: 0, write: 0, out: 0 });
const tool = (c, name, input, extra = {}) => ({ t: 'tool', name, input, result: '', call: c, ...extra });

// A session that opens a pull request and is then asked to change it: the round edits, fails a test, passes it,
// commits and pushes. Then a check fails by itself and the agent pushes a fix unasked.
const reviewed = () => ({
  calls: Array.from({ length: 13 }, call),
  events: [
    { t: 'prompt', text: 'add the retry flag' },
    tool(0, 'Edit', { file_path: '/repo/src/retry.js' }),
    tool(1, 'Bash', { command: 'git commit -am retry && git push && gh pr create --title retry' }),
    { t: 'say', text: 'Opened the pull request.' },
    { t: 'prompt', text: 'the flag should default to off, and say so in the README' },
    tool(2, 'Read', { file_path: '/repo/README.md' }),
    tool(3, 'Edit', { file_path: '/repo/src/retry.js' }), tool(3, 'Edit', { file_path: '/repo/README.md' }),
    tool(4, 'Bash', { command: 'npm test' }, { result: 'not ok 3 - retry defaults\n1 failed', error: true }),
    tool(5, 'Bash', { command: "python3 - <<'EOF'\nimport re\nopen('src/retry.js').write('x')\nEOF" }),
    tool(6, 'Bash', { command: 'npm test' }),
    tool(7, 'Bash', { command: 'git commit -am "default off" && git push' }),
    { t: 'say', text: 'The flag now defaults to off and the README says so; pushed to the pull request.' },
    { t: 'prompt', text: '<task-notification>ci failed</task-notification>' },
    tool(8, 'Bash', { command: 'gh pr checks 12' }, { result: 'lint  fail', error: true }),
    tool(9, 'Edit', { file_path: '/repo/src/retry.js' }),
    tool(10, 'Bash', { command: 'git push' }, { result: '! [rejected] main -> main (fetch first)\nerror: failed to push some refs', error: true }),
    tool(11, 'Bash', { command: 'git pull --rebase && git push' }),
    { t: 'say', text: 'Lint is fixed and pushed.' },
  ],
});

test('what happened inside a loop: the prompt that opened it and who wrote it, the steps with what failed, and how the agent summed it up', () => {
  const d = loopDetail({ ...reviewed(), model: 'm' }, { price: PRICE });
  const round = d.loops.find(L => L.kind === 'sentback');
  assert.ok(round, 'the change the person asked for on the open pull request is a review round');
  assert.equal(round.name, 'Review round');
  assert.equal(round.prompt, 'the flag should default to off, and say so in the README');
  assert.equal(round.person, true);
  // the steps in order: a run of edits is one step, a script fed inline is named and not quoted, a failing command
  // carries the first telling line it printed
  assert.deepEqual(round.steps, ['read repo/README.md', 'edited src/retry.js, repo/README.md', '$ npm test → failed: not ok 3 - retry defaults', '$ python3 - (an inline script)', '$ npm test', '$ git commit -am "default off" && git push']);
  assert.equal(round.more, 0);
  assert.equal(round.said, 'The flag now defaults to off and the README says so; pushed to the pull request.');
  // the figures are the Factory's own: the same loops and the same cost as sessionFactory counts
  const f = sessionFactory({ ...reviewed(), model: 'm' }, { price: PRICE });
  assert.deepEqual(d.loops.map(L => [L.kind, L.calls, L.cost]).sort(), f.loops.map(L => [L.kind, L.calls, L.cost]).sort());
  assert.equal(d.title, 'add the retry flag');
  assert.equal(d.cost, f.cost);
});

test('asked about a stage: only the loops with a call there, the stage\'s own part of each, its steps kept first', () => {
  const d = loopDetail({ ...reviewed(), model: 'm' }, { price: PRICE, stage: 'merge', maxSteps: 3 });
  assert.ok(d.loops.length >= 1 && d.loops.every(L => L.stageCost > 0 && L.stageCost <= L.cost));
  // the costliest at that stage first
  assert.deepEqual(d.loops.map(L => L.stageCost), [...d.loops.map(L => L.stageCost)].sort((a, b) => b - a));
  const round = d.loops.find(L => L.kind === 'sentback');
  // a dollar a call: the commit and push is the one Merge call of the round
  assert.equal(round.stageCost, 1);
  // past the limit the stage's own step and the failure are what stay, and the rest is counted
  assert.ok(round.steps.includes('$ git commit -am "default off" && git push'));
  assert.ok(round.steps.some(s => /failed: not ok 3/.test(s)));
  assert.equal(round.steps.length, 3); assert.equal(round.more, 3);
  // a stage none of its loops reached has nothing to show; a kind filters to that kind
  assert.deepEqual(loopDetail({ ...reviewed(), model: 'm' }, { price: PRICE, stage: 'think' }).loops, []);
  assert.ok(loopDetail({ ...reviewed(), model: 'm' }, { price: PRICE, kind: 'fix' }).loops.every(L => L.kind === 'fix'));
  // the agent's own follow-up was opened by the harness, not the person, and its failed push is said
  const own = loopDetail({ ...reviewed(), model: 'm' }, { price: PRICE, kind: 'followup' }).loops[0];
  assert.equal(own?.person, false);
  assert.ok(own.steps.some(s => /\$ git push → failed: ! \[rejected\] main -> main \(fetch first\)/.test(s)), own.steps.join(' | '));
});

test('what was asked about is held to what exists', () => {
  assert.deepEqual(evidenceQuery({ stage: 'Merge', loop: 'sentback', days: '21' }), { stage: 'merge', loop: 'sentback', days: 21 });
  assert.deepEqual(evidenceQuery({ stage: 'deploy', loop: 'chaos', days: 'lots' }), { stage: null, loop: null, days: EVIDENCE.days });
  assert.equal(evidenceQuery({ days: 900 }).days, EVIDENCE.maxDays);
  assert.deepEqual(evidenceQuery(), { stage: null, loop: null, days: 14 });
  assert.ok(Object.keys(LOOP_KINDS).includes('sentback'));
});

// A Claude Code transcript of that session, as the agent writes it: a line an entry.
function transcript(file, { events, calls }, at) {
  const lines = [];
  let n = 0;
  const ts = () => new Date(at + (n++) * 1000).toISOString();
  const byCall = new Map();
  for (const e of events) if (e.t === 'tool') { if (!byCall.has(e.call)) byCall.set(e.call, []); byCall.get(e.call).push(e); }
  let nextCall = 0;
  const flush = upTo => {
    for (; nextCall <= upTo; nextCall++) {
      const tools = byCall.get(nextCall) || [];
      const usage = { input_tokens: calls[nextCall].fresh, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      lines.push({ type: 'assistant', timestamp: ts(), message: { id: `m${nextCall}`, role: 'assistant', model: 'claude-opus-4-5', usage, content: tools.length ? tools.map((t, i) => ({ type: 'tool_use', id: `t${nextCall}_${i}`, name: t.name, input: t.input })) : [{ type: 'text', text: '…' }] } });
      if (tools.length) lines.push({ type: 'user', timestamp: ts(), message: { role: 'user', content: tools.map((t, i) => ({ type: 'tool_result', tool_use_id: `t${nextCall}_${i}`, content: t.result || 'ok', ...(t.error ? { is_error: true } : {}) })) } });
    }
  };
  let last = -1;
  for (const e of events) {
    if (e.t === 'tool') { last = Math.max(last, e.call); continue; }
    flush(last);
    if (e.t === 'prompt') lines.push({ type: 'user', timestamp: ts(), message: { role: 'user', content: e.text } });
    else if (e.t === 'say') lines.push({ type: 'assistant', timestamp: ts(), message: { id: `s${n}`, role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: e.text }] } });
  }
  flush(calls.length - 1);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('the evidence for a question: the sessions with the most rework there, read from their transcripts, and the lines the chat is shown', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-evidence-')));
  const store = new Store(dir).init();
  const now = Date.now();
  // one session with a review round and a follow-up, one that only read a file
  const quiet = { calls: [call(), call()], events: [{ t: 'prompt', text: 'what does retry do?' }, tool(0, 'Read', { file_path: '/repo/src/retry.js' }), { t: 'say', text: 'It retries.' }] };
  const sessions = [
    { session: 'busy', file: transcript(path.join(dir, 'busy.jsonl'), reviewed(), now - 3 * 86_400_000), mtime: now - 3 * 86_400_000 },
    { session: 'quiet', file: transcript(path.join(dir, 'quiet.jsonl'), quiet, now - 2 * 86_400_000), mtime: now - 2 * 86_400_000 },
    { session: 'old', file: transcript(path.join(dir, 'old.jsonl'), reviewed(), now - 40 * 86_400_000), mtime: now - 40 * 86_400_000 },
  ];
  const ev = sessionEvidence(store, { stage: 'merge' }, { now, sessions });
  // the window's sessions are measured; the one with rework at Merge is read, the old one is outside the fortnight
  assert.deepEqual([ev.stage, ev.loop, ev.days, ev.measured, ev.hit, ev.sessions.length], ['merge', null, 14, 2, 1, 1]);
  const s = ev.sessions[0];
  assert.equal(s.id, 'busy'); assert.equal(s.title, 'add the retry flag');
  assert.ok(s.rework > 0 || s.reworkTokens > 0);
  assert.ok(s.loops.length >= 1 && s.loops.length <= EVIDENCE.loops);
  assert.ok(ev.kinds.some(k => k.kind === 'sentback'));
  assert.equal(evidenceSaid(ev, 'acme/api'), 'read 1 of the 1 session with rework at the Merge stage in acme/api, the last 14 days');
  const text = evidenceLines(ev, 'acme/api').join('\n');
  assert.match(text, /^acme\/api, the last 14 days, rework at the Merge stage: .* over 1 of the 2 sessions measured/);
  assert.match(text, /In the 1 read, the loops with a call at Merge, by kind, with what each kind put on that stage: /);
  assert.match(text, /\n- [A-Z][a-z]{2} \d+ · the session began: "add the retry flag" · claude-opus-4-5 · /);
  assert.match(text, /\n {2}· Review round \(the person asked for a change on the open pull request\), \d+ model calls?, .* of it at Merge\./);
  assert.match(text, /\n {4}The exchange opened with the person writing: "the flag should default to off, and say so in the README"/);
  assert.match(text, /\n {4}Inside the loop: .*\$ npm test → failed: .*\$ git commit -am "default off" && git push/);
  assert.match(text, /\n {4}The agent's last words in that exchange: "The flag now defaults to off/);
  // a kind of loop, over a longer window: the old session is in it too
  const fu = sessionEvidence(store, { loop: 'followup', days: 60 }, { now, sessions });
  assert.deepEqual([fu.loop, fu.days, fu.hit, fu.sessions.length], ['followup', 60, 2, 2]);
  assert.ok(fu.sessions.every(x => x.loops.every(L => L.kind === 'followup' && L.person === false)));
  assert.match(evidenceLines(fu, 'acme/api').join('\n'), /The exchange opened with a task notification or the harness, not the person/);
  // nothing of that kind: said so, with how many were looked through
  const none = sessionEvidence(store, { stage: 'merge' }, { now, sessions: [sessions[1]] });
  assert.equal(evidenceSaid(none, 'acme/api'), 'looked through 1 session of the last 14 days in acme/api: none had rework at the Merge stage');
  assert.deepEqual(evidenceLines(none, 'acme/api'), ['acme/api, the last 14 days: 1 sessions measured, and none had rework at the Merge stage.']);
  fs.rmSync(dir, { recursive: true, force: true });
});
