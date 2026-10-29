// The installer's question on the Context report (context-machine.js): where to look at what to cut first, in the
// browser (the page's Context tab over every repository) or here in the terminal. In the terminal the suggestions
// are an arrow-key multi-select of the actions the page's rows would take (Compress or Remove a section, Switch off a
// skill or tool), made through the function behind the page's Apply and `thinker context --approve`
// (context-suggest.js:approveChanges), with the page's address beside them for the detail. In the browser the page
// opens on All with the same suggestions checked (context-machine.js:suggestedPicks, page.html:preselectRows), and in
// the terminal they come checked too: unchecking what should be kept is the work, not finding what thinker meant.
// Nothing is changed until the person presses Enter; Esc, or Enter with nothing left checked, skips. Without a
// terminal to ask in the report is printed as `thinker context --machine` prints it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectMenu, multiSelect, withSpinner, c } from './ui.js';
import { renderMachineSummary, renderMachineCuts, renderMachineReport, machineChanges, pickLine, pickNote, applyMachinePicks } from '../context-machine.js';
import { ensureUi, suggestionsUrl } from '../context-suggest.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

// a browser on this machine's display: not in a test or CI, not over ssh, and macOS, Windows or a display named
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.THINKER_TEST || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  return platform === 'darwin' || platform === 'win32' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// the page on the Context tab over every repository, detached, as the installer opened it at its end before
// (cache.js:uiCommand, --from-setup opens the browser itself and exits once idle)
export function openContextPage({ store, cliPath = CLI, spawnFn = spawn, all = true } = {}) {
  try {
    const child = spawnFn(process.execPath, [cliPath, 'ui', '--from-setup', '--tab', 'save', ...(all ? [] : ['--here'])], { cwd: store.repo, detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); child.unref?.();
    return true;
  } catch { return false; }
}

export const ASK_WHERE = [
  { label: 'In the browser', note: 'the page on this machine, every part with its figures and history', value: 'browser', key: 'b' },
  { label: 'Here in the terminal', note: 'the suggestions as a list to pick from, with the page\'s address for the detail', value: 'terminal', key: 't' },
];

// `r`, `recs`: context-machine.js:machineContext and recommendations. `browser`: whether the browser can be offered.
// Returns what happened: { mode: 'printed' | 'browser' | 'terminal', picked, said }.
export async function askMachineReport({ r, recs, store, out = console.log, browser = canOpenBrowser(), stdin = process.stdin, stdout = process.stdout, ui = ensureUi, open = openContextPage, apply = applyMachinePicks, select = selectMenu, multi = multiSelect, ...opts } = {}) {
  const interactive = Boolean(stdin?.isTTY && stdout?.isTTY);
  if (!interactive || !r.view) { for (const l of renderMachineReport(r, recs)) out(l); return { mode: 'printed' }; }
  for (const l of renderMachineSummary(r)) out(l);
  let where = 'terminal';
  if (browser) {
    out('');
    const pick = await select({ header: `  ${c.bold('See what to cut first')}`, hint: '↑/↓ move, Enter picks', items: ASK_WHERE.map(x => ({ ...x, label: `${x.label} ${c.dim(`· ${x.note}`)}` })), out, stdin, stdout });
    where = pick?.value || 'terminal';
  }
  if (where === 'browser') {
    const opened = open({ store });
    out(opened ? `  Opening the Find Savings page in your browser (every repository, All) with the suggested savings already checked: review their actions and press Apply, or uncheck them. It stays open in the background; close the tab when done.` : '  The page could not be started; its suggestions are below.');
    if (opened) return { mode: 'browser' };
  }
  for (const l of renderMachineCuts(r, recs, { actions: false })) out(l);
  const all = machineChanges(r, recs), picks = all.filter(p => p.targets.length);
  // the page for the detail: every part with its figures, started now for this machine, gone once idle
  let url = null; try { url = ui(store); } catch {}
  if (url) out(`  Every part with its figures, and the decisions so far: ${c.cyan(suggestionsUrl(url, null, { from: 'setup' }))} (the same suggestions checked there)`);
  if (!picks.length) return { mode: 'terminal', picked: [], said: [] };
  out('');
  // The suggestions come checked, as they do on the page the browser answer opens (page.html:preselectRows): the
  // question is whether to make the changes thinker suggests, so the work is unchecking the ones they want kept, not
  // finding the ones it meant. Nothing is applied by arriving here -- Esc skips, `n` clears them all, and Enter is
  // the Apply.
  const chosen = await multi({
    header: `  ${c.bold('Apply the checked?')} ${c.dim('A skill or tool is switched off for that repository from the next session; a section is rewritten in the background and opens a pull request in its own repository (the file where there is no GitHub origin). Each can be followed and reverted from the page\'s Recent activity.')}`,
    hint: '↑/↓ move, Space unchecks, n clears all, Enter applies the checked, Esc skips',
    items: all.map(p => p.targets.length ? { label: pickLine(p), note: `· ${pickNote(p)}`, value: p, picked: true } : { label: pickLine(p), note: '· nothing switches it off per repository; its figures are on the page', disabled: true, value: p }), out, stdin, stdout,
  });
  const picked = (chosen || []).map(x => x.value);
  if (!picked.length) { out(`  Nothing changed. The suggestions stay on the page${url ? '' : ' (thinker ui)'}.`); return { mode: 'terminal', picked: [], said: [] }; }
  const n = picked.length, calls = picked.filter(p => p.act === 'compress').length;
  const said = await withSpinner(out, `Applying ${n} change${n === 1 ? '' : 's'}${calls ? `, ${calls} of them a rewrite started in the background` : ''}`, () => apply(picked, { via: 'setup', ...opts }));
  for (const l of said) out(`  ${c.green('✓')} ${l}`);
  if (picked.some(p => p.act !== 'off')) out(`  ${c.dim('A section\'s rewrite goes on in the background: its pull request, or the file it wrote, is on the page under Recent activity.')}`);
  return { mode: 'terminal', picked, said };
}
