// What the proxy does when a request never reached the upstream at all.
//
// Measured on this machine's own proxy log, the 12 days to 2026-11-05 (20,749 rows, 968 sessions,
// 830 error rows): 174 of those rows are the person pressing Esc, and of the 650 that are real
// failures, **487 are a name that did not resolve** -- three quarters of everything that goes wrong
// here. The rest: 106 a TLS record that did not authenticate (82 of them on a reused keep-alive
// socket), 23 a reset that was not a cancellation, 34 everything else.
//
// The policy this replaces retried a failed lookup once, 250 ms later. Since retries began on
// 2026-10-29 it ran **110 times and recovered once**: every row with `retried: true` is followed by
// its own failure row. `afterMs` on those is a median of 4, so nothing is timing out -- the resolver
// answers "no" at once, and 250 ms later it answers "no" again. The outages are longer than that: 46
// of 58 bursts hold their errors inside 5 seconds, and 6 long ones (1-6 minutes) hold 173 errors
// between them.
//
// So two things, and they cover different halves of the problem:
//
//   1. **The address the host last answered on** (`addressBook`, `cachingLookup`). A resolver that
//      says nothing while the network is up is what a laptop wake, a VPN change or a DNS blip looks
//      like, and the connection would work if anyone remembered where to point it. The lookup is
//      recorded on the way past when it succeeds -- never a lookup of our own, never on the hot path
//      -- and consulted only after the resolver has already refused. If the address is stale the
//      connect fails and the request is exactly where it was before.
//   2. **A ladder instead of one rung** (`retryPlan`, `RETRY_WAITS`). For a cold process with no
//      address yet, 0.25s, 0.5s, 1s, 2s, 4s: about 8 seconds of holding, abandoned the moment the
//      agent walks away. Nothing has reached the agent while this runs, so it cannot see it -- and
//      the agent's own retry of the 502 this saves costs it 10 to 40 seconds anyway. Past the ladder
//      the request fails honestly: a six-minute outage is not ours to paper over.
//
// A fresh connection is also the whole remedy for the reused-socket class, which is why the TLS
// record failure joins the retryable codes rather than getting a mechanism of its own: attempt 1
// already opens a socket of its own (`proxy.js:getAgent`).
import dns from 'node:dns';

// Codes worth another try when nothing of the answer has reached the agent: a dropped connection (a
// reused keep-alive socket the API had already closed), a connect timeout, a host with no route, and
// a name that did not resolve.
export const RETRY_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'];
// The resolver's own refusals, which are the ones the ladder and the address book are for.
export const DNS_CODES = ['ENOTFOUND', 'EAI_AGAIN'];
// A TLS record that did not authenticate. On a reused socket this is the far end having finished with
// it while it sat in the pool, so the first record of the next request reads as corrupt: 106 rows in
// 12 days, 82 of them reused, none retried, every one a 502 the agent had to recover from on its own.
// Matched on the code's text because Node builds it from OpenSSL's own string
// (`ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`), which is not a stable identifier to compare against.
export const RETRY_TLS = /BAD_RECORD_MAC|DECRYPTION_FAILED|WRONG_VERSION_NUMBER|UNEXPECTED_EOF/i;
export const retryable = e => RETRY_CODES.includes(e?.code) || RETRY_TLS.test(String(e?.code || ''));
// The ladder, in milliseconds. Covers the brief flaps; past it the failure is the agent's to see.
export const RETRY_WAITS = [250, 500, 1000, 2000, 4000];

// Whether to try again, and how long to wait first. `address` says an address for this host is
// already known, in which case the first try again skips the resolver entirely and waits for nothing.
// Anything that is not the resolver's doing gets the one fresh-socket retry it got before.
export function retryPlan(e, attempt, { address = false, waits = RETRY_WAITS } = {}) {
  if (!retryable(e)) return { retry: false };
  if (!DNS_CODES.includes(e?.code)) return attempt === 0 ? { retry: true, waitMs: 0, address: false } : { retry: false };
  if (attempt >= waits.length) return { retry: false };
  return { retry: true, waitMs: address && attempt === 0 ? 0 : waits[attempt], address };
}

// How long an address is worth trying after the host last answered on it. Six hours: long enough to
// cover a working day's sleeps and network changes, short enough that an endpoint that genuinely
// moved is not chased for ever. A stale one costs a failed connect, which is where we already were.
export const KNOWN_FOR = 6 * 3600e3;

export function addressBook({ now = Date.now } = {}) {
  const known = new Map();
  return {
    note(host, address, family) {
      if (!host || !address) return;
      known.set(host, { address, family: family || undefined, at: now() });
    },
    get(host) {
      const k = known.get(host);
      if (!k) return null;
      if (now() - k.at >= KNOWN_FOR) { known.delete(host); return null; }
      return k;
    },
    has(host) { return !!this.get(host); },
    get size() { return known.size; },
  };
}

// A `lookup` for http.request's options: it records what the resolver answered, and answers from the
// book when the resolver will not. Node hands this straight to net.connect / tls.connect, so the
// request keeps its own hostname for SNI and its `Host` header either way -- only the address the
// socket is opened to comes from here.
export function cachingLookup(book, { lookup = dns.lookup, onFallback = null } = {}) {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (!err) {
        const first = options?.all ? address?.[0] : { address, family };
        if (first?.address) book.note(hostname, first.address, first.family);
        return callback(err, address, family);
      }
      const known = book.get(hostname);
      if (!known) return callback(err, address, family);
      try { onFallback?.(hostname, known, err); } catch { /* a record is never worth a failed request */ }
      return options?.all
        ? callback(null, [{ address: known.address, family: known.family || (known.address.includes(':') ? 6 : 4) }])
        : callback(null, known.address, known.family || (known.address.includes(':') ? 6 : 4));
    });
  };
}
