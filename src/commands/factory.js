// `thinker factory`: the Factory tab in the terminal (factory.js). The pipeline a session runs through -- Prompts,
// Think, Explore, Build, Verify, Merge -- with what each stage cost over the Report's window, the loops detected in the
// sessions (where work came back to an earlier stage, found by code), and the first-pass yield of the merged pull
// requests. It reads the report kept for the page (report-snapshot.js), so both doors show one computation; --refresh
// makes it again first; --json is the view the page reads.
import { renderFactory } from '../factory.js';
import { reportSnapshot, refreshReport } from '../report-snapshot.js';
import { REPORT_WEEKS } from '../report.js';

async function factoryCommand({ flags, store, out }) {
  const weeks = Math.max(1, Math.min(26, Number(flags.weeks) || REPORT_WEEKS));
  if (flags.refresh) { const r = refreshReport(store, { weeks }); if (r.skipped) out('A refresh is already running here; showing what is kept.'); }
  const v = reportSnapshot(store, weeks).view?.factory || null;
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  const diff = flags.diff === true ? 'profile' : flags.diff ? String(flags.diff) : null;
  if (diff && !['profile', 'compression'].includes(diff)) { out(`thinker factory: --diff takes profile or compression, not ${diff}`); process.exitCode = 2; return; }
  for (const l of renderFactory(v, { diff })) out(l);
  out('', 'thinker factory --refresh reads the sessions again first, --diff profile|compression splits the figures by a feature\'s two sides, --json is the view the page reads; `thinker ui --tab factory` is the page.');
}

export const commands = { factory: factoryCommand };
