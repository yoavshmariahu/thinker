// Which notes a review consults first: among the notes resting on definitions the change altered,
// those whose definitions took lines naming what the note names, then by how much of the change
// fell inside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { resolveScope, makeReader, collectChange, selectNotes, commonTerms } from '../src/review.js';

process.env.THINKER_TELEMETRY = 'off'; process.env.THINKER_LOG = 'off'; process.env.THINKER_AST = 'off';
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const SRC = `export function parseFlags(argv) {\n  const out = {};\n  return out;\n}\n\nexport function runCommand(name, flags) {\n  const handler = HANDLERS[name];\n  return handler(flags);\n}\n\nexport function main(argv) {\n  const flags = parseFlags(argv);\n  return runCommand(argv[0], flags);\n}\n`;

test('strong direct notes are ordered by whether the changed lines name what the note names, then by lines inside the definition', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-rsel-')));
  git(dir, 'init', '-q'); fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/cli.js'), SRC);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  const store = new Store(dir).init();
  const hub = createNote(store, { title: 'main dispatches every command', kind: 'invariant', answers: ['how commands run'], body: 'src/cli.js:main parses the argv and dispatches by name through runCommand; every command goes this way.', deps: [{ path: 'src/cli.js', symbol: 'main' }], confidence: 0.95 }).note;
  const flags = createNote(store, { title: 'unknown flags are rejected', kind: 'gotcha', answers: ['unknown flag'], body: 'src/cli.js:parseFlags must reject an unknown flag with a message naming it (unknown flag --x); a typo silently ignored cost a day once.', deps: [{ path: 'src/cli.js', symbol: 'parseFlags' }], confidence: 0.6 }).note;
  const handler = createNote(store, { title: 'handlers get flags only', kind: 'convention', answers: ['handler signature'], body: 'src/cli.js:runCommand passes a handler only the flags, never the raw argv.', deps: [{ path: 'src/cli.js', symbol: 'runCommand' }], confidence: 0.9 }).note;
  // the change: parseFlags gains a rejection of unknown flags (its note's words), main gains one unrelated line, runCommand untouched
  fs.writeFileSync(path.join(dir, 'src/cli.js'), SRC.replace('  const out = {};\n', '  const out = {};\n  for (const a of argv) if (a.startsWith(\'--\') && !KNOWN.has(a)) throw new Error(`unknown flag ${a}`);\n  if (!argv.length) return out;\n').replace('  const flags = parseFlags(argv);\n', '  const flags = parseFlags(argv);\n  console.error("hi");\n'));
  const scope = resolveScope(dir, {}); const reader = makeReader(dir, scope); const change = collectChange(dir, scope, reader);
  const sel = selectNotes(store.list(), change, reader);
  assert.deepEqual(sel.direct.map(n => n.id), [flags.id, hub.id], 'the flags note first although the hub note has more weight; the handler note is not touched');
  assert.equal(sel.exposures.get(flags.id).specific.term, true);
  assert.equal(sel.exposures.get(flags.id).specific.lines, 2);
  assert.equal(sel.exposures.get(hub.id).specific.term, false);
  assert.equal(sel.exposures.get(hub.id).specific.lines, 1);
  assert.ok(!sel.exposures.get(handler.id).touched.length);
  // the common-term set: words most notes share are not what makes a note specific
  assert.ok(!commonTerms([hub, flags, handler]).has('unknown'), 'three notes: nothing is common yet');
  const many = Array.from({ length: 6 }, (_, i) => ({ title: `pipeline step ${i}`, body: i < 4 ? 'the pipeline runs in order' : 'something else entirely', deps: [] }));
  const common = commonTerms(many, 0.5);
  assert.ok(common.has('pipeline'), 'in two thirds of the notes');
  assert.ok(!common.has('entirely'));
});
