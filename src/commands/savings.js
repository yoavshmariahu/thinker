// `thinker savings`: what the footers say, said in full. The one-line figures the Claude Code
// statusline, the Codex desktop card, the Cursor table and the end-of-turn line carry are a total;
// this is where the split, the coverage and the caveat live, so a number nobody can check is never
// the only thing a person is given (savings-ledger.js).
//
// --refresh is what the Stop hook starts in the background: it recomputes the ledger and says nothing
// with --quiet. Without --refresh the kept ledger is printed, and computed first where there is none.
import { computeSavings, readSavings, refreshSavings, savingsDetail, savingsLine, writeSavings, REFRESH_MS } from '../savings-ledger.js';
import { formatDollars, PRICED_ON } from '../prices.js';
import { formatTokens } from '../model-usage.js';

const ago = ms => (ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3600_000)}h ago`);

async function savingsCommand({ store, flags, out }) {
  if (flags.refresh) {
    const l = refreshSavings(store, { force: true });
    if (!flags.quiet) out(savingsLine(l) || 'No savings recorded yet.');
    return;
  }
  const kept = readSavings(store);
  const l = kept?.current ? kept : writeSavings(store, computeSavings(store));
  if (flags.json) { out(JSON.stringify(l, null, 2)); return; }
  const line = savingsLine(l);
  if (!line) { out('No savings recorded yet. thinker counts them as notes are served and as the context proxy clears.'); return; }
  out(`thinker savings · ${line}`);
  out('');
  for (const [label, cell] of [['Today', l.today], ['Lifetime', l.lifetime]]) {
    out(`  ${label.padEnd(9)} ~${formatDollars(cell.cost).padEnd(8)} ${savingsDetail(cell)}`);
    if (cell.unpricedTokens) out(`  ${' '.repeat(9)} ~${formatTokens(cell.unpricedTokens)} tokens on models nobody priced are not in the total`);
  }
  out('');
  out(`  Counted over every repository on this machine${l.from ? `, from ${String(l.from).slice(0, 10)}` : ''}; read ${ago(Date.now() - l.at)}, refreshed every ${Math.round(REFRESH_MS / 60_000)} min while you work.`);
  // The caveat is the point of the command: these are the Report page's own two series, which is the
  // only reason a dollar figure is said at all (prices.js, savings-ledger.js).
  out(`  An API-list-price equivalent at the providers' rates as published on ${PRICED_ON}, not a bill: cache hits price the reading`);
  out('  the agents did not have to do, context cleared prices prompt text they did not read again. `thinker report` has the week-by-week table.');
}

export const commands = { savings: savingsCommand };
