// The behavior structure: a repository names its behaviors in BEHAVIORS.md, code and tests say which one they
// belong to, and the hooks hold an agent to it. What a person notices when it breaks: an agent's test landing
// with no behavior named, an edit to untouched code refused, the whole suite run for a one-line change, or a
// turn that ends with the change's own tests never run. Driven through the two functions the hooks call.
import { repo, tmp } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { behaviorsPreTool, behaviorsStop, behaviorsConfig, testRunOf } from '../src/behavior-hooks.js';
import { Store } from '../src/store.js';

const js = (...lines) => lines.join('\n') + '\n';
const light = (id, name) => js("import test from 'node:test';", '', `// behavior: ${id}`, `test('${name}', () => {});`);
const FILES = {
  'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }),
  'README.md': '# shop\n',
  'BEHAVIORS.md': js('# Behaviors', '',
    '- cart: The shopping cart',
    '  - cart.add: Adding an item puts it in the cart with its quantity',
    '  - cart.total: The total is the sum of price times quantity (uses: pricing.round)',
    '- pricing: Prices',
    '  - pricing.round: Amounts round to whole cents, half up',
    '  - pricing.legacy: Old price lists are read as they are',
    '- checkout: Paying for a cart',
    '  - checkout.pay: Paying charges the total and empties the cart (uses: cart.total)'),
  'src/cart.js': js('// behavior: cart.add', 'export function add(cart, item, qty = 1) {', '  return [...cart, { item, qty }];', '}', '',
    '// behavior: cart.total', 'export function total(cart) {', '  return cart.reduce((sum, l) => sum + l.item.price * l.qty, 0);', '}'),
  'src/pricing.js': js('// behavior: pricing.round', 'export const round = n => Math.round(n * 100) / 100;', '', '// behavior: pricing.legacy', 'export const legacy = list => list;'),
  'src/checkout.js': js('// behavior: checkout.pay', 'export const pay = (cart, charge) => charge(cart);'),
  'src/util.js': js('export const id = x => x;'), // written before the structure: tied to nothing
  'test/cart-add.test.js': light('cart.add', 'an added item is in the cart'),
  'test/cart-total.test.js': light('cart.total', 'the total sums price times quantity'),
  'test/pricing.test.js': light('pricing.round', 'half a cent rounds up'),
  'test/checkout.test.js': light('checkout.pay', 'paying charges the total'),
  'e2e/cart.e2e.test.js': light('cart', 'a cart is filled and totalled'),
};
const RUN = 'npm test -- test/cart-total.test.js test/checkout.test.js e2e/cart.e2e.test.js';

// A checkout with the structure in it, and the hooks' two doors over it: `land` is the PreToolUse door followed
// by what the host does with an edit that was not refused, `stop` the end of the turn, `ran` the transcript's
// own word on how a tool call ended.
function shop(files = FILES) {
  const dir = repo(files), rows = [];
  const s = { dir, rows, store: new Store(dir).init(), transcript: path.join(dir, '.thinker', 'transcript.jsonl') };
  const door = { store: s.store, session: 'session-1', repo: dir, cfg: { enabled: true }, log: r => rows.push(r) };
  s.pre = ev => { const o = behaviorsPreTool({ ev: { cwd: dir, prompt_id: 'turn-1', ...ev }, ...door }); return o ? JSON.parse(o).hookSpecificOutput : null; };
  s.land = ev => {
    const a = s.pre(ev), f = ev.tool_input.file_path;
    if (a?.permissionDecision === 'deny') return a;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, ev.tool_name === 'Write' ? ev.tool_input.content : fs.readFileSync(f, 'utf8').replace(ev.tool_input.old_string, () => ev.tool_input.new_string));
    return a;
  };
  s.edit = (rel, from, to, more = {}) => s.land({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel), old_string: from, new_string: to }, ...more });
  s.write = (rel, content, more = {}) => s.land({ tool_name: 'Write', tool_input: { file_path: path.join(dir, rel), content }, ...more });
  s.shell = (command, id, more = {}) => s.pre({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...more });
  s.ran = (id, failed = false) => fs.appendFileSync(s.transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'x' }] } }) + '\n');
  s.stop = (turn = 'turn-1') => { const o = behaviorsStop({ ev: { transcript_path: s.transcript, prompt_id: turn }, ...door }); return o ? JSON.parse(o) : null; };
  return s;
}
const SWAP = ['src/cart.js', 'l.item.price * l.qty', 'l.qty * l.item.price']; // a change to cart.total's code

test('off until it is switched on, and silent in a repository that names no behaviors', () => {
  assert.equal(behaviorsConfig().enabled, false, 'ships off');
  const home = tmp('home'), set = v => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ behaviors: v }));
  set({ enabled: true }); assert.equal(behaviorsConfig({ home }).enabled, true, 'the machine\'s config switches it on');
  set(true); assert.equal(behaviorsConfig({ home }).enabled, true);
  set('yes please'); assert.equal(behaviorsConfig({ home }).enabled, false, 'anything else is not a yes');
  const s = shop(), bare = `import test from 'node:test';\ntest('no behavior named', () => {});\n`;
  const ev = { tool_name: 'Write', tool_input: { file_path: path.join(s.dir, 'test/new.test.js'), content: bare }, cwd: s.dir };
  assert.equal(behaviorsPreTool({ ev, store: s.store, session: 'session-1', repo: s.dir, cfg: { enabled: false } }), null);
  assert.equal(s.pre(ev).permissionDecision, 'deny', 'the same edit, switched on');
  const { ['BEHAVIORS.md']: _, ...without } = FILES;
  const plain = shop(without);
  assert.equal(plain.write('test/new.test.js', bare), null, 'no BEHAVIORS.md: nothing is checked');
  assert.equal(plain.stop(), null);
});

test('the first edit of a turn carries the structure to build around and what the file holds, once', () => {
  const s = shop();
  const a = s.edit(...SWAP);
  assert.equal(a.permissionDecision, undefined, 'a note on the edit, never a decision: the person\'s own permissions still apply');
  assert.match(a.additionalContext, /built around named behaviors \(BEHAVIORS\.md\)/);
  assert.match(a.additionalContext, /src\/cart\.js holds: cart\.add \(lines 1-5\), cart\.total \(lines 6-9\)/);
  assert.match(a.additionalContext, /cart\.total: The total is the sum of price times quantity/);
  assert.equal(s.edit('src/cart.js', 'qty = 1', 'qty = 2'), null, 'the same file again in the turn: nothing more to say');
  const b = s.edit('src/pricing.js', '* 100) / 100', '* 100) / 100.0');
  assert.match(b.additionalContext, /src\/pricing\.js holds: pricing\.round/);
  assert.doesNotMatch(b.additionalContext, /Hold to that structure/, 'another file in the turn gets its map, not the rules again');
  const c = s.edit('src/pricing.js', '100.0', '100', { prompt_id: 'turn-2' });
  assert.match(c.additionalContext, /Hold to that structure/, 'the next turn is told again, where it is the newest thing in the context');
  assert.deepEqual(s.rows.filter(r => r.at === 'edit').map(r => `${r.from}>${r.told}`), ['explore>rules', 'edit>file', 'edit>rules']);
});

test('an edit that breaks the structure is refused with the fix, and a behavior is named before its code', () => {
  const s = shop();
  const t = s.write('test/coupon.test.js', `import test from 'node:test';\n\ntest('a coupon takes ten percent off', () => {});\n`);
  assert.equal(t.permissionDecision, 'deny');
  assert.match(t.permissionDecisionReason, /test\/coupon\.test\.js:3 test "a coupon takes ten percent off" names no behavior/);
  assert.equal(fs.existsSync(path.join(s.dir, 'test/coupon.test.js')), false, 'a refused edit never lands');
  // code under an id nobody has named yet, and code under nothing
  const coupon = js('// behavior: cart.total.coupon', 'export const coupon = (sum, pct) => sum * (1 - pct / 100);');
  assert.match(s.write('src/coupon.js', coupon).permissionDecisionReason, /names `cart\.total\.coupon`, which is not in BEHAVIORS\.md/);
  assert.match(s.write('src/coupon.js', 'export const coupon = (sum, pct) => sum;\n').permissionDecisionReason, /src\/coupon\.js:1 is code tied to no behavior/);
  // so the order of work is a fact: the name, then the code, then the test
  assert.match(s.edit('BEHAVIORS.md', '- checkout: Paying', '    - cart.totl.coupon: A coupon takes its percentage off\n- checkout: Paying').permissionDecisionReason, /has no parent/);
  assert.notEqual(s.edit('BEHAVIORS.md', '- pricing: Prices', '    - cart.total.coupon: A coupon takes its percentage off the total\n- pricing: Prices')?.permissionDecision, 'deny');
  assert.notEqual(s.write('src/coupon.js', coupon)?.permissionDecision, 'deny');
  assert.notEqual(s.write('test/coupon.test.js', light('cart.total.coupon', 'a coupon takes ten percent off'))?.permissionDecision, 'deny');
  // code from before the structure is held to it where it is touched, and nowhere else
  assert.match(s.edit('src/util.js', 'x => x', 'y => y').permissionDecisionReason, /src\/util\.js:1 is code tied to no behavior[^]*`none` for plumbing/);
  assert.notEqual(s.write('src/util.js', js('// behavior: none', 'export const id = y => y;'))?.permissionDecision, 'deny');
});

test('a light test names one behavior, and a test of a whole feature lives under e2e', () => {
  const s = shop(), refused = (rel, text) => s.write(rel, text)?.permissionDecisionReason || '';
  assert.match(refused('test/cart.test.js', light('cart', 'the cart works')), /names `cart`, a whole feature/);
  assert.match(refused('e2e/total.e2e.test.js', light('cart.total', 'totals end to end')), /End-to-end tests cover a whole feature/);
  assert.match(refused('test/both.test.js', js("import test from 'node:test';", '// behavior: cart.add', '// behavior: cart.total', "test('adds and totals', () => {});")), /stacks two behaviors \(cart\.add, cart\.total\) on one test/);
  assert.equal(refused('e2e/checkout.e2e.test.js', light('checkout', 'a cart is paid for')), '');
  assert.equal(refused('test/add-twice.test.js', light('cart.add', 'adding twice keeps both')), '');
});

test('a test run is told what the edits did to the behaviors and exactly which tests hold them', () => {
  const s = shop();
  s.edit(...SWAP);                                                                             // cart.total modified
  s.edit('BEHAVIORS.md', '  - pricing.legacy: Old price lists are read as they are\n', '');   // pricing.legacy deleted
  s.edit('BEHAVIORS.md', '- pricing: Prices', '    - cart.total.coupon: A coupon takes its percentage off the total\n- pricing: Prices');
  s.write('src/coupon.js', js('// behavior: cart.total.coupon', 'export const coupon = (sum, pct) => sum * (1 - pct / 100);'));
  const said = s.shell('node --test test/cart-total.test.js', 'run-1').additionalContext;
  assert.match(said, /modified\s+cart\.total {2}\(src\/cart\.js\)/);
  assert.match(said, /added\s+cart\.total\.coupon/);
  assert.match(said, /deleted\s+pricing\.legacy/);
  // its own test, the end-to-end test of the feature above it, and the test of what says it uses it: nothing else
  assert.match(said, new RegExp(`Run exactly:\\n {2}${RUN.replace(/[.]/g, '\\.')}\\n`));
  assert.match(said, /test\/checkout\.test\.js {2}checkout\.pay \(uses cart\.total\)/);
  assert.match(said, /e2e\/cart\.e2e\.test\.js {2}\[end-to-end\] {2}cart \(the feature above cart\.total\)/);
  assert.doesNotMatch(said, /cart-add\.test|pricing\.test/, 'tests of behaviors the change did not reach are left out');
  // and what the change still owes the graph
  assert.match(said, /`cart\.total\.coupon` is new and no test names it/);
  assert.match(said, /src\/pricing\.js:4 still names `pricing\.legacy`, which this change removed/);
  assert.equal(s.shell('node --test test/cart-total.test.js', 'run-2'), null, 'said once while the files stand as they are');
  assert.equal(s.rows.at(-1).at, 'test');
  assert.deepEqual([s.rows.at(-1).from, s.rows.at(-1).modified, s.rows.at(-1).added, s.rows.at(-1).deleted, s.rows.at(-1).tests], ['edit', 1, 1, 1, 3]);
});

test('code that was taken out belonged to a behavior too', () => {
  const s = shop();
  s.edit('src/cart.js', '  return [...cart, { item, qty }];\n', '');
  const said = s.shell('node --test test/cart-total.test.js', 'run-1').additionalContext;
  assert.match(said, /modified\s+cart\.add/);
  assert.match(said, /npm test -- test\/cart-add\.test\.js e2e\/cart\.e2e\.test\.js\n/);
});

test('the whole suite is refused in favour of the selection, and a run the edits do not concern is left alone', () => {
  const s = shop();
  assert.equal(s.shell('npm test', 'run-0'), null, 'nothing edited: the run is the agent\'s own');
  s.edit('README.md', '# shop', '# the shop');
  assert.equal(s.shell('npm test', 'run-1'), null, 'an edit that touches no behavior');
  s.edit(...SWAP);
  const a = s.shell('npm test 2>&1 | tail -5', 'run-2');
  assert.equal(a.permissionDecision, 'deny');
  assert.match(a.permissionDecisionReason, /did not run the whole suite[^]*Run exactly:\n {2}npm test -- test\/cart-total/);
  assert.equal(s.shell('ls test', 'run-3'), null, 'not a test run');
  // whose exit code a line ends with: the runner's own, or something after it
  const own = c => testRunOf(c)?.own ?? null;
  assert.deepEqual([own('cd app && npm test -- a.test.js 2>&1'), own('pytest tests/x.py | tail -3'), own('npm test -- a.test.js || true'), own('git status')], [true, false, false, null]);
});

test('the turn is held until the tests of the touched behaviors have passed after the last edit', () => {
  const s = shop();
  s.edit(...SWAP);
  let h = s.stop();
  assert.equal(h.decision, 'block');
  assert.match(h.reason, /this turn is not finished\.\nThe tests that hold the touched behaviors have not run since the last edit\.[^]*Run exactly:/);
  // half the selection passes: the other half is still owed, by name
  s.shell('npm test -- test/cart-total.test.js', 'run-1'); s.ran('run-1');
  assert.match(s.stop().reason, /have not run since the last edit: test\/checkout\.test\.js, e2e\/cart\.e2e\.test\.js\./);
  s.shell('npm test -- test/checkout.test.js e2e/', 'run-2'); s.ran('run-2');
  assert.equal(s.stop(), null, 'the selection has passed between two runs, with no edit after them');
  // an edit after the pass: it no longer covers the files as they stand
  s.edit('src/cart.js', ', 0);', ', 0.0);');
  assert.equal(s.stop().decision, 'block');
  // (an edit that puts the file back as it was owes nothing: the change is read from the files, not from a tally)
  // a run whose exit code is the pipe's, then a run that fails: neither is a pass
  s.shell(`${RUN} | tail -5`, 'run-3'); s.ran('run-3');
  assert.match(s.stop().reason, /piped or masked does not count/);
  s.shell(RUN, 'run-4'); s.ran('run-4', true);
  assert.match(s.stop().reason, /failed on their last run/);
  // held once for one reason: an agent that cannot meet it says so, and the turn ends
  assert.equal(s.stop(), null);
  assert.equal(s.stop('turn-2').decision, 'block', 'and the next turn is held to it again');
  s.shell(RUN, 'run-5'); s.ran('run-5');
  assert.equal(s.stop('turn-2'), null);
  assert.deepEqual(s.rows.filter(r => r.at === 'stop').map(r => r.decision), ['hold', 'hold', 'pass', 'hold', 'hold', 'hold', 'let-go', 'hold', 'pass']);
});

test('a turn that owes the graph something is held for it, tests or no tests', () => {
  const s = shop();
  s.edit('BEHAVIORS.md', '- pricing: Prices', '  - cart.empty: Emptying a cart leaves no items\n- pricing: Prices');
  const h = s.stop();
  assert.match(h.reason, /added\s+cart\.empty/);
  assert.match(h.reason, /`cart\.empty` is new and no test names it[^]*`cart\.empty` is new and no code is tied to it/);
  // written through the shell, where no edit hook stands: the end of the turn still reads the files
  fs.appendFileSync(path.join(s.dir, 'src/cart.js'), '\n// behavior: cart.empty\nexport const empty = () => [];\n');
  fs.writeFileSync(path.join(s.dir, 'test/cart-empty.test.js'), `import test from 'node:test';\ntest('an emptied cart has no items', () => {});\n`);
  assert.match(s.stop().reason, /test\/cart-empty\.test\.js:2 test "an emptied cart has no items" names no behavior/);
});

test('what rests on a changed behavior is reached through every link, and a reworded behavior counts as changed', () => {
  const s = shop({ ...FILES,
    'BEHAVIORS.md': `${FILES['BEHAVIORS.md']}  - checkout.receipt: A receipt names what was paid (uses: checkout.pay)\n`,
    'src/receipt.js': js('// behavior: checkout.receipt', 'export const receipt = paid => `paid ${paid}`;'),
    'test/receipt.test.js': light('checkout.receipt', 'a receipt names the amount') });
  s.edit(...SWAP);
  assert.match(s.shell('node --test test/cart-total.test.js', 'run-1').additionalContext, /test\/receipt\.test\.js {2}checkout\.receipt \(uses checkout\.pay\)/, 'two links from cart.total');
  // the sentence is the behavior: changing it is a change to verify, by its own test and by what rests on it
  const r = shop();
  r.edit('BEHAVIORS.md', 'half up', 'half to even');
  const held = r.stop().reason;
  assert.match(held, /modified\s+pricing\.round {2}\(BEHAVIORS\.md\)/);
  assert.match(held, /npm test -- test\/cart-total\.test\.js test\/checkout\.test\.js test\/pricing\.test\.js\n/);
  assert.match(r.edit('BEHAVIORS.md', 'half to even', 'half to even (uses: nothing.here)').permissionDecisionReason, /pricing\.round says it uses nothing\.here, which is not in the file/);
});

test('a Python repository is held the same way, in its own comment and its own runner', () => {
  const s = shop({
    'BEHAVIORS.md': js('- cart: The cart', '  - cart.add: Adding puts an item in'),
    'cart.py': js('# behavior: cart.add', 'def add(cart, item):', '    return cart + [item]'),
    'tests/test_cart.py': js('from cart import add', '', '# behavior: cart.add', 'def test_add_puts_an_item_in():', '    assert add([], 1) == [1]'),
  });
  assert.match(s.write('tests/test_more.py', js('def test_add_twice():', '    assert True')).permissionDecisionReason, /tests\/test_more\.py:1 test "test_add_twice" names no behavior\. Put the line `# behavior: <id>` above it/);
  s.edit('cart.py', 'cart + [item]', '[*cart, item]');
  assert.match(s.stop().reason, /Run exactly:\n {2}python -m pytest tests\/test_cart\.py\n/);
});
