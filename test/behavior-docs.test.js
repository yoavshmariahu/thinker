import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { designDocs, deriveDocBehaviors, docBehaviorsLine } from '../src/behavior-docs.js';
import { listBehaviors, proposed } from '../src/behavior.js';
import { activeBehaviors, pendingBehaviors, discardPending, editBehavior } from '../src/behavior-workbench.js';
import { maintain, maintenanceNotice } from '../src/maintain.js';

const README = `# Billing

Charges go through one path so that money is never taken twice.

## Rules

A charge must never be retried without its idempotency key. Refunds are always
written to the ledger before the provider is called.

## Layout

\`charge.js\` holds the charge path and \`ledger.js\` the ledger. Everything else in this folder is glue that
exists to move data between the two, and none of it carries a requirement of its own worth writing down.
`;

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-docs-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
  write('src/billing/README.md', README);
  write('src/billing/charge.js', 'export function charge(order, key) {\n  if (!key) throw new Error("idempotency key required");\n  return { order, key };\n}\n');
  write('src/billing/ledger.js', 'export function recordRefund(refund) {\n  return { ...refund, recorded: true };\n}\n');
  write('CHANGELOG.md', '# Changelog\n\n' + 'The system must always do everything. '.repeat(20));
  write('docs/design-payments.md', '# Payments design\n\n' + 'Nothing here names a rule the code upholds, only background on why the payments work was started. '.repeat(6));
  write('node_modules/x/README.md', '# x\n\n' + 'must never '.repeat(60));
  write('src/billing/tiny/README.md', '# tiny\n');
  execFileSync('git', ['add', '-f', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
  return { repo, store: new Store(repo).init() };
}

const charge = { title: 'A charge is never retried without its idempotency key',
  body: 'src/billing/charge.js:charge refuses a charge that carries no idempotency key, so a retry cannot take money twice.',
  quote: 'A charge must never be retried without its idempotency key.', answers: ['can a charge be retried'],
  deps: [{ path: 'src/billing/charge.js', symbol: 'charge' }] };

test('design documents are the READMEs beside code and the design files, design files first', t => {
  const { repo } = fixture(t);
  assert.deepEqual(designDocs(repo).map(d => d.path), ['docs/design-payments.md', 'src/billing/README.md']);
  assert.deepEqual(designDocs(repo, { directories: ['src'] }).map(d => d.path), ['src/billing/README.md']);
});

test('a rule a document states becomes a mutable behavior in force, quoted and anchored', async t => {
  const { store } = fixture(t);
  const prompts = [];
  const completeFn = async ({ prompt }) => {
    prompts.push(prompt);
    if (!prompt.includes('DOCUMENT src/billing/README.md')) return { json: { behaviors: [] } };
    return { json: { behaviors: [charge,
      { ...charge, title: 'Refunds are free', quote: 'Refunds never cost the customer anything.' }, // not the document's words
      { ...charge, title: 'Refunds reach the ledger first', quote: 'written to the ledger before the provider is called', deps: [{ path: 'src/billing/ledger.js', symbol: 'missing' }] },
    ] } };
  };
  const r = await deriveDocBehaviors(store, { completeFn });
  assert.equal(r.read, 2);
  assert.match(prompts.find(p => p.includes('DOCUMENT src/billing/README.md')), /src\/billing\/charge\.js: charge\n[\s\S]*src\/billing\/ledger\.js: recordRefund/);
  assert.deepEqual(r.saved.map(b => b.doc), ['src/billing/README.md']);
  assert.deepEqual(r.rejected.map(x => x.reason), ['quote is not in the document', 'points at code that was not shown']);
  const [b] = listBehaviors(store);
  assert.equal(b.mutability, 'mutable');
  assert.equal(b.state, 'holds');
  assert.equal(proposed(b.note), false);
  assert.equal(b.note.source.ref, 'src/billing/README.md');
  assert.equal(pendingBehaviors(store).length, 0);
  const [a] = activeBehaviors(store);
  assert.equal(a.origin, 'design document src/billing/README.md');
  assert.equal(a.quote, charge.quote);
  assert.match(docBehaviorsLine(r), /^1 behavior from 2 design documents; 2 left out/);
});

test('a document is read once per content, and a discarded behavior does not come back', async t => {
  const { repo, store } = fixture(t);
  let calls = 0;
  const completeFn = async ({ prompt }) => { calls++; return { json: { behaviors: prompt.includes('DOCUMENT src/billing/README.md') ? [charge] : [] } }; };
  const first = await deriveDocBehaviors(store, { completeFn });
  assert.equal(calls, 1); // the design file names no code, so there is nothing to ask about it
  assert.ok(!discardPending(store, first.saved[0].id).error);
  const second = await deriveDocBehaviors(store, { completeFn });
  assert.equal(calls, 1);
  assert.deepEqual(second.docs, []);
  assert.match(docBehaviorsLine(second), /all read already/);
  assert.equal(listBehaviors(store).length, 0);
  fs.appendFileSync(path.join(repo, 'src/billing/README.md'), '\nA new paragraph.\n');
  // the document changed and is read again: what a person discarded stays out
  const third = await deriveDocBehaviors(store, { completeFn });
  assert.deepEqual(third.docs, ['src/billing/README.md']);
  assert.equal(calls, 2);
  assert.equal(third.saved.length, 0);
  assert.equal(third.rejected[0].reason, 'discarded by a person');
  assert.equal(listBehaviors(store).length, 0);
});

const refund = { title: 'A refund is written to the ledger before the provider is called',
  body: 'src/billing/ledger.js:recordRefund records the refund first.',
  quote: 'Refunds are always written to the ledger before the provider is called.', answers: ['when is a refund recorded'],
  deps: [{ path: 'src/billing/ledger.js', symbol: 'recordRefund' }] };

test('a changed document is followed: an edited behavior keeps its link, a reworded rule its new sentence, a dropped rule is marked', async t => {
  const { repo, store } = fixture(t);
  const doc = path.join(repo, 'src/billing/README.md');
  const first = await deriveDocBehaviors(store, { completeFn: async ({ prompt }) => ({ json: { behaviors: prompt.includes('DOCUMENT src/billing/README.md') ? [charge, refund] : [] } }) });
  const [chargeId, refundId] = first.saved.map(b => b.id);

  // a person rewrites one: it is theirs, still tied to the document, and not read in a second time
  assert.ok(!editBehavior(store, chargeId, { title: 'Charges need an idempotency key' }).error);
  let a = activeBehaviors(store).find(b => b.id === chargeId);
  assert.equal(a.origin, 'design document src/billing/README.md, edited by a person');
  assert.equal(a.quote, charge.quote);

  // the document rewords the refund rule and keeps the charge rule
  fs.writeFileSync(doc, README.replace('Refunds are always\nwritten to the ledger before the provider is called.', 'Every refund reaches the ledger first; only then is the provider called.'));
  assert.doesNotMatch(fs.readFileSync(doc, 'utf8'), /Refunds are always/);
  let asked = '';
  const second = await deriveDocBehaviors(store, { completeFn: async ({ prompt }) => { asked = prompt; return { tokens: { totalTokens: 120 }, json: {
    kept: [{ id: refundId, quote: 'Every refund reaches the ledger first; only then is the provider called.' }], behaviors: [charge] } }; } });
  assert.match(asked, new RegExp(`REWORDED[^]*${refundId}: `));
  assert.doesNotMatch(asked.split('DOCUMENT ')[0].split('REWORDED')[1], new RegExp(chargeId), 'a sentence still in the document is not asked about');
  assert.equal(second.saved.length, 0, 'the edited behavior is not saved again under its old title');
  assert.equal(second.rejected[0].reason, 'already a behavior');
  assert.deepEqual(second.reworded.map(b => b.id), [refundId]);
  assert.equal(second.tokens, 120);
  assert.equal(activeBehaviors(store).find(b => b.id === refundId).quote, 'Every refund reaches the ledger first; only then is the provider called.');
  assert.equal(listBehaviors(store).length, 2);

  // the document drops the refund rule: the behavior stays in force, marked, for the person to decide
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace(' Every refund reaches the ledger first; only then is the provider called.', ''));
  fs.appendFileSync(doc, '\n' + 'The rest of this page is background on how the folder came to be. '.repeat(4) + '\n');
  const third = await deriveDocBehaviors(store, { completeFn: async () => ({ json: { kept: [{ id: refundId, quote: 'a sentence that is not in the document' }], behaviors: [] } }) });
  assert.deepEqual(third.unstated.map(b => b.id), [refundId]);
  assert.match(docBehaviorsLine(third), /1 no longer stated by its document/);
  a = activeBehaviors(store).find(b => b.id === refundId);
  assert.equal(a.unstated, true);
  assert.equal(listBehaviors(store).length, 2);

  // the document is deleted: the rest of its behaviors are marked without a model call
  fs.rmSync(doc);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const fourth = await deriveDocBehaviors(store, { completeFn: async () => { throw new Error('called'); } });
  assert.deepEqual(fourth.unstated.map(b => b.id), [chargeId]);
  assert.equal(listBehaviors(store).length, 2);
});

test('maintenance reads new and changed design documents and says so once', async t => {
  const { store, repo } = fixture(t);
  const limits = [];
  const r = await maintain(store, repo, { fns: { spentToday: () => 0, verify: async () => ({}), phrase: async () => ({ done: [] }),
    docs: async ({ limit }) => { limits.push(limit); return { saved: [{ id: 'a' }, { id: 'b' }], unstated: [{ id: 'c' }], tokens: 300 }; } } });
  assert.deepEqual(limits, [3]);
  assert.equal(r.docs, 2); assert.equal(r.unstated, 1); assert.equal(r.tokens, 300);
  const notice = maintenanceNotice(store);
  assert.match(notice, /2 behaviors from design documents; see thinker system/);
  assert.match(notice, /1 behavior no longer stated by a design document; keep or discard in thinker ui/);
  assert.equal(maintenanceNotice(store), '');
});

test('--dry lists the documents without a model call, and a failed document is tried again', async t => {
  const { store } = fixture(t);
  const dry = await deriveDocBehaviors(store, { dry: true, limit: 1, completeFn: async () => { throw new Error('called'); } });
  assert.deepEqual(dry.docs, ['docs/design-payments.md']);
  assert.equal(dry.remaining, 1);
  const failed = await deriveDocBehaviors(store, { completeFn: async () => { throw new Error('over the cap') } });
  assert.equal(failed.failed, 1);
  assert.match(docBehaviorsLine(failed), /1 not read \(over the cap\)/);
  const r = await deriveDocBehaviors(store, { completeFn: async () => ({ json: { behaviors: [] } }) });
  assert.deepEqual(r.docs, ['src/billing/README.md']);
  assert.equal(r.read, 1);
});
