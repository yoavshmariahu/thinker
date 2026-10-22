// `thinker report`: the Report page in the terminal (report.js): the average tokens a session cost here, week by
// week over the last five, by part of the context and by model (grouped by provider, with subtotals), with --cost
// the same at list prices and --aggregate the week's sum instead of the average; under it the decisions taken on the Save page in the window, and the cache's numbers.
import { reportView, renderReport, REPORT_WEEKS } from '../report.js';
import { findRepoSessions } from '../instruction-value.js';

async function reportCommand({ store, flags, out }) {
  const weeks = Math.max(1, Math.min(26, Number(flags.weeks) || REPORT_WEEKS));
  const v = reportView(store, { weeks });
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderReport(v, { cost: Boolean(flags.cost), aggregate: Boolean(flags.aggregate) })) out(l);
  if (!flags.cost) out('', 'thinker report --cost prices the same at the providers\' list rates, --aggregate sums each week; `thinker ui --tab report` is the page.');
}

export const commands = { report: reportCommand };
export { findRepoSessions };
