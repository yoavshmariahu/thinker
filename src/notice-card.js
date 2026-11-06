// Codex desktop renders local fragments referenced in the assistant's final answer. A stop
// warning cannot create that answer content, so supply the reference when notes reach the agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { desktopApp, subagentHarness } from './app-host.js';
import { cacheHitSavings, formatTokens } from './usage.js';
import { CARD_TOOLS, compressionDir, compressionSaving, compressionTools, markCompressionTurn } from './compression.js';
import { noticeDue, noticeShown } from './notice-cadence.js';
import { readSavings, savingsDetail, savingsLine } from './savings-ledger.js';

export function noticeCardOn(store, client, { env = process.env, app = () => desktopApp('codex') } = {}) {
  const cfg = store.config();
  if (env.THINKER_NOTICE === 'off' || cfg.notice === false || cfg.notice === 'off') return false;
  if (env.THINKER_NOTICE_CARD === 'off' || env.THINKER_NOTICE_CARD === '0') return false;
  if (subagentHarness(client) !== 'codex' && client !== 'mcp') return false;
  // Explicit env opt-in is also usable by isolated tests; repository opt-in needs a desktop host.
  return env.THINKER_NOTICE_CARD === '1' || (cfg.noticeCard === true && Boolean(app()));
}
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function noticeCard(store, { client, session, turn, holdout, notes = [], updateOnly = false } = {}) {
  try {
    if (holdout || !noticeCardOn(store, client)) return '';
    // what the context proxy's clearing has left out of this session's prompts, once it has had a few turns
    // to pay for itself (compression.js); a session the proxy cleared nothing from shows no such section
    let saving = null, cleared = null;
    try { cleared = markCompressionTurn(compressionDir(), session, turn); saving = compressionSaving(cleared); } catch {}
    if (!notes.length && !saving) return '';
    const unique = [...new Map(notes.map(n => [n.id, n])).values()];
    const linked = session && session !== 'unknown' && turn > 0;
    const key = linked ? createHash('sha256').update(JSON.stringify([session, turn])).digest('hex').slice(0, 24) : randomUUID();
    const file = path.resolve(store.dir, 'state', 'notice-cards', `${key}.html`);
    const exists = fs.existsSync(file);
    if (updateOnly && !exists) return '';
    // One card per summary, not one a turn (notice-cadence.js): a card whose reference is already in
    // this turn's answer is kept up to date, but a new one waits for the next summary to come due.
    // It speaks for the turn it is drawn in; what the held turns served is in `thinker usage`.
    if (!exists && !noticeDue(store).due) return '';
    const { calls, tokens } = unique.length ? cacheHitSavings(store.repo, unique) : { calls: 0, tokens: 0 };
    const counts = [`${unique.length} ${unique.length === 1 ? 'note' : 'notes'} ${linked ? 'this turn' : 'retrieved'}`, calls ? `${calls} ${calls === 1 ? 'file' : 'files'}` : '', tokens ? `Estimated tokens saved: ~${formatTokens(tokens)}` : ''].filter(Boolean).join(' · ');
    const hit = !unique.length ? '' : `  <div class="card">
    <div class="viz-row"><span aria-hidden="true">🧠</span><strong style="font-weight:500">Thinker</strong><span class="viz-badge">Cache hit</span></div>
    <p class="tabular-nums">${counts}</p>
    <details><summary class="cursor-interaction">Retrieved notes</summary>
      <ul>${unique.map(n => `<li>${escape(n.title || n.id)}${n.status === 'stale' ? ' — verify before use' : n.status === 'pending' ? ' — pending verification' : ''}</li>`).join('')}</ul>
      ${tokens ? '<p class="text-small">Estimated from the code files these notes point to; actual token savings are not measured.</p>' : ''}
    </details>
  </div>
`;
    const compressed = !saving ? '' : `  <div class="card">
    <div class="viz-row"><span aria-hidden="true">🗜</span><strong style="font-weight:500">Thinker</strong><span class="viz-badge">Context cleared</span></div>
    <p class="tabular-nums">~${formatTokens(saving.saved)} tokens not re-read · ${saving.requests} ${saving.requests === 1 ? 'call' : 'calls'} · ${saving.uses} tool ${saving.uses === 1 ? 'result' : 'results'} cleared</p>
    <details><summary class="cursor-interaction">What was cleared, and how this is counted</summary>
      ${compressionTools(cleared, formatTokens, { limit: CARD_TOOLS }) ? `<p class="text-small">Out of the prompt now, by the action that fetched it: ${escape(compressionTools(cleared, formatTokens, { limit: CARD_TOOLS }))}.</p>` : ''}
      <p class="text-small">The tokens the API left out of each prompt since the clear, added up, as it reported them. Clearing also writes the prompt cache again; <code>thinker proxy replay</code> prices that.</p>
    </details>
  </div>
`;
    // The money under the cards: saved today and over the whole log, read off the kept ledger
    // (savings-ledger.js). Codex desktop is the one client with no statusline thinker can pin, so the
    // figures ride the card here as they ride the summary line elsewhere. The split is behind the
    // summary, never the total alone, and the caveat with it.
    const l = (() => { try { return readSavings(store); } catch { return null; } })();
    const money = savingsLine(l);
    const savings = !money ? '' : `  <div class="card">
    <div class="viz-row"><span aria-hidden="true">💰</span><strong style="font-weight:500">Thinker</strong><span class="viz-badge">Saved</span></div>
    <p class="tabular-nums">${escape(money)}</p>
    <details><summary class="cursor-interaction">What this counts</summary>
      <p class="text-small">Today: ${escape(savingsDetail(l.today))} — notes already served, less any a session said it did not use.</p>
      <p class="text-small">Lifetime: ${escape(savingsDetail(l.lifetime))}, over every repository on this machine — servings a finished session confirmed, as <code>thinker report</code> counts them.</p>
      <p class="text-small">An API-list-price equivalent at the providers' published rates, not a bill: the same two series as <code>thinker report</code>. <code>thinker savings</code> prints them in full.</p>
    </details>
  </div>
`;
    const html = `<section id="thinker-${key}" aria-label="Thinker">
${hit}${compressed}${savings}</section>
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, html); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    if (exists || updateOnly) return '';
    noticeShown(store);
    return `<thinker-notice>Thinker has something to show for this turn. At the end of your final answer, include the following display reference on its own line, once, without a code fence. It renders the notice automatically; do not ask the user to request or approve it. Use only the latest reference from this turn, never one from a previous turn. Do not call tools just to display it.\nvisualize${JSON.stringify({ path: file })}\n</thinker-notice>`;
  } catch { return ''; } // Presentation must never break retrieval or learning.
}
