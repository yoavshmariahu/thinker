// One source of truth for savings (the owner, 2026-11-22: "we should have an accountant module that is fully
// responsible for tracking savings ... consolidate any savings logic into the accountant"). These hold the rule in
// src/accountant.js's header by reading the source: a saving is priced, netted and added up there and nowhere else,
// and every door that says what was saved asks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir = SRC) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : /\.(js|mjs|tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []);
const rel = f => path.relative(SRC, f);
const read = f => fs.readFileSync(f, 'utf8');
// the code of a file without its comments: a rule about what a module does is not broken by what it says
const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
const others = files().filter(f => rel(f) !== 'accountant.js');
const offenders = re => others.filter(f => re.test(code(f))).map(rel);

test('the two modules the accountant was made of are gone, and nothing names them', () => {
  for (const gone of ['report-savings.js', 'savings-ledger.js']) {
    assert.equal(fs.existsSync(path.join(SRC, gone)), false, `${gone} is the accountant now`);
    assert.deepEqual(files().filter(f => read(f).includes(gone)).map(rel), [], `nothing still names ${gone}`);
  }
});

test('a saved token is priced in the accountant and nowhere else', () => {
  // prices.js defines the rate a saved input token is worth; the accountant is its only caller
  assert.deepEqual(offenders(/\bcostOfInputSavings\b/).filter(f => f !== 'prices.js'), []);
  assert.match(code(path.join(SRC, 'accountant.js')), /costOfInputSavings\(savedAs\(r, /);
});

test('a saving is netted against what it cost in the accountant and nowhere else', () => {
  // saved - rewrite - reread, in any spelling, is netOf's
  assert.deepEqual(offenders(/\bsaved\w*\s*-\s*[\w.?()|\s]*\b(rewrite|reread)/i), []);
  assert.deepEqual(offenders(/\bnet\s*[:=]\s*-\s*\(/), []);
  assert.match(code(path.join(SRC, 'accountant.js')), /export const netOf = c => \(c\?\.saved \|\| 0\) - \(c\?\.rewrite \|\| 0\) - \(c\?\.reread \|\| 0\);/);
});

test('the clearing\'s rows are read for a count through the accountant\'s one reader', () => {
  // compression.js keeps the records and defines the reader of them; only the accountant's `records` calls it, so no
  // two doors count over different sets of sessions
  assert.deepEqual(offenders(/\bclearingRows\(/).filter(f => f !== 'compression.js'), []);
  assert.match(code(path.join(SRC, 'accountant.js')), /export function records\(store, \{ all = false, home = null, env = process\.env, log = null, compression = null, config = null \} = \{\}\)/);
});

test('every function that says what was saved is the accountant\'s own', async () => {
  const mine = ['weeklySavings', 'mergeSavings', 'savingsValue', 'repositorySavings', 'savingsByDay', 'delegationSavings', 'delegationBySession', 'delegationDetail', 'repeatSavings',
    'clearedBySession', 'clearingCostBySession', 'desktopClearingCost', 'loggedClearingCost', 'clearingFor', 'clearedFor', 'rewriteCostFor', 'rewriteOfLogged', 'rereadCost',
    'sessionSaving', 'netOf', 'addSaving', 'sumSavings', 'actionEffect', 'itemCost', 'effectSpan', 'withEffects', 'outputComparison', 'wastePerDay', 'promptsADay', 'dollarsADay',
    'mergeImpacts', 'impactSaid', 'delegatedView', 'delegatedSaid', 'delegatedTotalSaid', 'handedTotal', 'sumHanded',
    'computeSavings', 'readSavings', 'writeSavings', 'refreshSavings', 'refreshSavingsInBackground', 'savingsNow', 'savingsLine', 'savingsStatus', 'savingsDetail', 'savingsNet', 'records'];
  const a = await import('../src/accountant.js');
  for (const name of mine) assert.equal(typeof a[name], 'function', `accountant.js exports ${name}`);
  const defined = new RegExp(`^(export\\s+)?(async\\s+)?(function|const|let)\\s+(${mine.join('|')})\\b`, 'm');
  // the desktop mods carry their own copy of a few words (they run inside the agent and can import nothing of
  // thinker's); test/claude-card.test.js holds each copy to the accountant's
  const mirrors = f => f.startsWith(path.join('integrations', 'claude-card')) || f.startsWith(path.join('integrations', 'claude-clear'));
  assert.deepEqual(others.filter(f => !mirrors(rel(f)) && defined.test(code(f))).map(rel), []);
});

test('the doors that say what was saved ask the accountant', () => {
  const asks = { 'commands/savings.js': /computeSavings, readSavings/, 'commands/hooks.js': /readSavings, refreshSavingsInBackground, savingsLine/, 'chat.js': /savingsNow, savingsDetail, savingsNet/,
    'upkeep.js': /delegatedView, delegatedTotalSaid/, 'report.js': /repositorySavings, mergeSavings/, 'delivery.js': /clearingFor, rewriteCostFor, rewriteOfLogged, sessionSaving, netOf/,
    'telemetry.js': /savingsByDay/, 'factory.js': /clearingFor/, 'integrations/opencode-tui.js': /savingsStatus/ };
  for (const [file, names] of Object.entries(asks)) {
    const line = read(path.join(SRC, file)).split('\n').find(l => /^import .* from '(\.\.?\/)+accountant\.js';/.test(l)) || '';
    assert.match(line, names, `${file} imports its savings from the accountant`);
  }
});
