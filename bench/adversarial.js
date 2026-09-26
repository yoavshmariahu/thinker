#!/usr/bin/env node
// Adversarial invalidation benchmark for click: apply semantic mutations that
// contradict cached notes, write a task file with corrected reference answers,
// and snapshot note directories for the arms.
//   node bench/adversarial.js apply    → mutate + commit, write tasks/click-adv.json, snapshot notes
//   node bench/adversarial.js verify   → run thinker check+verify on the mutated repo, snapshot verified notes
//   node bench/adversarial.js revert   → git reset to base, restore original notes
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const repo = path.join(HERE, 'repos', 'click');
const notes = path.join(repo, '.thinker', 'notes');
const snapOrig = path.join(HERE, 'runs', 'click-adv-notes-orig');
const snapVerified = path.join(HERE, 'runs', 'click-adv-notes-verified');
const baseFile = path.join(HERE, 'runs', 'click-adv-base.txt');
const git = (...a) => execFileSync('git', a, { cwd: repo }).toString().trim();
const core = path.join(repo, 'src/click/core.py');

const MUTATIONS = [
  { id: 'M1', task: 'E10-prompt-hidden', file: core, from: 'prompt_for_value', to: 'ask_for_value', all: true,
    delta: 'In this version of the code the method that prompts for a missing option value is `Option.ask_for_value` (it was renamed from `prompt_for_value`). An answer that names `prompt_for_value` is naming a function that no longer exists and is wrong on that point.' },
  { id: 'M2', task: 'E8-usageerror-abort', file: core, from: '            echo(_("Aborted!"), file=sys.stderr)\n            sys.exit(1)', to: '            echo(_("Interrupted!"), file=sys.stderr)\n            sys.exit(130)',
    delta: 'In this version of the code, `Command.main` handles `Abort` by printing "Interrupted!" to stderr and exiting with code 130 (not "Aborted!" / exit 1). An answer that says Abort prints "Aborted!" or exits with 1 is wrong on that point.' },
  { id: 'M3', task: 'E11-auto-envvar', file: core, from: '            envvar = f"{ctx.auto_envvar_prefix}_{self.name.upper()}"', to: '            envvar = f"{ctx.auto_envvar_prefix}__{self.name.upper()}"', all: true,
    delta: 'In this version of the code, `Option.resolve_envvar_value` joins the prefix and the option name with a DOUBLE underscore, so the variable for --log-level under `app db migrate` is `APP_DB_MIGRATE__LOG_LEVEL` (the context prefix chain still uses single underscores). An answer giving `APP_DB_MIGRATE_LOG_LEVEL` is wrong.' },
  { id: 'M4', task: 'E3-help-default', file: core, from: 'get_help_extra', to: 'help_extras', all: true,
    delta: 'In this version of the code the method that builds the default/required/envvar extras for an option help line is `Option.help_extras` (renamed from `get_help_extra`). An answer that names `get_help_extra` is naming a function that no longer exists and is wrong on that point.' },
  { id: 'M5', task: 'E9-run-single-test', rename: ['tests/test_shell_completion.py', 'tests/test_completion.py'],
    delta: 'In this version of the repo the shell completion tests live in `tests/test_completion.py` (the file was renamed from test_shell_completion.py). The command to run only them is `pytest tests/test_completion.py`; an answer pointing at tests/test_shell_completion.py is wrong.' },
];

const cmd = process.argv[2];
if (cmd === 'apply') {
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(baseFile, base);
  fs.rmSync(snapOrig, { recursive: true, force: true }); fs.cpSync(notes, snapOrig, { recursive: true });
  for (const m of MUTATIONS) {
    if (m.rename) { git('mv', m.rename[0], m.rename[1]); continue; }
    let s = fs.readFileSync(m.file, 'utf8');
    if (!s.includes(m.from)) throw new Error(`${m.id}: pattern not found`);
    s = m.all ? s.split(m.from).join(m.to) : s.replace(m.from, m.to);
    fs.writeFileSync(m.file, s);
  }
  git('add', '-A', '--', 'src', 'tests');
  git('-c', 'user.email=bench@thinker', '-c', 'user.name=bench', 'commit', '-qm', 'adversarial mutations');
  const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', 'click.json'), 'utf8'));
  const tasks = MUTATIONS.map(m => { const t = spec.tasks.find(t => t.id === m.task); return { ...t, id: t.id + '-adv', gold: t.gold + '\n\nIMPORTANT CORRECTION FOR THIS CODE VERSION: ' + m.delta, must: [] }; });
  fs.writeFileSync(path.join(HERE, 'tasks', 'click-adv.json'), JSON.stringify({ repo: 'click', tasks }, null, 2));
  console.log(`applied ${MUTATIONS.length} mutations at ${git('rev-parse', '--short', 'HEAD')} (base ${base.slice(0, 7)}); notes snapshot → ${snapOrig}`);
  console.log(execFileSync('node', [CLI, 'check', '--repo', repo]).toString());
} else if (cmd === 'verify') {
  console.log(execFileSync('node', [CLI, 'verify', '--repo', repo], { maxBuffer: 1 << 24 }).toString());
  fs.rmSync(snapVerified, { recursive: true, force: true }); fs.cpSync(notes, snapVerified, { recursive: true });
  console.log(`verified notes snapshot → ${snapVerified}`);
} else if (cmd === 'revert') {
  const base = fs.readFileSync(baseFile, 'utf8').trim();
  git('reset', '-q', '--hard', base);
  fs.rmSync(notes, { recursive: true, force: true }); fs.cpSync(snapOrig, notes, { recursive: true });
  console.log(`reverted to ${base.slice(0, 7)} and restored original notes`);
} else console.log('usage: adversarial.js apply|verify|revert');
