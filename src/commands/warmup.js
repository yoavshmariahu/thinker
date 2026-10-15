// thinker warmup: the warm-up offered in the terminal. The installer runs it last; `thinker warmup` runs it
// again. One question, browser or here, then one multi-select of repositories, with skip. A machine with no
// display (ssh, a container) is not offered the browser: the page binds 127.0.0.1 of this machine, and
// before 2026-10-12 the installer launched it anyway, said it had opened, and five of seven installs that
// day never warmed a cache. The terminal path takes the page's defaults: full depth, the whole repository,
// the agent already logged in. Before building, an arrow-key menu lets the person change harness.
import fs from 'node:fs';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { warmupCandidates, warmupCandidate } from '../machine.js';
import { selectMenu, multiSelect, c, formatDuration, withSpinner } from '../setup/ui.js';
import { DEFAULT_DEPTH } from '../setup/estimate.js';
import { buildAgent, selectAndAuthenticateAgent } from '../setup/agents.js';
import { useBuildModel } from '../setup/models.js';
import { answerWarmup } from '../repo-onboard.js';
import { Store, findRepoRoot } from '../store.js';

export const SHOWN = 10, PICKED = 5; // as the page: ten rows, the five most recently active with no cache yet picked

export function headless(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

const rowNote = r => {
  const est = r.estimates[DEFAULT_DEPTH];
  const what = est.prs ? `~${formatDuration(est.seconds)}, ${est.prs} pull requests` : 'no merged pull requests to read';
  const tags = [r.current ? 'current' : '', r.warmed ? 'warmed before' : r.hasCache ? `${r.notes} notes already` : ''].filter(Boolean).join(', ');
  return `${what}${tags ? ` · ${tags}` : ''}`;
};
const row = (r, picked, width) => `    ${picked.includes(r) ? c.cyan('[x]') : c.dim('[ ]')} ${r.name.padEnd(width)} ${c.dim(rowNote(r))}`;

export async function warmupCommand(ctx, { selectAgentFn = selectAndAuthenticateAgent,
  candidatesFn = warmupCandidates, candidateFn = warmupCandidate, spawnFn = spawnSync } = {}) {
  const { flags, store, out, HERE } = ctx;
  const cli = path.join(HERE, 'cli.js');
  const ask = async q => { const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } };
  const later = () => out(`  Warm up caches any time: ${c.cyan('thinker warmup')} here, or ${c.cyan('thinker ui')} in the browser.`);

  // the person's answer to the offer the hooks gave their agent (repo-onboard.js:warmupOffer), from the agent's
  // own question tool: thinker records it and, on warm, starts the warm-up itself
  if (flags.answer) {
    const s = flags.repos ? new Store(findRepoRoot(String(flags.repos))) : store;
    if (!s.exists()) { out('  No thinker cache here: run this from the repository the offer was about.'); process.exitCode = 1; return; }
    out(await answerWarmup(s, String(flags.answer).toLowerCase(), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' }));
    return;
  }
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
  const all = await withSpinner(out, 'Looking at the repositories your agents work in', async () => candidatesFn(store, {}));
  const items = all.filter(r => !r.disabled).slice(0, SHOWN);
  if (!items.length) { out('  No git repository your agents have worked in was found. Run thinker warmup inside one to warm it up; a cache also starts by itself with the first session there.'); later(); return; }
  // as the page: the most recently active with pull requests to read and no cache yet
  const picked = items.filter(r => r.canMine && !r.warmed && !r.hasCache).slice(0, PICKED);
  out(`\n  Your agents worked in these repositories, the most recently active first. A warm-up reads merged pull requests into notes, around where you are most active:\n`);
  const width = Math.min(44, Math.max(...items.map(r => r.name.length)));
  let chosen;
  if (flags.repos) {
    for (const r of items) out(row(r, picked, width));
    // by name, id or path from the list, or the path of any git checkout the list does not have (machine.js:warmupCandidate):
    // a fresh clone the agents have not worked in, which the agent's offer on the first session there names this way
    const want = String(flags.repos).split(',').map(s => s.trim()).filter(Boolean);
    const real = w => { try { return fs.realpathSync(path.resolve(w)); } catch { return null; } };
    chosen = []; const missing = [];
    for (const w of want) {
      const listed = all.find(r => !r.disabled && (w === r.name || w === r.id || w === r.checkout || real(w) === r.checkout));
      const c = listed || (/[\/\\]|^[.~]/.test(w) ? candidateFn(store, w) : null);
      if (!c || c.disabled) missing.push(w); else if (!chosen.some(r => r.checkout === c.checkout)) chosen.push(c);
    }
    if (missing.length) { out(`  Not a git repository on this machine: ${missing.join(', ')}`); process.exitCode = 1; return; }
  } else if (flags.yes || !picked.length) { for (const r of items) out(row(r, picked, width)); chosen = picked; }
  else if (process.stdin.isTTY) {
    // arrows move, Space toggles, Enter starts; a row with nothing to read cannot be picked
    const rows = items.map(r => ({ r, label: r.name.padEnd(width), picked: picked.includes(r), disabled: !r.canMine, note: rowNote(r) }));
    const got = await multiSelect({ items: rows, out });
    chosen = (got || []).map(x => x.r);
    out(chosen.length ? `  Picked: ${chosen.map(r => r.name).join(', ')}` : '  Nothing picked.');
    if (!chosen.length) { later(); return; }
  } else {
    for (const r of items) out(row(r, picked, width));
    const a = (await ask(`\n  Warm up the ${picked.length === 1 ? 'picked repository' : `${picked.length} picked`} ${c.dim('[Y/n]')}: `)).trim().toLowerCase();
    out('');
    chosen = ['', 'y', 'yes'].includes(a) ? picked : [];
    if (!chosen.length) { out('  Skipped.'); later(); return; }
  }
  const noPrs = chosen.filter(r => !r.canMine);
  chosen = chosen.filter(r => r.canMine);
  if (noPrs.length) out(`  ${noPrs.map(r => r.name).join(', ')}: no merged pull requests to read; the cache there grows from your sessions.`);
  if (!chosen.length) { out('  Nothing to warm up.'); later(); return; }
  const requestedAgent = flags.agent || process.env.THINKER_LLM || null;
  const auth = flags.dry ? { ok: true, agent: requestedAgent || buildAgent() }
    : await selectAgentFn({ requestedAgent, yes: !!flags.yes, out, purpose: 'warm up these repositories', allowSkip: false });
  if (!auth.ok) {
    if (auth.error === 'cancelled') out('  Warm-up skipped.');
    else process.exitCode = 1;
    later(); return;
  }
  const model = useBuildModel({ agent: auth.agent, model: flags.model, out });
  const seconds = chosen.reduce((a, r) => a + (r.estimates[DEFAULT_DEPTH].seconds || 0), 0);
  out(`\n  Warming up ${chosen.length === 1 ? chosen[0].name : `${chosen.length} repositories`}, about ${formatDuration(seconds)} in all, one at a time. ${c.dim('Each is thinker setup --build; the hooks serve a cache once it holds a few notes.')}\n`);
  let failed = 0;
  for (const r of chosen) {
    // --yes takes the person's areas when there are any (setup/project.js), the whole repository otherwise
    const args = [cli, 'setup', '--build', '--yes', '--no-ui', '--no-benchmark', '--depth', DEFAULT_DEPTH, '--repo', r.checkout];
    if (auth.agent) args.push('--agent', auth.agent);
    args.push('--model', model);
    if (flags.dry) { out(`  would run: thinker ${args.slice(1).join(' ')}`); continue; }
    out(`  ${c.bold(r.name)}`);
    const res = spawnFn(process.execPath, args, { cwd: r.checkout, stdio: 'inherit', env: { ...process.env, THINKER_INSTALLER: '1' } });
    if (res.status !== 0) { failed++; out(`  ${r.name}: the build did not finish (exit ${res.status}); run thinker setup --build there to retry.`); }
  }
  if (failed) process.exitCode = 1;
  if (!flags.dry) out(`\n  Done. ${c.dim('thinker ui shows each cache; thinker warmup warms more.')}`);
}

export const commands = { warmup: warmupCommand };
