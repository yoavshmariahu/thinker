// The policy for a request that never reached the upstream (src/proxy-retry.js), and the two numbers
// that set it: 487 of this machine's 650 real proxy errors in the 12 days to 2026-11-05 were a name
// that did not resolve, and the single 250 ms retry they used to get recovered 1 of 110.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryPlan, retryable, addressBook, cachingLookup, RETRY_WAITS, KNOWN_FOR } from '../src/proxy-retry.js';

const err = (code, message = 'nope') => Object.assign(new Error(message), { code });

test('a dead resolver gets the ladder, not one rung', () => {
  const waits = [];
  for (let attempt = 0; ; attempt++) {
    const p = retryPlan(err('ENOTFOUND'), attempt);
    if (!p.retry) break;
    waits.push(p.waitMs);
    assert.ok(attempt < 20, 'the ladder must end');
  }
  assert.deepEqual(waits, RETRY_WAITS, 'every rung is tried once');
  assert.equal(waits.reduce((a, b) => a + b, 0), 7750, 'about eight seconds of holding in all');
  assert.equal(retryPlan(err('EAI_AGAIN'), 0).waitMs, RETRY_WAITS[0], 'a resolver that is still coming up is the same case');
});

test('with an address already known the first try again skips the wait', () => {
  const p = retryPlan(err('ENOTFOUND'), 0, { address: true });
  assert.deepEqual(p, { retry: true, waitMs: 0, address: true }, 'the resolver is not consulted, so there is nothing to wait for');
  assert.equal(retryPlan(err('ENOTFOUND'), 1, { address: true }).waitMs, RETRY_WAITS[1], 'later rungs keep their wait');
});

test('a dropped connection keeps its one fresh-socket retry', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH']) {
    assert.deepEqual(retryPlan(err(code), 0), { retry: true, waitMs: 0, address: false }, code);
    assert.equal(retryPlan(err(code), 1).retry, false, `${code} is not laddered: a second drop is the agent's to see`);
  }
});

test('a TLS record that did not authenticate is retried on a socket of its own', () => {
  // Node builds the code from OpenSSL's own string. 106 rows in 12 days, 82 on a reused keep-alive
  // socket, none retried, every one a 502 the agent had to recover from.
  const code = 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC';
  assert.equal(retryable(err(code)), true);
  assert.equal(retryPlan(err(code), 0).retry, true);
  assert.equal(retryPlan(err(code), 1).retry, false);
});

test('an error of the upstream\'s own is not retried', () => {
  for (const code of ['ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', undefined]) {
    assert.equal(retryable(err(code)), false, String(code));
    assert.equal(retryPlan(err(code), 0).retry, false, String(code));
  }
});

test('the address book keeps what the resolver last answered, and forgets it in time', () => {
  let now = 1_000_000;
  const book = addressBook({ now: () => now });
  assert.equal(book.get('api.anthropic.com'), null, 'nothing is assumed');
  book.note('api.anthropic.com', '160.79.104.10', 4);
  assert.equal(book.get('api.anthropic.com').address, '160.79.104.10');
  assert.equal(book.has('api.anthropic.com'), true);
  now += KNOWN_FOR - 1;
  assert.equal(book.has('api.anthropic.com'), true, 'still worth a try within the window');
  now += 2;
  assert.equal(book.get('api.anthropic.com'), null, 'an endpoint that moved is not chased for ever');
  assert.equal(book.size, 0, 'and the stale entry goes');
  book.note('', '1.2.3.4');
  book.note('h', null);
  assert.equal(book.size, 0, 'nothing half-known is kept');
});

test('the lookup records what worked and answers from the book when the resolver will not', async () => {
  const book = addressBook();
  const fallbacks = [];
  let up = true;
  const resolver = (host, options, cb) => (up ? cb(null, '160.79.104.10', 4) : cb(err('ENOTFOUND', 'getaddrinfo ENOTFOUND')));
  const lookup = cachingLookup(book, { lookup: resolver, onFallback: (h, k) => fallbacks.push([h, k.address]) });
  const ask = () => new Promise(r => lookup('api.anthropic.com', {}, (e, address, family) => r({ e, address, family })));

  const good = await ask();
  assert.equal(good.address, '160.79.104.10');
  assert.equal(fallbacks.length, 0, 'a working resolver is never second-guessed');

  up = false;
  const blind = await ask();
  assert.equal(blind.e, null, 'the request goes on');
  assert.equal(blind.address, '160.79.104.10', 'to where the host answered last');
  assert.equal(blind.family, 4);
  assert.deepEqual(fallbacks, [['api.anthropic.com', '160.79.104.10']], 'and it is on the record');
});

test('with nothing in the book the resolver\'s refusal is passed through', async () => {
  const book = addressBook();
  const lookup = cachingLookup(book, { lookup: (h, o, cb) => cb(err('EAI_AGAIN')) });
  const { e } = await new Promise(r => lookup('api.anthropic.com', {}, e2 => r({ e: e2 })));
  assert.equal(e.code, 'EAI_AGAIN', 'the proxy invents no address');
});

test('the lookup keeps node\'s all: true shape', async () => {
  const book = addressBook();
  let up = true;
  const lookup = cachingLookup(book, { lookup: (h, o, cb) => (up ? cb(null, [{ address: '::1', family: 6 }, { address: '1.2.3.4', family: 4 }]) : cb(err('ENOTFOUND'))) });
  const ask = () => new Promise(r => lookup('h', { all: true }, (e, addresses) => r({ e, addresses })));
  const good = await ask();
  assert.deepEqual(good.addresses.length, 2, 'every address the resolver gave is passed on');
  up = false;
  const blind = await ask();
  assert.deepEqual(blind.addresses, [{ address: '::1', family: 6 }], 'the first of them is what was kept');
});
