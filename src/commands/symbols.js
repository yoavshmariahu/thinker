// `thinker symbols`: the definition index this checkout keeps under .thinker/state/symbols (symbols.js).
// `build` is also what a lookup starts in the background when the table is missing or too far behind.
import { buildTable, refreshTable, tableStats, symbolTableConfig } from '../symbols.js';

const mb = n => `${(n / 1e6).toFixed(1)} MB`;
const secs = ms => `${(ms / 1000).toFixed(1)}s`;

async function symbolsCommand({ pos, flags, repo, out }) {
  const sub = pos[0] || 'show';
  const cfg = symbolTableConfig(repo);
  if (sub === 'build') {
    const quiet = flags.quiet === true;
    const meta = buildTable(repo, {
      ...(flags['max-files'] ? { maxFiles: Number(flags['max-files']) } : {}),
      ...(flags['build-ms'] ? { buildMs: Number(flags['build-ms']) } : {}),
      onProgress: quiet ? undefined : p => process.stderr.write(`\rthinker symbols: ${p.files}/${p.of} files, ${p.symbols} symbols`),
    });
    if (!quiet) process.stderr.write('\r');
    if (meta.error) { out(`thinker symbols: ${meta.error}`); process.exitCode = 1; return; }
    if (!quiet) out(`Built in ${secs(meta.buildMs)}: ${meta.files} files, ${meta.symbols} symbols, ${mb(meta.bytes)} on disk${meta.truncated ? ` (truncated at the build's bound: ${meta.tracked} code files are tracked)` : ''}${meta.skipped ? `, ${meta.skipped} files skipped (unreadable or over ${cfg.maxFileBytes} bytes)` : ''}.`);
    return;
  }
  if (sub === 'refresh') {
    const r = refreshTable(repo, { sweep: 'inline' });
    if (!r.ok) { out('thinker symbols: no table here yet; run `thinker symbols build`.'); return; }
    out(`Refreshed: ${r.refreshed} file(s) outlined again, ${r.delta} in the delta, ${r.removed} gone.`);
    return;
  }
  const st = tableStats(repo);
  if (!st) { out(`No symbol table in ${repo}. Run \`thinker symbols build\`.${cfg.enabled ? '' : ' Lookups will not use it until `symbolTable: {"enabled": true}` is in .thinker/config.json.'}`); return; }
  out([
    `Symbol table  ${cfg.enabled ? 'on' : 'off (symbolTable.enabled is false, so lookups still scan with git grep)'}`,
    `  built       ${st.built} in ${secs(st.buildMs)}${st.truncated ? ' (truncated)' : ''}`,
    `  covers      ${st.files} files, ${st.symbols} symbols, ${mb(st.bytes)} on disk`,
    `  changed     ${st.delta} file(s) outlined again since, ${st.removed} gone`,
    `  sweep       ${st.sweepMs === null ? 'unmeasured' : `${st.sweepMs} ms`} (inline while under ${cfg.sweepMs} ms)`,
  ].join('\n'));
}

export const commands = { symbols: symbolsCommand };
