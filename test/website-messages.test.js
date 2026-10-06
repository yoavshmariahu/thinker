import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeMessage, insertMessage } from '../infra/metrics/messages.mjs';
import { createHandler } from '../infra/metrics/handler.mjs';
const data = { id: '8a7f14b1-e69e-4a8c-830b-cabfb973ab29', message: "Hello ' world <script>alert(1)</script>", email: 'me@example.com', page: '/docs.html' };

test('messages validate and normalize optional email without accepting invalid input', () => {
  assert.deepEqual(normalizeMessage({ ...data, message: ' hello ', email: '' }), { ...data, message: 'hello', email: null });
  for (const payload of [null, [], {}, ...[null, '', '  ', 'x'.repeat(5001), 'x\0y'].map(message => ({ ...data, message })),
    { ...data, id: 'bad' }, { ...data, email: 'bad' }, { ...data, email: 'x'.repeat(255) }, { ...data, page: 'https://external.example' }]) {
    assert.throws(() => normalizeMessage(payload));
  }
});

test('messages are parameterized, idempotent, and never silently overwrite a different submission', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 1 }; } };
  await insertMessage(db, data);
  assert.ok(!calls[0].sql.includes(data.message));
  assert.deepEqual(calls[0].values, [data.id, data.message, data.email, data.page]);
  db.query = async sql => sql.startsWith('INSERT') ? { rowCount: 0 } : { rows: [{ matches: true }] };
  await insertMessage(db, data);
  db.query = async sql => sql.startsWith('INSERT') ? { rowCount: 0 } : { rows: [{ matches: false }] };
  await assert.rejects(insertMessage(db, data), { code: 'MESSAGE_CONFLICT' });
});

test('message HTTP route only acknowledges persistence and does not write telemetry', async () => {
  let received;
  const handler = createHandler(() => assert.fail('message entered telemetry'), async message => { received = message; });
  const event = body => ({ rawPath: '/messages', body: JSON.stringify(body), requestContext: { http: { method: 'POST' } } });
  assert.equal((await handler(event(data))).statusCode, 202);
  assert.deepEqual(received, data);
  assert.equal((await handler(event({ ...data, message: '' }))).statusCode, 422);
  const failure = createHandler(() => assert.fail(), async () => { throw new Error('DB unavailable'); });
  assert.equal((await failure(event(data))).statusCode, 500);
  const collision = createHandler(() => assert.fail(), async () => { throw Object.assign(new Error(), { code: 'MESSAGE_CONFLICT' }); });
  assert.equal((await collision(event(data))).statusCode, 409);
});

function widget(fetch) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, { value: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; }, focus() {},
      reset() { element('textarea').value = ''; element('input').value = ''; } });
    return elements.get(key);
  }
  let counter = 0;
  const context = vm.createContext({ document: { createElement: () => ({ querySelector: element }), body: { append() {} } },
    location: { pathname: '/' }, crypto: { randomUUID: () => `id-${++counter}` }, fetch,
    AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(new URL('../site/message.js', import.meta.url), 'utf8'), context);
  return { element, submit: () => element('form').events.submit({ preventDefault() {} }) };
}

test('message form preserves text on failure, reuses the retry ID, and clears only after acceptance', async () => {
  const requests = [];
  let ok = false;
  const page = widget(async (url, options) => { requests.push(JSON.parse(options.body)); return { ok }; });
  page.element('textarea').value = 'My feedback';
  await page.submit();
  assert.equal(page.element('textarea').value, 'My feedback');
  assert.match(page.element('.message-status').textContent, /try again/);
  ok = true;
  await page.submit();
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(page.element('textarea').value, '');
  assert.match(page.element('.message-status').textContent, /has been sent/);
  page.element('textarea').value = 'Second message';
  await page.submit();
  assert.notEqual(requests[1].id, requests[2].id);
});

test('pending message submission cannot be sent twice', async () => {
  let finish, calls = 0;
  const page = widget(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  page.element('textarea').value = 'Hello';
  const request = page.submit();
  await page.submit();
  assert.equal(calls, 1);
  assert.equal(page.element('.message-send').disabled, true);
  finish({ ok: true }); await request;
  assert.equal(page.element('.message-send').disabled, false);
});
