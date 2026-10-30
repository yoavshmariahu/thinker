// `thinker test -- <command>`: run the repository's tests and print what a reader needs instead of
// the whole log. The log goes to a file under .thinker/state/tests/ (out of git); the agent gets the
// counts, each distinct failure cause once, and the path. See src/testing.js for why.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { testsConfig, detectRunner, machineReadable, parseTestOutput, summarize, groupCauses, logPathFor, pruneLogs, ansiStripper, NO_COLOR_ENV } from '../testing.js';

// what is kept in memory for parsing; the file has everything
const MAX_BUFFER = 8 << 20;

// The words after `--` come from the user's shell, which has already taken the quotes off:
// `pytest -k "two words"` arrives as three words and must go back together as three. One word
// that is itself a command line (`thinker test -- "a && b"`) is passed on as it stands.
const quote = a => (/^[\w@%+=:,./^-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
export const shellJoin = args =>
  (args.length === 1 && /\s/.test(args[0]) ? args[0] : args.map(quote).join(' '));

async function testCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  const command = shellJoin([...(ctx.after || []), ...pos]).trim();
  if (!command) {
    out('thinker test -- <command>\n  run the test command and print the counts, each distinct failure cause once, and the log path');
    process.exitCode = 2;
    return;
  }
  const cfg = testsConfig(store, flags.color === 'no' || flags.color === false ? { color: false } : {});
  const runner = detectRunner(command);
  const toRun = machineReadable(command, runner, { color: cfg.color });
  const logPath = logPathFor(store, runner);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath);
  const strip = cfg.color ? ansiStripper() : null;

  let buf = '', lines = 0;
  const take = chunk => {
    let text = String(chunk);
    if (strip) text = strip.push(text);
    if (!text) return;
    log.write(text);
    for (let i = -1; (i = text.indexOf('\n', i + 1)) >= 0;) lines++;
    if (buf.length < MAX_BUFFER) buf += text;
  };
  const child = spawn(toRun, {
    cwd: repo, shell: true,
    env: { ...process.env, ...(cfg.color ? NO_COLOR_ENV : {}) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const { code, signal } = await new Promise(res => {
    child.on('error', e => res({ code: 127, signal: null, error: e }));
    child.on('close', (code, signal) => res({ code, signal }));
  });
  if (strip) {
    const rest = strip.end();
    if (rest) { log.write(rest); buf += rest; lines += (rest.match(/\n/g) || []).length; }
  }
  await new Promise(r => log.end(r));

  const exitCode = code === null ? (signal ? 128 : 1) : code;
  const parsed = parseTestOutput(buf, { runner });
  out(summarize(parsed, {
    repo, logPath: path.relative(repo, logPath), logLines: lines, exitCode, command: toRun, cfg, tail: buf,
  }));
  store.log({ op: 'test-run', runner: parsed?.runner || runner || null, exit: exitCode,
    failed: parsed?.failed ?? null, passed: parsed?.passed ?? null, causes: parsed ? groupCauses(parsed.failures).length : null,
    bytes: buf.length });
  pruneLogs(store, cfg.keepLogs);
  process.exitCode = exitCode;
}

export const commands = { test: testCommand };
