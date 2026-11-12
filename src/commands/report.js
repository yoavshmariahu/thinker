// `thinker report`: the Report page in the terminal (report.js): the average tokens a prompt (one call to the model) cost here, week by
// week over the last six, by token type, by part of the context and by model (grouped by provider, with subtotals), in dollars at
// list prices, --total the week's sum instead of the average and --share each row as its share of the whole session; under it the cache's numbers.
import { reportView, renderReport, REPORT_WEEKS } from '../report.js';
import { findRepoSessions } from '../instruction-value.js';
import { readReport, writeReport, refreshReport, reportSources } from '../report-snapshot.js';
import { Store } from '../store.js';

async function reportCommand({ store, flags, out }) {
  const weeks = Math.max(1, Math.min(26, Number(flags.weeks) || REPORT_WEEKS));
  // --refresh: the report kept for the page made again (report-snapshot.js), which starts it in the background; --all
  // every repository the page lists whose report is not current, in this one process (the machine's log is parsed once)
  if (flags.refresh) {
    if (flags.all) {
      const { machineRepos, keptCheckouts } = await import('../ui/server.js');
      const repos = machineRepos(store, { checkouts: keptCheckouts()?.checkouts });
      // a repository whose sessions and records have not moved keeps the report it has, worked out again for nobody
      let n = 0, kept = 0;
      for (const r of repos) {
        try {
          const st = new Store(r.checkout);
          if (readReport(st, weeks)?.current) continue;
          const x = refreshReport(st, { weeks });
          if (x.kept) kept++; else if (!x.skipped) n++;
        } catch {}
      }
      if (!flags.quiet) out(`Report made again for ${n} of ${repos.length} repositories${kept ? `; ${kept} had moved on nothing and kept what they had` : ''}.`);
      return;
    }
    const r = refreshReport(store, { weeks });
    if (!flags.quiet) out(r.skipped ? 'A refresh is already running here.' : `Report kept for the last ${weeks} weeks.`);
    return;
  }
  // with the stamp of what it rests on, so the next refresh can keep it rather than add every record up again
  const { sessions, stamp, sessionsAt } = reportSources(store, { weeks });
  const v = reportView(store, { weeks, sessions });
  writeReport(store, weeks, v, { stamp, sessions: sessionsAt }); // what the page shows next
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  // dollars at list prices and nothing else, as on the page (the owner, 2026-11-08: "only costs"). --tokens, which counted
  // tokens instead from 2026-10-26, and --cost, which chose cost before that, are still accepted and change nothing; the
  // tokens are in --json
  for (const l of renderReport(v, { total: Boolean(flags.total), share: Boolean(flags.share) })) out(l);
  out(''); out(`thinker report${flags.tokens ? ' is in dollars at list prices (--tokens went on 2026-11-08; --json has the tokens);' : ''} --total sums each week, --share shows each row as its share of the whole session; \`thinker ui --tab report\` is the page.`);
}

export const commands = { report: reportCommand };
export { findRepoSessions };
