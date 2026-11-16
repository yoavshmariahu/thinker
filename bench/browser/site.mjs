#!/usr/bin/env node
// A site for browser-agent tasks: a kitchenware store with an order back office, served from this process.
//
// Why a site of our own. A task on the live web changes under the bench (prices, layouts, a cookie wall),
// so two arms run an hour apart are not doing the same task, and an agent that submits a form there has
// done something to somebody. Here the catalogue is generated from a fixed seed, so every session of every
// arm sees the same pages; every session has its own state (`/s/<namespace>/...`, the bench passes its
// session id), so one session's basket is never another's; and the site itself knows the right answer to
// every task (`/__check/<task>`), so grading needs no judge.
//
// The pages are as heavy as a real store's on purpose -- a navigation bar of every category, a filter
// sidebar, a footer of links -- because what is measured is what a page snapshot costs to carry.
//
//   node bench/browser/site.mjs <port>            serve
//   node bench/browser/site.mjs --answers         print each task's expected answer (for writing tasks)
import http from 'node:http';

// ---- the catalogue, from a seed ----
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(20261115);
const pick = a => a[Math.floor(R() * a.length)];
const between = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));

const CATEGORIES = [
  { slug: 'kettles', name: 'Kettles', specs: [['Capacity (l)', () => (between(8, 20) / 10).toFixed(1)], ['Power (W)', () => between(15, 30) * 100], ['Variable temperature', () => pick(['Yes', 'No'])]] },
  { slug: 'toasters', name: 'Toasters', specs: [['Slots', () => pick([2, 2, 4])], ['Power (W)', () => between(8, 18) * 100], ['Bagel setting', () => pick(['Yes', 'No'])]] },
  { slug: 'blenders', name: 'Blenders', specs: [['Jug capacity (l)', () => (between(10, 22) / 10).toFixed(1)], ['Motor (W)', () => between(4, 16) * 100], ['Dishwasher safe', () => pick(['Yes', 'No'])]] },
  { slug: 'stand-mixers', name: 'Stand mixers', specs: [['Bowl capacity (l)', () => (between(35, 70) / 10).toFixed(1)], ['Motor (W)', () => between(30, 150) * 10], ['Attachments', () => between(3, 9)]] },
  { slug: 'coffee-grinders', name: 'Coffee grinders', specs: [['Burr type', () => pick(['Conical', 'Flat', 'Blade'])], ['Grind settings', () => between(8, 60)], ['Hopper (g)', () => between(10, 45) * 10]] },
  { slug: 'air-fryers', name: 'Air fryers', specs: [['Basket (l)', () => (between(20, 90) / 10).toFixed(1)], ['Power (W)', () => between(10, 24) * 100], ['Dishwasher safe', () => pick(['Yes', 'No'])]] },
  { slug: 'rice-cookers', name: 'Rice cookers', specs: [['Cups', () => between(3, 12)], ['Keep warm (h)', () => pick([6, 12, 24])], ['Induction', () => pick(['Yes', 'No'])]] },
  { slug: 'scales', name: 'Kitchen scales', specs: [['Max load (kg)', () => pick([3, 5, 10, 15])], ['Resolution (g)', () => pick([0.1, 1, 1, 2])], ['Rechargeable', () => pick(['Yes', 'No'])]] },
];
const BRANDS = ['Aldermoor', 'Brightwell', 'Calder', 'Dunmore', 'Eastlake', 'Fennick', 'Garrow', 'Hartley', 'Ingram', 'Juniper', 'Kestrel', 'Lindqvist', 'Marlow', 'Northgate', 'Orrin', 'Pemberton'];
const LINES = ['Classic', 'Pro', 'Compact', 'Studio', 'Heritage', 'Pro Max', 'Everyday', 'Signature', 'Lite', 'Select'];
const COLOURS = ['Slate', 'Cream', 'Copper', 'Sage', 'Black', 'Steel', 'Ivory', 'Navy'];
const REVIEWERS = ['A. Novak', 'B. Castellano', 'C. Ibarra', 'D. Whitlock', 'E. Sorensen', 'F. Adeyemi', 'G. Marchetti', 'H. Lindgren', 'I. Petrov', 'J. Tanaka', 'K. Oyelaran', 'L. Brandt'];
const PRAISE = ['Does exactly what it says.', 'Sturdy and well made.', 'Looks great on the counter.', 'Heats up quickly.', 'Easy to clean.', 'Good value for the price.', 'Bought a second one as a gift.', 'The controls are simple.'];
const GRIPES = ['A little noisy at full power.', 'The cord is too short.', 'Noisy, but it works.', 'The lid feels flimsy.', 'Instructions were unclear.', 'Takes up more room than expected.', 'Stopped working after a month.', 'The finish marks easily.'];
const PER_CATEGORY = 54, PAGE = 18;

const products = [];
for (const c of CATEGORIES) {
  for (let n = 0; n < PER_CATEGORY; n++) {
    const brand = pick(BRANDS), line = pick(LINES), colour = pick(COLOURS);
    const id = `${c.slug.slice(0, 3)}-${String(n + 1).padStart(3, '0')}`;
    const reviews = Array.from({ length: between(4, 9) }, () => ({ who: pick(REVIEWERS), stars: between(1, 5), text: `${pick(R() < 0.62 ? PRAISE : GRIPES)} ${pick(R() < 0.7 ? PRAISE : GRIPES)}` }));
    products.push({
      id, category: c.slug, brand, name: `${brand} ${line} ${c.name.replace(/s$/, '')} ${100 + (products.length * 7) % 900}`, colour,
      price: between(1900, 34900) / 100, rating: between(28, 50) / 10, stock: R() < 0.22 ? 0 : between(1, 40),
      specs: [...c.specs.map(([k, f]) => [k, String(f())]), ['Colour', colour], ['Warranty (years)', String(pick([1, 2, 2, 3, 5]))], ['Weight (kg)', (between(8, 90) / 10).toFixed(1)], ['Model code', `${brand.slice(0, 3).toUpperCase()}-${between(1000, 9999)}`]],
      reviews, blurb: `The ${line} range from ${brand}: ${pick(['built for daily use', 'designed in small batches', 'our most popular finish', 'a quieter motor than before', 'now with a longer warranty'])}.`,
    });
  }
}
const byId = new Map(products.map(p => [p.id, p]));
const inCategory = (slug, sort = 'featured') => {
  const list = products.filter(p => p.category === slug);
  if (sort === 'price-asc') list.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  if (sort === 'price-desc') list.sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));
  if (sort === 'rating') list.sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
  return list;
};

const CUSTOMERS = ['M. Okafor', 'R. Lindqvist', 'S. Haddad', 'T. Varga', 'U. Mbeki', 'V. Castellanos', 'W. Achterberg', 'X. Fontaine', 'Y. Nakamura', 'Z. Abramson', 'P. Okafor', 'M. Okonkwo'];
const STATUSES = ['delivered', 'delivered', 'delivered', 'shipped', 'processing', 'cancelled', 'refunded'];
const ORDERS_PAGE = 25;
const baseOrders = Array.from({ length: 150 }, (_, n) => {
  const lines = Array.from({ length: between(1, 4) }, () => { const p = pick(products); return { id: p.id, qty: between(1, 3), price: p.price }; });
  return { number: `LR-${40001 + n}`, customer: pick(CUSTOMERS), status: pick(STATUSES), placed: `2026-${String(between(6, 10)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
    lines, total: Math.round(lines.reduce((t, l) => t + l.qty * l.price, 0) * 100) / 100, note: '' };
});
const PROMO = { code: 'COPPER15', percent: 15 };
const SHIPPING = { standard: 4.95, express: 12.5, pickup: 0 };

// ---- per-session state ----
const spaces = new Map();
function space(ns) {
  if (!spaces.has(ns)) spaces.set(ns, { cart: [], promo: null, placed: [], orders: structuredClone(baseOrders), log: [] });
  return spaces.get(ns);
}

// ---- the tasks' answers, known to the site ----
const money = n => `$${n.toFixed(2)}`;
const TRUTH = {
  // three cheapest in-stock kettles rated 4.0 or more
  'cheapest-kettles': () => inCategory('kettles', 'price-asc').filter(p => p.stock > 0 && p.rating >= 4).slice(0, 3),
  // out-of-stock toasters and blenders over $150
  'restock-report': () => products.filter(p => (p.category === 'toasters' || p.category === 'blenders') && p.stock === 0 && p.price > 150),
  // of the eight cheapest stand mixers, the highest motor watts per litre of bowl
  'mixer-ratio': () => {
    const pros = inCategory('stand-mixers', 'price-asc').slice(0, 8);
    const ratio = p => Number(p.specs.find(s => s[0] === 'Motor (W)')[1]) / Number(p.specs.find(s => s[0] === 'Bowl capacity (l)')[1]);
    return { pros, best: [...pros].sort((a, b) => ratio(b) - ratio(a))[0] };
  },
  // reviews mentioning "noisy" over the eight cheapest coffee grinders
  'noisy-grinders': () => {
    const eight = inCategory('coffee-grinders', 'price-asc').slice(0, 8);
    return { eight, count: eight.reduce((n, p) => n + p.reviews.filter(r => /noisy/i.test(r.text)).length, 0) };
  },
  // delivered orders of M. Okafor over $300: each to be refunded with the note audit-7
  'refund-audit': () => baseOrders.filter(o => o.customer === 'M. Okafor' && o.status === 'delivered' && o.total > 300),
  // the basket: two of the cheapest in-stock air fryer that is dishwasher safe, one of the dearest in-stock scale
  'basket-order': () => {
    const fryer = inCategory('air-fryers', 'price-asc').find(p => p.stock > 0 && p.specs.some(s => s[0] === 'Dishwasher safe' && s[1] === 'Yes'));
    const scale = inCategory('scales', 'price-desc').find(p => p.stock > 0);
    return { fryer, scale };
  },
  // the long one: the five cheapest of every category (forty product pages), their warranty and weight
  'catalogue-audit': () => {
    const spec = (p, k) => Number(p.specs.find(s => s[0] === k)[1]);
    const forty = CATEGORIES.flatMap(c => inCategory(c.slug, 'price-asc').slice(0, 5));
    const byWeight = [...forty].sort((a, b) => spec(b, 'Weight (kg)') - spec(a, 'Weight (kg)'));
    return { forty, long: forty.filter(p => spec(p, 'Warranty (years)') >= 3).length, heaviest: byWeight[0], tie: spec(byWeight[0], 'Weight (kg)') === spec(byWeight[1], 'Weight (kg)') };
  },
  // the one that cannot be searched for: every review of the same forty products, the low-starred ones counted
  'review-audit': () => {
    const forty = CATEGORIES.flatMap(c => inCategory(c.slug, 'price-asc').slice(0, 5));
    return { forty, reviews: forty.reduce((n, p) => n + p.reviews.length, 0), low: forty.reduce((n, p) => n + p.reviews.filter(r => r.stars <= 2).length, 0) };
  },
};
const CHECKS = {
  'cheapest-kettles': answer => { const want = TRUTH['cheapest-kettles'](); const miss = want.filter(p => !answer.includes(p.name)); return miss.length ? `fail: missing ${miss.map(p => p.name).join('; ')}` : 'pass'; },
  'restock-report': answer => {
    const want = TRUTH['restock-report'](), wrong = products.filter(p => (p.category === 'toasters' || p.category === 'blenders') && !want.includes(p) && answer.includes(p.name));
    const miss = want.filter(p => !answer.includes(p.name));
    return miss.length || wrong.length ? `fail: ${miss.length} missing, ${wrong.length} wrongly listed (of ${want.length})` : 'pass';
  },
  'mixer-ratio': answer => { const { pros, best } = TRUTH['mixer-ratio'](); const others = pros.filter(p => p !== best && answer.includes(p.name)); return answer.includes(best.name) && !others.length ? 'pass' : `fail: expected only ${best.name}`; },
  'noisy-grinders': answer => { const { count } = TRUTH['noisy-grinders'](); const said = (answer.match(/ANSWER:\s*(\d+)/i) || [])[1]; return Number(said) === count ? 'pass' : `fail: said ${said ?? 'nothing'}, expected ${count}`; },
  'refund-audit': (answer, st) => {
    const want = new Set(TRUTH['refund-audit']().map(o => o.number));
    const changed = st.orders.filter((o, n) => o.status !== baseOrders[n].status || o.note !== baseOrders[n].note);
    const right = changed.filter(o => want.has(o.number) && o.status === 'refunded' && o.note.trim() === 'audit-7');
    const stray = changed.length - right.length;
    return right.length === want.size && !stray ? 'pass' : `fail: ${right.length} of ${want.size} refunded with the note, ${stray} other orders changed`;
  },
  'catalogue-audit': answer => {
    const { forty, long, heaviest } = TRUTH['catalogue-audit'](), said = (answer.match(/ANSWER:\s*(\d+)/i) || [])[1];
    const others = forty.filter(p => p !== heaviest && answer.includes(p.name)), faults = [];
    if (Number(said) !== long) faults.push(`said ${said ?? 'nothing'} with a long warranty, expected ${long}`);
    if (!answer.includes(heaviest.name) || others.length) faults.push(`expected only ${heaviest.name} as the heaviest`);
    return faults.length ? `fail: ${faults.join('; ')}` : 'pass';
  },
  'review-audit': answer => { const { low } = TRUTH['review-audit'](); const said = (answer.match(/ANSWER:\s*(\d+)/i) || [])[1]; return Number(said) === low ? 'pass' : `fail: said ${said ?? 'nothing'}, expected ${low}`; },
  'basket-order': (answer, st) => {
    const { fryer, scale } = TRUTH['basket-order'](), o = st.placed[st.placed.length - 1];
    if (!o) return 'fail: no order placed';
    const qty = id => o.lines.filter(l => l.id === id).reduce((n, l) => n + l.qty, 0);
    const faults = [];
    if (o.lines.length !== 2 || qty(fryer.id) !== 2 || qty(scale.id) !== 1) faults.push('wrong items');
    if (o.promo !== PROMO.code) faults.push('promo not applied');
    if (o.shipping !== 'express') faults.push('wrong shipping');
    if (!/hollis/i.test(o.name) || !/12 Tanner Row/i.test(o.address)) faults.push('wrong name or address');
    if (!answer.includes(o.number)) faults.push('order number not reported');
    return faults.length ? `fail: ${faults.join(', ')}` : 'pass';
  },
};

// ---- pages ----
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shell(ns, title, body, st) {
  const base = `/s/${ns}`;
  const nav = CATEGORIES.map(c => `<li><a href="${base}/c/${c.slug}">${c.name}</a></li>`).join('');
  const brands = BRANDS.map(b => `<li><label><input type="checkbox" name="brand" value="${b}" disabled> ${b}</label></li>`).join('');
  const foot = ['Delivery', 'Returns', 'Warranty', 'Repairs', 'Spare parts', 'Gift cards', 'Trade accounts', 'Careers', 'Press', 'Sustainability', 'Privacy', 'Terms', 'Cookies', 'Accessibility', 'Store finder', 'Contact us']
    .map(t => `<li><a href="${base}/help/${t.toLowerCase().replace(/\s+/g, '-')}">${t}</a></li>`).join('');
  const count = st.cart.reduce((n, l) => n + l.qty, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | Larder</title>
<style>body{font:14px system-ui;margin:0}header,footer{background:#f3f1ec;padding:8px 16px}nav ul,footer ul,.brands{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0;margin:4px 0}main{padding:16px;display:grid;grid-template-columns:200px 1fr;gap:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{border:1px solid #ddd;padding:8px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}.banner{background:#b5651d;color:#fff;padding:6px 16px}</style></head><body>
<div class="banner" role="note">Autumn offer: ${PROMO.percent}% off your basket with code ${PROMO.code}.</div>
<header><a href="${base}/"><strong>Larder</strong></a> <a href="${base}/cart">Basket (${count})</a> <a href="${base}/admin/orders">Back office: orders</a>
<nav aria-label="Categories"><ul>${nav}</ul></nav></header>
<main><aside aria-label="Filters"><h2>Brands</h2><ul class="brands" style="flex-direction:column;gap:2px">${brands}</ul></aside><section>${body}</section></main>
<footer><ul>${foot}</ul><p>Larder is a test store. Nothing here is for sale.</p></footer></body></html>`;
}
const card = (ns, p) => `<article class="card"><h3><a href="/s/${ns}/p/${p.id}">${esc(p.name)}</a></h3><p>${esc(p.blurb)}</p>
<p><span>Price: ${money(p.price)}</span> · <span>Rating: ${p.rating.toFixed(1)} / 5</span> · <span>${p.stock ? `In stock (${p.stock})` : 'Out of stock'}</span></p></article>`;

function pageHome(ns, st) {
  const featured = products.filter((_, n) => n % 37 === 0).map(p => card(ns, p)).join('');
  return shell(ns, 'Home', `<h1>Kitchen things that last</h1><div class="grid">${featured}</div>`, st);
}
function pageCategory(ns, st, slug, q) {
  const c = CATEGORIES.find(x => x.slug === slug);
  if (!c) return null;
  const sort = q.get('sort') || 'featured', list = inCategory(slug, sort), pages = Math.ceil(list.length / PAGE);
  const page = Math.min(pages, Math.max(1, Number(q.get('page')) || 1));
  const href = (pg, s = sort) => `/s/${ns}/c/${slug}?sort=${s}&page=${pg}`;
  const sorts = [['featured', 'Featured'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['rating', 'Top rated']]
    .map(([v, t]) => (v === sort ? `<strong>${t}</strong>` : `<a href="${href(1, v)}">${t}</a>`)).join(' | ');
  const pager = Array.from({ length: pages }, (_, n) => (n + 1 === page ? `<strong>Page ${n + 1}</strong>` : `<a href="${href(n + 1)}">Page ${n + 1}</a>`)).join(' ');
  return shell(ns, c.name, `<h1>${c.name}</h1><p>${list.length} products. Sort: ${sorts}</p><div class="grid">${list.slice((page - 1) * PAGE, page * PAGE).map(p => card(ns, p)).join('')}</div>
<nav aria-label="Pages"><p>${pager}</p></nav>`, st);
}
function pageProduct(ns, st, id) {
  const p = byId.get(id);
  if (!p) return null;
  const c = CATEGORIES.find(x => x.slug === p.category);
  const related = inCategory(p.category).filter(x => x.brand === p.brand && x !== p).slice(0, 4).map(x => `<li><a href="/s/${ns}/p/${x.id}">${esc(x.name)}</a> ${money(x.price)}</li>`).join('');
  return shell(ns, p.name, `<p><a href="/s/${ns}/c/${c.slug}">${c.name}</a> › ${esc(p.name)}</p><h1>${esc(p.name)}</h1><p>${esc(p.blurb)}</p>
<p>Price: ${money(p.price)} · Rating: ${p.rating.toFixed(1)} / 5 · ${p.stock ? `In stock (${p.stock})` : 'Out of stock'} · Product code ${p.id}</p>
<form method="post" action="/s/${ns}/cart/add"><input type="hidden" name="id" value="${p.id}"><label>Quantity <input name="qty" type="number" min="1" value="1"></label> <button ${p.stock ? '' : 'disabled'}>Add to basket</button></form>
<h2>Specifications</h2><table>${p.specs.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
<h2>Reviews (${p.reviews.length})</h2><ul>${p.reviews.map(r => `<li><strong>${esc(r.who)}</strong>, ${r.stars} stars: ${esc(r.text)}</li>`).join('')}</ul>
<h2>More from ${esc(p.brand)}</h2><ul>${related}</ul>`, st);
}
const cartTotals = st => {
  const goods = st.cart.reduce((t, l) => t + l.qty * byId.get(l.id).price, 0), off = st.promo ? goods * PROMO.percent / 100 : 0;
  return { goods, off };
};
function pageCart(ns, st, message = '') {
  const { goods, off } = cartTotals(st);
  const rows = st.cart.map(l => { const p = byId.get(l.id); return `<tr><td><a href="/s/${ns}/p/${p.id}">${esc(p.name)}</a></td><td>${money(p.price)}</td>
<td><form method="post" action="/s/${ns}/cart/set"><input type="hidden" name="id" value="${p.id}"><label>Quantity for ${esc(p.name)} <input name="qty" type="number" min="0" value="${l.qty}"></label> <button>Update</button></form></td><td>${money(p.price * l.qty)}</td></tr>`; }).join('');
  return shell(ns, 'Basket', `<h1>Your basket</h1>${message ? `<p role="status">${esc(message)}</p>` : ''}${st.cart.length ? `<table><tr><th>Item</th><th>Each</th><th>Quantity</th><th>Line total</th></tr>${rows}</table>
<p>Goods: ${money(goods)}${st.promo ? ` · Promo ${st.promo}: -${money(off)}` : ''}</p>
<form method="post" action="/s/${ns}/cart/promo"><label>Promo code <input name="code"></label> <button>Apply code</button></form>
<p><a href="/s/${ns}/checkout">Go to checkout</a></p>` : '<p>Your basket is empty.</p>'}`, st);
}
function pageCheckout(ns, st, message = '') {
  const { goods, off } = cartTotals(st);
  return shell(ns, 'Checkout', `<h1>Checkout</h1>${message ? `<p role="alert">${esc(message)}</p>` : ''}<p>Goods ${money(goods - off)} for ${st.cart.reduce((n, l) => n + l.qty, 0)} items.</p>
<form method="post" action="/s/${ns}/checkout"><p><label>Full name <input name="name"></label></p><p><label>Email <input name="email" type="email"></label></p>
<p><label>Delivery address <textarea name="address" rows="3"></textarea></label></p>
<p><label>Shipping <select name="shipping">${Object.entries(SHIPPING).map(([k, v]) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)} (${money(v)})</option>`).join('')}</select></label></p>
<button>Place order</button></form>`, st);
}
function pageOrders(ns, st, q) {
  const pages = Math.ceil(st.orders.length / ORDERS_PAGE), page = Math.min(pages, Math.max(1, Number(q.get('page')) || 1));
  const rows = st.orders.slice((page - 1) * ORDERS_PAGE, page * ORDERS_PAGE).map(o => `<tr><td><a href="/s/${ns}/admin/orders/${o.number}">${o.number}</a></td><td>${esc(o.customer)}</td><td>${o.placed}</td><td>${o.status}</td><td>${money(o.total)}</td><td>${esc(o.note)}</td></tr>`).join('');
  const pager = Array.from({ length: pages }, (_, n) => (n + 1 === page ? `<strong>Page ${n + 1}</strong>` : `<a href="/s/${ns}/admin/orders?page=${n + 1}">Page ${n + 1}</a>`)).join(' ');
  return shell(ns, 'Orders', `<h1>Orders</h1><p>${st.orders.length} orders, oldest first.</p><table><tr><th>Order</th><th>Customer</th><th>Placed</th><th>Status</th><th>Total</th><th>Note</th></tr>${rows}</table><nav aria-label="Pages"><p>${pager}</p></nav>`, st);
}
function pageOrder(ns, st, number, message = '') {
  const o = st.orders.find(x => x.number === number);
  if (!o) return null;
  const lines = o.lines.map(l => `<tr><td>${esc(byId.get(l.id).name)}</td><td>${l.qty}</td><td>${money(l.price)}</td></tr>`).join('');
  return shell(ns, `Order ${o.number}`, `<p><a href="/s/${ns}/admin/orders">All orders</a></p><h1>Order ${o.number}</h1>${message ? `<p role="status">${esc(message)}</p>` : ''}
<p>Customer: ${esc(o.customer)} · Placed ${o.placed} · Status: <strong>${o.status}</strong> · Total ${money(o.total)}</p>
<table><tr><th>Item</th><th>Quantity</th><th>Each</th></tr>${lines}</table>
<form method="post" action="/s/${ns}/admin/orders/${o.number}"><p><label>Status <select name="status">${['processing', 'shipped', 'delivered', 'cancelled', 'refunded'].map(s => `<option${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}</select></label></p>
<p><label>Note <input name="note" value="${esc(o.note)}"></label></p><button>Save order</button></form>`, st);
}

// ---- the server ----
const readBody = req => new Promise(resolve => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => resolve(b)); });
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'text/html; charset=utf-8', head = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...head }); res.end(body); };
  const m = url.pathname.match(/^\/s\/([\w.-]{1,120})(\/.*)?$/);
  if (!m) return url.pathname === '/__health' ? send(200, 'ok', 'text/plain') : send(404, 'Not here. Pages live under /s/<session>/', 'text/plain');
  const ns = m[1], rest = m[2] || '/', st = space(ns), base = `/s/${ns}`;
  const go = to => send(303, '', 'text/plain', { location: base + to });
  const form = async () => new URLSearchParams(await readBody(req));
  st.log.push(`${req.method} ${rest}${url.search}`);

  if (req.method === 'POST') {
    let x;
    if ((x = rest.match(/^\/__check\/([\w-]+)$/))) {
      const answer = await readBody(req), check = CHECKS[x[1]];
      return send(200, `${JSON.stringify({ task: x[1], requests: st.log.length - 1 })}\n${check ? check(answer, st) : 'fail: no such task'}\n`, 'text/plain');
    }
    const f = await form();
    if (rest === '/cart/add' || rest === '/cart/set') {
      const p = byId.get(f.get('id')), qty = Math.max(0, Math.round(Number(f.get('qty')) || 0));
      if (!p) return send(400, 'No such product', 'text/plain');
      const line = st.cart.find(l => l.id === p.id);
      if (rest === '/cart/add') { if (p.stock && qty > 0) { if (line) line.qty += qty; else st.cart.push({ id: p.id, qty }); } }
      else if (line) { line.qty = qty; st.cart = st.cart.filter(l => l.qty > 0); }
      return go('/cart');
    }
    if (rest === '/cart/promo') { const ok = String(f.get('code') || '').trim().toUpperCase() === PROMO.code; if (ok) st.promo = PROMO.code; return send(200, pageCart(ns, st, ok ? 'Code applied.' : 'That code is not valid.')); }
    if (rest === '/checkout') {
      const name = String(f.get('name') || '').trim(), address = String(f.get('address') || '').trim(), shipping = String(f.get('shipping') || 'standard');
      if (!st.cart.length) return send(200, pageCheckout(ns, st, 'Your basket is empty.'));
      if (!name || !address || !/@/.test(String(f.get('email') || ''))) return send(200, pageCheckout(ns, st, 'Name, a valid email and an address are all required.'));
      const { goods, off } = cartTotals(st), number = `LR-${90001 + st.placed.length}`;
      st.placed.push({ number, name, email: f.get('email'), address, shipping, promo: st.promo, lines: st.cart, total: Math.round((goods - off + (SHIPPING[shipping] ?? 0)) * 100) / 100 });
      st.cart = []; st.promo = null;
      return go(`/order-placed/${number}`);
    }
    if ((x = rest.match(/^\/admin\/orders\/(LR-\d+)$/))) {
      const o = st.orders.find(y => y.number === x[1]);
      if (!o) return send(404, 'No such order', 'text/plain');
      if (f.get('status')) o.status = String(f.get('status'));
      o.note = String(f.get('note') ?? o.note);
      return send(200, pageOrder(ns, st, o.number, 'Order saved.'));
    }
    return send(404, 'Not found', 'text/plain');
  }
  let x, html = null;
  if (rest === '/__state') return send(200, JSON.stringify({ cart: st.cart, promo: st.promo, placed: st.placed, requests: st.log.length }), 'application/json');
  if (rest === '/') html = pageHome(ns, st);
  else if ((x = rest.match(/^\/c\/([\w-]+)$/))) html = pageCategory(ns, st, x[1], url.searchParams);
  else if ((x = rest.match(/^\/p\/([\w-]+)$/))) html = pageProduct(ns, st, x[1]);
  else if (rest === '/cart') html = pageCart(ns, st);
  else if (rest === '/checkout') html = pageCheckout(ns, st);
  else if ((x = rest.match(/^\/order-placed\/(LR-\d+)$/))) { const o = st.placed.find(y => y.number === x[1]); html = o ? shell(ns, 'Order placed', `<h1>Thank you, ${esc(o.name)}</h1><p>Your order number is <strong>${o.number}</strong>. Total charged: ${money(o.total)}.</p>`, st) : null; }
  else if (rest === '/admin/orders') html = pageOrders(ns, st, url.searchParams);
  else if ((x = rest.match(/^\/admin\/orders\/(LR-\d+)$/))) html = pageOrder(ns, st, x[1]);
  else if (rest.startsWith('/help/')) html = shell(ns, 'Help', '<h1>Help</h1><p>This page is not part of any task.</p>', st);
  return html ? send(200, html) : send(404, shell(ns, 'Not found', '<h1>Page not found</h1>', st));
}

if (process.argv[2] === '--answers') {
  const t = TRUTH, names = l => l.map(p => `${p.name} (${p.id}, ${money(p.price)})`);
  console.log(JSON.stringify({
    'cheapest-kettles': names(t['cheapest-kettles']()),
    'restock-report': names(t['restock-report']()),
    'mixer-ratio': { pros: t['mixer-ratio']().pros.length, best: t['mixer-ratio']().best.name },
    'noisy-grinders': t['noisy-grinders']().count,
    'refund-audit': t['refund-audit']().map(o => `${o.number} ${money(o.total)}`),
    'basket-order': { fryer: t['basket-order']().fryer.name, scale: t['basket-order']().scale.name },
    'catalogue-audit': { products: t['catalogue-audit']().forty.length, longWarranty: t['catalogue-audit']().long, heaviest: t['catalogue-audit']().heaviest.name },
    'review-audit': { reviews: t['review-audit']().reviews, low: t['review-audit']().low },
    // what would make a task ambiguous: a repeated product name, or a tie where a task asks for "the" one
    warnings: [
      new Set(products.map(p => p.name)).size !== products.length ? 'product names repeat' : null,
      (() => { const l = inCategory('scales', 'price-desc').filter(p => p.stock > 0); return l[0].price === l[1].price ? 'dearest scale is a tie' : null; })(),
      (() => { const ratio = p => Number(p.specs.find(s => s[0] === 'Motor (W)')[1]) / Number(p.specs.find(s => s[0] === 'Bowl capacity (l)')[1]); const l = t['mixer-ratio']().pros.map(ratio).sort((a, b) => b - a); return l[0] - l[1] < 1 ? 'mixer ratio is close to a tie' : null; })(),
      (() => { const l = inCategory('kettles', 'price-asc').filter(p => p.stock > 0 && p.rating >= 4); return l[2].price === l[3].price ? 'third cheapest kettle is a tie' : null; })(),
      t['catalogue-audit']().tie ? 'heaviest of the forty is a tie' : null,
      CATEGORIES.some(c => { const l = inCategory(c.slug, 'price-asc'); return l[4].price === l[5].price; }) ? 'a fifth cheapest product is a tie' : null,
    ].filter(Boolean),
  }, null, 1));
} else {
  const port = Number(process.argv[2] || process.env.PORT);
  if (!port) { console.error('usage: site.mjs <port> | --answers   (reserve the port: ~/.claude/bin/claude-port reserve thinker browser-bench)'); process.exit(2); }
  http.createServer((req, res) => { handle(req, res).catch(e => { res.writeHead(500); res.end(String(e?.message || e)); }); })
    .listen(port, '127.0.0.1', () => console.log(`larder on http://127.0.0.1:${port}`));
}
