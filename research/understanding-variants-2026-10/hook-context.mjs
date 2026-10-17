// A defined arm's context command that serves a fixed cache through thinker's own prompt hook: the notes are
// copied for this call (the hook writes use counts beside them), and the hook runs on the session's worktree with
// THINKER_NOTES_DIR on the copy, as the built-in `hook` arm does. Lets one experiment hold arms served different
// caches (Artemis serves one cache per launch).
//   node hook-context.mjs <notes dir> [--budget n]   (stdin: the runner's {prompt, session_id}; cwd: the worktree)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const THINKER = process.env.PINNED_THINKER || '/Users/yoavshmariahu/src/thinker-under-test';
const [src, ...rest] = process.argv.slice(2);
const budget = rest[rest.indexOf('--budget') + 1] && rest.includes('--budget') ? rest[rest.indexOf('--budget') + 1] : '750';
const input = fs.readFileSync(0, 'utf8');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-context-'));
try {
  fs.cpSync(src, copy, { recursive: true });
  const out = execFileSync(process.execPath, [path.join(THINKER, 'src/cli.js'), 'hook', 'prompt', '--client', 'codex', '--repo', process.cwd(), '--budget', budget],
    { input, encoding: 'utf8', env: { ...process.env, THINKER_NOTES_DIR: copy, THINKER_NO_BG_VERIFY: '1', THINKER_HOLDOUT: '0', THINKER_TELEMETRY: 'off' }, maxBuffer: 1 << 24 });
  // the list of notes not shown asks for a lookup call these arms do not offer (as the built-in arm strips it)
  process.stdout.write(out.replace(/\n\nAlso in the cache, not shown[\s\S]*?(?=\n<\/thinker-cache>)/g, ''));
} finally { fs.rmSync(copy, { recursive: true, force: true }); }
