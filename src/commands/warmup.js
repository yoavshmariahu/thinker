// thinker warmup: the warm-up offered in the terminal. The installer runs it last; `thinker warmup` runs it
// again. One question, browser or here, then one multi-select of repositories, with skip. A machine with no
// display (ssh, a container) is not offered the browser: the page binds 127.0.0.1 of this machine, and
// before 2026-10-12 the installer launched it anyway, said it had opened, and five of seven installs that
// day never warmed a cache. The terminal path takes the page's defaults: full depth, the whole repository,
// the agent already logged in. Every other choice stays on the page (thinker ui).
import fs from 'node:fs';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { warmupCandidates } from '../machine.js';
import { selectMenu, c, formatDuration, withSpinner } from '../setup/ui.js';

export const PICKED = 5; // as the page: the five most recently active, not yet warmed, are picked

export function headless(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

// The answer to the multi-select: numbers, `all`, or `skip`; nothing keeps the picked ones.
export function parseSelection(answer, items, picked) {
  const a = String(answer || '').trim().toLowerCase();
  if (!a) return { chosen: picked };
  if (['skip', 's', 'none', 'no', 'n'].includes(a)) return { chosen: [] };
  if (['all', 'a'].includes(a)) return { chosen: items };
  const chosen = [];
  for (const tok of a.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) return { error: `not a number: ${tok}` };
    const from = Number(m[1]), to = Number(m[2] || m[1]);
    for (let n = from; n <= to; n++) { if (n < 1 || n > items.length) return { error: `no repository ${n}` }; if (!chosen.includes(items[n - 1])) chosen.push(items[n - 1]); }
  }
  return { chosen };
}

const row = (r, i, picked, width) => {
  const est = r.estimates.full, mark = picked.includes(r) ? c.cyan('[x]') : c.dim('[ ]');
  const what = est.prs ? `~${formatDuration(est.seconds)}, ${est.prs} pull requests` : 'no merged pull requests to read';
  const tags = [r.current ? 'current' : '', r.warmed ? 'warmed before' : r.hasCache ? `${r.notes} notes already` : ''].filter(Boolean).join(', ');
  return `    ${String(i + 1).padStart(2)}) ${mark} ${r.name.padEnd(width)} ${c.dim(what)}${tags ? c.dim(` · ${tags}`) : ''}`;
};

export async function warmupCommand(ctx) {
  const { flags, store, out, HERE } = ctx;
  const cli = path.join(HERE, 'cli.js');
  const ask = async q => { const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } };
  const later = () => out(`  Warm up caches any time: ${c.cyan('thinker warmup')} here, or ${c.cyan('thinker ui')} in the browser.`);

  if (flags.skip) { out('  Skipped: every git repository has a cache that grows from your sessions.'); later(); return; }
  const canBrowse = !headless() && !flags.terminal;
  let where = flags.browser ? 'browser' : flags.terminal || flags.repos || flags.yes ? 'terminal' : null;
  if (!where && !process.stdin.isTTY && !flags.dry) { later(); return; }
  if (!where) {
    const items = [
      ...(canBrowse ? [{ label: 'Open the warm-up page in the browser', value: 'browser' }] : []),
      { label: canBrowse ? 'Choose here, in the terminal' : 'Choose which repositories to warm up', value: 'terminal' },
      { label: 'Skip for now (every git repository has a cache that grows from your sessions)', value: 'skip' },
    ];
    const pick = await selectMenu({ header: `\n  ${c.bold('Warm up caches')}: read each repository's merged pull requests into its cache, so the first session there already finds notes.`, items, out });
    where = pick?.value || 'skip';
  }
  if (where === 'skip') { out('  Skipped.'); later(); return; }
  if (where === 'browser') {
    if (flags.dry) { out('  would open: thinker ui --from-setup --tab warmup'); return; }
    try { const p = spawn(process.execPath, [cli, 'ui', '--from-setup', '--tab', 'warmup'], { detached: true, stdio: 'ignore' }); p.unref(); } catch {}
    out(`  The warm-up page is opening in your browser. ${c.dim('Open it again any time with thinker ui.')}`);
    return;
  }

  // the terminal: the page's list, the page's defaults
  // the page's list (ui/server.js): the agents' own session records under the user's home, and thinker's log
  const all = await withSpinner(out, 'Looking at the repositories your agents work in', async () => warmupCandidates(store, {}));
  const items = all.filter(r => !r.disabled);
  if (!items.length) { out('  No git repository your agents have worked in was found. A cache starts with the first session in one; run thinker warmup again after that.'); later(); return; }
  // as the page: the most recently active with pull requests to read and no cache yet
  const picked = items.filter(r => r.canMine && !r.warmed && !r.hasCache).slice(0, PICKED);
  out(`\n  Your agents worked in these repositories, the most recently active first:\n`);
  const width = Math.min(44, Math.max(...items.map(r => r.name.length)));
  items.forEach((r, i) => out(row(r, i, picked, width)));
  let chosen;
  if (flags.repos) {
    const want = String(flags.repos).split(',').map(s => s.trim()).filter(Boolean);
    chosen = items.filter(r => want.includes(r.name) || want.includes(r.checkout) || want.includes(r.id));
    const missing = want.filter(w => !chosen.some(r => [r.name, r.checkout, r.id].includes(w)));
    if (missing.length) { out(`  Not on this machine's list: ${missing.join(', ')}`); process.exitCode = 1; return; }
  } else if (flags.yes) chosen = picked;
  else {
    for (;;) {
      const def = picked.length ? picked.map(r => items.indexOf(r) + 1).join(' ') : 'skip';
      const r = parseSelection(await ask(`\n  Repositories to warm up ${c.dim(`[${def}]`)} ${c.dim('(numbers, all, or skip)')}: `), items, picked);
      if (!process.stdin.isTTY) out('');
      if (r.error) { out(`  ${r.error}`); continue; }
      chosen = r.chosen; break;
    }
  }
  const noPrs = chosen.filter(r => !r.canMine);
  chosen = chosen.filter(r => r.canMine);
  if (noPrs.length) out(`  ${noPrs.map(r => r.name).join(', ')}: no merged pull requests to read; the cache there grows from your sessions.`);
  if (!chosen.length) { out('  Nothing to warm up.'); later(); return; }
  const seconds = chosen.reduce((a, r) => a + (r.estimates.full.seconds || 0), 0);
  out(`\n  Warming up ${chosen.length === 1 ? chosen[0].name : `${chosen.length} repositories`}, about ${formatDuration(seconds)} in all, one at a time. ${c.dim('Each is thinker setup --build; a cache is used as soon as it has notes.')}\n`);
  let failed = 0;
  for (const r of chosen) {
    const args = [cli, 'setup', '--build', '--yes', '--no-ui', '--no-benchmark', '--depth', 'full', '--full-repo', '--repo', r.checkout];
    if (flags.dry) { out(`  would run: thinker ${args.slice(1).join(' ')}`); continue; }
    out(`  ${c.bold(r.name)}`);
    const res = spawnSync(process.execPath, args, { cwd: r.checkout, stdio: 'inherit', env: { ...process.env, THINKER_INSTALLER: '1' } });
    if (res.status !== 0) { failed++; out(`  ${r.name}: the build did not finish (exit ${res.status}); run thinker setup --build there to retry.`); }
  }
  if (failed) process.exitCode = 1;
  if (!flags.dry) out(`\n  Done. ${c.dim('thinker ui shows each cache; thinker warmup warms more.')}`);
}

export const commands = { warmup: warmupCommand };
