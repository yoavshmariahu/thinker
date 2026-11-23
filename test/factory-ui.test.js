import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('function fxWeeklyChart('), page.indexOf('function fxHistory('));
const chart = vm.runInNewContext(`${source}; fxWeeklyChart`, {
  money: n => `$${n.toFixed(2)}`, fmt: n => String(n),
  esc: x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
  fxWk: t => new Date(t).toISOString().slice(0, 10),
});
const columns = [0, 7, 14].map(day => ({ t: Date.UTC(2026, 10, 2 + day), end: Date.UTC(2026, 10, 9 + day) }));

test('weekly usage graph distinguishes zero, missing, and an unfinished week', () => {
  const html = chart(columns, [{ cost: 0, calls: 0 }, null, { cost: 20, calls: 4 }], true, columns[2].t + 86400000);
  assert.match(html, /\$0\.00/);
  assert.match(html, /Not recorded/);
  assert.match(html, /2026-11-16 \(partial week\): \$20\.00/);
  assert.match(html, /height="0"/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('weekly usage bars use the same zero-based scale and leave report data unchanged', () => {
  const cells = [{ cost: 10, tokens: 100, calls: 2 }, { cost: 20, tokens: 50, calls: 3 }, { cost: 0, tokens: 0, calls: 0 }];
  const before = JSON.stringify(cells);
  const html = chart(columns, cells, true, columns.at(-1).end);
  const heights = [...html.matchAll(/<rect[^>]+height="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.equal(heights[1], heights[0] * 2);
  assert.equal(heights[2], 0);
  assert.equal(JSON.stringify(cells), before);
  const tokenHtml = chart(columns, cells, false, columns.at(-1).end);
  assert.match(tokenHtml, /100 tokens/);
  assert.doesNotMatch(tokenHtml, /\$/);
});

test('absent history has an explicit empty state rather than fabricated zero bars', () => {
  assert.match(chart(columns, [], true, columns.at(-1).end), /No weekly usage recorded/);
  const zero = chart(columns, columns.map(() => ({ cost: 0, calls: 0 })), true, columns.at(-1).end);
  assert.match(zero, /<svg/);
  assert.doesNotMatch(zero, /NaN|Infinity/);
});

test('stage drawer hands the selected stage to Chat and closes before switching views', () => {
  const events = [], chatButton = {}, drawer = { innerHTML: '', querySelector: () => chatButton, querySelectorAll: () => [] };
  const overlay = { classList: { contains: () => false, add: () => events.push('open') }, querySelector: () => ({ focus() {} }) };
  const selectSource = page.slice(page.indexOf('function fxSelect('), page.indexOf('// a dollar figure'));
  const select = vm.runInNewContext(`${selectSource}; fxSelect`, {
    $: id => id === '#fx-overlay' ? overlay : drawer,
    document: { activeElement: null }, fxMark() {}, fxHistory() {},
    fxClose: () => events.push('close'), chatAboutStage: (stage, dollars) => events.push({ stage, dollars }),
    fxUse: () => '', fxPct: () => '0%', fmt: String, money: n => `$${n}`, esc: String, fxVerdict: {},
  });
  const stage = { key: 'build', name: 'Build', desc: 'Edits and writes', cost: 12, calls: 5 };
  select('stage', 'build', [stage], [], true);
  assert.match(drawer.innerHTML, /Chat about this/);
  assert.equal(typeof chatButton.onclick, 'function');
  chatButton.onclick();
  assert.deepEqual(events, ['open', 'close', { stage, dollars: true }]);
});
