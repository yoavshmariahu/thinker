// Error reports (src/error-report.js): the scrubbing, the record, the one question, and the send.
//
// The scrubbing tests are the point of this file. A report leaves the person's machine, so the thing
// to prove is what it cannot carry: their name (every absolute path under a home holds it), their
// repository's name, a URL, or a credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import {
  scrub, errorRecord, recordError, readErrors, errorsFile, stateFile, errorConsent, errorOfferDue,
  errorOffer, answerErrorOffer, errorOfferPending, sendErrors, errorsEndpoint, errorsReport, ERRORS,
} from '../src/error-report.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-errors-'));
// recordError and the question are quiet in test mode by default, as the hooks are
// and the endpoint is an isolated one, never the production URL, even behind a mocked fetch
const ENDPOINT = 'https://example.test/metrics';
// The switches this file's subject reads, every one of them, set to what the test means and put back
// after. A machine that keeps its own telemetry off (THINKER_TELEMETRY=off, which `isTelemetryEnabled`
// honours) failed three of these for a configuration of the developer's machine, not a fault in the
// code; and THINKER_TEST is set here rather than taken from the runner, so `node --test` on this file
// alone says the same as `npm test`.
const SWITCHES = {
  THINKER_TEST: '1', THINKER_ERRORS_TEST: '1', THINKER_TELEMETRY_URL: ENDPOINT,
  THINKER_TELEMETRY: undefined, THINKER_NO_TELEMETRY: undefined, THINKER_NO_LEARN: undefined,
};
const settled = (fn, over = {}) => {
  const was = {};
  for (const [k, v] of Object.entries({ ...SWITCHES, ...over })) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(x => { restore(); return x; }, e => { restore(); throw e; });
    restore(); return r;
  } catch (e) { restore(); throw e; }
};
const live = fn => settled(fn);
const liveAsync = fn => settled(fn);
// telemetry has to be on for the question to be due: the one switch covers both
const telemetryOn = h => {
  fs.mkdirSync(path.join(h, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h, 'install.json'), JSON.stringify({ telemetry: true }));
  fs.writeFileSync(path.join(h, 'state', 'install-id'), 'install-abc\n'); // telemetry.js:getInstallId
};

test('a report carries the failure and nothing about the machine it happened on', () => {
  const opts = { home: '/Users/jane', install: '/Users/jane/.thinker/app', repo: '/Users/jane/src/acme-secrets' };
  // the person's name is in every path under their home, and their repository names their employer's product
  assert.equal(scrub("ENOENT: open '/Users/jane/src/acme-secrets/notes.json'", opts), "ENOENT: open '<repo>/notes.json'");
  assert.equal(scrub('at ensureProxy (/Users/jane/.thinker/app/src/proxy-service.js:412:9)', opts), 'at ensureProxy (<thinker>/src/proxy-service.js:412:9)');
  assert.doesNotMatch(scrub('/Users/jane/Documents/Taxes/2026.pdf', opts), /jane/);
  // a credential, however it is spelled, and any URL at all
  for (const secret of ['sk-ant-api03-abcdefgh12345', 'ghp_abcdefghijkl', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'xoxb-12345678-abcdef'])
    assert.equal(scrub(`token ${secret} refused`, opts), 'token <token> refused');
  assert.equal(scrub('POST https://gw.corp.internal/v1/messages failed', opts), 'POST <url> failed');
  // a path that belongs to nobody we know of still loses everything but the file
  assert.equal(scrub('cannot read /opt/corp/secret-project/config/db.yml', opts), 'cannot read …/config/db.yml');
  // and what is left is readable: thinker's own file and line, which is the whole value of the report
  assert.match(scrub('at wrappedCommand (/Users/jane/.thinker/app/src/testing.js:491:9)', opts), /<thinker>\/src\/testing\.js:491/);
});

test('a record keeps the operation, the error and the first frames', () => {
  const err = Object.assign(new Error('boom at /Users/jane/x/y/z'), { code: 'ERR_BOOM' });
  err.stack = ['Error: boom', ...Array.from({ length: 30 }, (_, i) => `    at f${i} (/Users/jane/.thinker/app/src/a.js:${i}:1)`)].join('\n');
  const r = errorRecord('hook.prompt', err, { repo: '/Users/jane/x', home: '/Users/jane', now: Date.parse('2026-10-29T10:00:00Z') });
  assert.equal(r.op, 'hook.prompt');
  assert.equal(r.name, 'Error');
  assert.equal(r.code, 'ERR_BOOM');
  assert.equal(r.platform, process.platform);
  assert.equal(r.frames.length, ERRORS.frames, 'the stack is cut to its first frames');
  assert.doesNotMatch(JSON.stringify(r), /jane/, 'nothing in the record names the person');
  // a thrown string, or something that is not an error at all, still records
  assert.equal(errorRecord('x', 'just a string').message, 'just a string');
});

test('the same failure again counts up instead of filling the file', () => live(() => {
  const h = home();
  const err = new Error('same thing');
  for (let i = 0; i < 4; i++) recordError('hook.pre', err, { home: h });
  const rows = readErrors(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seen, 4);
  // a different failure is its own record, and the file is capped
  for (let i = 0; i < ERRORS.keep + 5; i++) recordError(`op.${i}`, new Error(`e${i}`), { home: h });
  assert.equal(readErrors(h).length, ERRORS.keep);
}));

test('recording is silent in test mode, so a benchmark records nothing', () => settled(() => {
  const h = home();
  recordError('hook.pre', new Error('x'), { home: h }); // test mode, and THINKER_ERRORS_TEST not lifting it
  assert.equal(readErrors(h).length, 0);
  assert.equal(fs.existsSync(errorsFile(h)), false);
}, { THINKER_ERRORS_TEST: undefined }));

test('the question is asked once, only where there is something to send, and never without telemetry', () => live(() => {
  const h = home();
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-errrepo-'))).init();
  // nothing has failed: nobody is asked for permission to report nothing
  telemetryOn(h);
  assert.equal(errorOfferDue({ home: h, store }), null);
  recordError('hook.pre', new Error('cannot read x'), { home: h });
  assert.ok(errorOfferDue({ home: h, store }), 'now there is something to send');

  const text = errorOffer(store, { client: 'claude', home: h });
  assert.match(text, /<thinker-error-report>/);
  assert.match(text, /AskUserQuestion tool, not in prose: "Send thinker's error reports to its developers\?" \(header "thinker"\)/, 'put as a question through the agent\'s own tool, labelled as thinker\'s');
  assert.match(text, /hook\.pre/);
  assert.match(text, /thinker errors --list/, 'the person can read what would be sent');
  assert.match(text, /No answer sends nothing/);
  assert.equal(errorOfferPending(h), true);
  assert.equal(errorOffer(store, { client: 'claude', home: h }), '', 'asked once');

  // telemetry off means this question never comes up at all
  const h2 = home();
  fs.mkdirSync(path.join(h2, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h2, 'install.json'), JSON.stringify({ installId: 'i', telemetry: false }));
  recordError('hook.pre', new Error('x'), { home: h2 });
  assert.equal(errorOfferDue({ home: h2, store }), null);
}));

test('no answer sends nothing, and a no is remembered', async () => liveAsync(async () => {
  const h = home();
  telemetryOn(h);
  recordError('cli.update', new Error('x'), { home: h });
  let called = 0;
  // never asked, never answered: a send is refused outright
  assert.deepEqual(await sendErrors({ home: h, fetchFn: () => { called++; } }), { sent: false, reason: 'no consent' });
  assert.equal(called, 0, 'nothing left the machine');

  const said = await answerErrorOffer('no', { home: h });
  assert.match(said, /no error reports are sent/i);
  assert.equal(errorConsent(h), 'no');
  assert.deepEqual(await sendErrors({ home: h, fetchFn: () => { called++; } }), { sent: false, reason: 'no consent' });
  assert.equal(called, 0);

  const never = await answerErrorOffer('never ask again', { home: h });
  assert.match(never, /will not ask again/);
  assert.equal(errorConsent(h), 'never');
}));

test('a yes sends the records once, and marks them sent', async () => liveAsync(async () => {
  const h = home();
  telemetryOn(h);
  recordError('hook.pre', new Error('cannot read properties of undefined'), { home: h });
  recordError('cli.update', new Error('network down'), { home: h });
  const posts = [];
  const fetchFn = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 202 }; };
  const said = await answerErrorOffer('yes', { home: h, sendFn: o => sendErrors({ ...o, home: h, fetchFn }) });
  assert.match(said, /2 reports sent/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, errorsEndpoint(ENDPOINT), 'the metrics endpoint\'s sibling path');
  assert.equal(posts[0].body.installId, 'install-abc');
  assert.equal(posts[0].body.errors.length, 2);
  assert.doesNotMatch(JSON.stringify(posts[0].body), new RegExp(os.homedir().split(path.sep).filter(Boolean)[1] || 'nobody'), 'no part of the home path');

  // the same records are not sent twice
  assert.deepEqual(await sendErrors({ home: h, fetchFn }), { sent: false, reason: 'nothing to send' });
  assert.equal(posts.length, 1);
  // a failure after consent goes with the next send
  recordError('hook.proxy', new Error('later'), { home: h });
  const after = await sendErrors({ home: h, fetchFn });
  assert.equal(after.count, 1);
}));

test('a refused send keeps the records for the next one', async () => liveAsync(async () => {
  const h = home();
  telemetryOn(h);
  recordError('hook.pre', new Error('x'), { home: h });
  fs.writeFileSync(stateFile(h), JSON.stringify({ consent: 'yes' }));
  const bad = await sendErrors({ home: h, fetchFn: async () => ({ ok: false, status: 503 }) });
  assert.equal(bad.sent, false);
  assert.equal(bad.status, 503);
  assert.equal(readErrors(h).filter(r => !r.sent).length, 1, 'still unsent');
  const good = await sendErrors({ home: h, fetchFn: async () => ({ ok: true, status: 202 }) });
  assert.equal(good.count, 1);
}));

test('the list prints the records as they would be sent, and says where consent stands', () => live(() => {
  const h = home();
  telemetryOn(h);
  assert.match(errorsReport({ home: h }), /not decided; nothing has been sent/);
  recordError('hook.pre', new Error('cannot read x'), { home: h });
  const out = errorsReport({ home: h });
  assert.match(out, /1 record, exactly as they would be sent/);
  assert.match(out, /hook\.pre/);
  assert.match(out, /thinker errors --answer yes/);
  fs.writeFileSync(stateFile(h), JSON.stringify({ consent: 'yes' }));
  assert.match(errorsReport({ home: h }), /Error reports: on/);
}));

test('a test run never posts a report to production, whatever the consent says', async () => {
  // THINKER_ERRORS_TEST=1 lets a test write records; it must not also let them leave the machine.
  // The usage report has refused this since it shipped (telemetry.js:isTestTelemetryBlocked) and the
  // sender of these reports did not, so a benchmark with a yes on file would have posted for real.
  const h = home();
  telemetryOn(h);
  return settled(async () => {
    recordError('hook.pre', new Error('x'), { home: h });
    fs.writeFileSync(stateFile(h), JSON.stringify({ consent: 'yes' }));
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, status: 202 }; };
    try {
      assert.deepEqual(await sendErrors({ home: h }), { sent: false, reason: 'test_environment' });
      assert.equal(called, 0, 'nothing left the machine');
      // a loopback endpoint is the isolated one a test is allowed to use
      process.env.THINKER_TELEMETRY_URL = 'http://127.0.0.1:8098/metrics';
      assert.equal((await sendErrors({ home: h })).sent, true);
      assert.equal(called, 1);
    } finally { globalThis.fetch = real; }
  }, { THINKER_TELEMETRY_URL: 'https://metrics.zerotime.dev/metrics' });
});

test('the endpoint is the metrics endpoint\'s sibling', () => {
  assert.equal(errorsEndpoint('https://x.example/metrics'), 'https://x.example/errors');
  assert.equal(errorsEndpoint('https://x.example/stage/metrics'), 'https://x.example/stage/errors');
});
