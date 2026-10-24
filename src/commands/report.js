// `thinker report`: the Report page in the terminal (report.js): the average tokens a prompt (one call to the model) cost here, week by
// week over the last six, by token type, by part of the context and by model (grouped by provider, with subtotals), with --cost
// the same at list prices, --total the week's sum instead of the average and --share each row as its share of the whole session; under it the cache's numbers.
import { reportView, renderReport, REPORT_WEEKS } from '../report.js';
import { findRepoSessions } from '../instruction-value.js';
import { readReport, writeReport, refreshReport } from '../report-snapshot.js';
import { Store } from '../store.js';

async function reportCommand({ store, flags, out }) {
  const weeks = Math.max(1, Math.min(26, Number(flags.weeks) || REPORT_WEEKS));
  // --refresh: the report kept for the page made again (report-snapshot.js), which starts it in the background; --all
  // every repository the page lists whose report is not current, in this one process (the machine's log is parsed once)
  if (flags.refresh) {
    if (flags.all) {
      const { machineRepos, keptCheckouts } = await import('../ui/server.js');
      const repos = machineRepos(store, { checkouts: keptCheckouts()?.checkouts });
      let n = 0;
      for (const r of repos) { try { const st = new Store(r.checkout); if (!readReport(st, weeks)?.current && !refreshReport(st, { weeks }).skipped) n++; } catch {} }
      if (!flags.quiet) out(`Report kept for ${n} of ${repos.length} repositories.`);
      return;
    }
    const r = refreshReport(store, { weeks });
    if (!flags.quiet) out(r.skipped ? 'A refresh is already running here.' : `Report kept for the last ${weeks} weeks.`);
    return;
  }
  const v = reportView(store, { weeks });
  writeReport(store, weeks, v); // what the page shows next
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderReport(v, { cost: Boolean(flags.cost), total: Boolean(flags.total), share: Boolean(flags.share) })) out(l);
  if (!flags.cost) out('', 'thinker report --cost prices the same at the providers\' list rates, --total sums each week, --share shows each row as its share of the whole session; `thinker ui --tab report` is the page.');
}

export const commands = { report: reportCommand };
export { findRepoSessions };
