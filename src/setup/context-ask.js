// The installer's question on the Context report (context-machine.js): what to cut first, as an arrow-key multi-select
// of the suggested actions (Compress or Remove a section, Switch off a skill or tool), made through the function behind
// `thinker context --approve` (context-suggest.js:approveChanges). They come checked: unchecking what should be kept is
// the work, not finding what thinker meant. Nothing is changed until the person presses Enter; Esc, or Enter with
// nothing left checked, skips. Without a terminal to ask in the report is printed as `thinker context --machine`
// prints it.
//
// Until 2026-11-21 it first asked where to look, in the browser (the page's Find Savings over every repository, with
// these suggestions checked) or here. That page was removed at the owner's direction (thinker makes these decisions
// itself from then on), and the browser answer went with it: the terminal list is the question.
import { multiSelect, withSpinner, c } from './ui.js';
import { renderMachineSummary, renderMachineCuts, renderMachineReport, machineChanges, pickLine, pickNote, applyMachinePicks } from '../context-machine.js';

// `r`, `recs`: context-machine.js:machineContext and recommendations. `store` is accepted and not used (the page it
// started is gone); what is left of the options goes to `apply`.
// Returns what happened: { mode: 'printed' | 'terminal', picked, said }.
export async function askMachineReport({ r, recs, store, out = console.log, stdin = process.stdin, stdout = process.stdout, apply = applyMachinePicks, multi = multiSelect, ...opts } = {}) {
  const interactive = Boolean(stdin?.isTTY && stdout?.isTTY);
  if (!interactive || !r.view) { for (const l of renderMachineReport(r, recs)) out(l); return { mode: 'printed' }; }
  for (const l of renderMachineSummary(r)) out(l);
  for (const l of renderMachineCuts(r, recs, { actions: false })) out(l);
  const all = machineChanges(r, recs), picks = all.filter(p => p.targets.length);
  out(`  Every part with its figures: ${c.cyan('thinker context')}`);
  if (!picks.length) return { mode: 'terminal', picked: [], said: [] };
  out('');
  // The suggestions come checked: the question is whether to make the changes thinker suggests, so the work is
  // unchecking the ones they want kept, not finding the ones it meant. Nothing is applied by arriving here -- Esc
  // skips, `n` clears them all, and Enter is the Apply.
  const chosen = await multi({
    header: `  ${c.bold('Apply the checked?')} ${c.dim('A skill or MCP server is switched off for that repository from the next session; a built-in tool gets a tool reference for every repository and can still be used; a section is rewritten in the background and opens a pull request in its own repository (the file where there is no GitHub origin). Each can be followed and reverted from Recent activity on the page (thinker ui), or with thinker context --history.')}`,
    hint: '↑/↓ move, Space unchecks, n clears all, Enter applies the checked, Esc skips',
    items: all.map(p => p.targets.length ? { label: pickLine(p), note: `· ${pickNote(p)}`, value: p, picked: true } : { label: pickLine(p), note: '· nothing switches it off per repository; its figures are in thinker context', disabled: true, value: p }), out, stdin, stdout,
  });
  const picked = (chosen || []).map(x => x.value);
  if (!picked.length) { out(`  Nothing changed. The suggestions stay in ${c.cyan('thinker context')}.`); return { mode: 'terminal', picked: [], said: [] }; }
  const n = picked.length, calls = picked.filter(p => p.act === 'compress').length;
  const said = await withSpinner(out, `Applying ${n} change${n === 1 ? '' : 's'}${calls ? `, ${calls} of them a rewrite started in the background` : ''}`, () => apply(picked, { via: 'setup', ...opts }));
  for (const l of said) out(`  ${c.green('✓')} ${l}`);
  if (picked.some(p => p.act !== 'off')) out(`  ${c.dim('A section\'s rewrite goes on in the background: its pull request, or the file it wrote, is under Recent activity on the page (thinker ui).')}`);
  return { mode: 'terminal', picked, said };
}
