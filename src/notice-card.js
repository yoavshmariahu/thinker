// Codex desktop renders local fragments referenced in the assistant's final answer. A stop
// warning cannot create that answer content, so supply the reference when notes reach the agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { desktopApp, subagentHarness } from './app-host.js';
import { cacheHitSavings, formatTokens } from './usage.js';

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
    if (holdout || !notes.length || !noticeCardOn(store, client)) return '';
    const unique = [...new Map(notes.map(n => [n.id, n])).values()];
    const linked = session && session !== 'unknown' && turn > 0;
    const key = linked ? createHash('sha256').update(JSON.stringify([session, turn])).digest('hex').slice(0, 24) : randomUUID();
    const file = path.resolve(store.dir, 'state', 'notice-cards', `${key}.html`);
    const exists = fs.existsSync(file);
    if (updateOnly && !exists) return '';
    const { calls, tokens } = cacheHitSavings(store.repo, unique);
    const counts = [`${unique.length} ${unique.length === 1 ? 'note' : 'notes'} ${linked ? 'this turn' : 'retrieved'}`, calls ? `${calls} ${calls === 1 ? 'file' : 'files'}` : '', tokens ? `~${formatTokens(tokens)} tokens of code` : ''].filter(Boolean).join(' · ');
    const html = `<section id="thinker-${key}" aria-label="Thinker cache hit">
  <div class="card">
    <div class="viz-row"><span aria-hidden="true">🧠</span><strong style="font-weight:500">Thinker</strong><span class="viz-badge">Cache hit</span></div>
    <p class="tabular-nums">${counts}</p>
    <details><summary class="cursor-interaction">Retrieved notes</summary>
      <ul>${unique.map(n => `<li>${escape(n.title || n.id)}${n.status === 'stale' ? ' — dependency changed; verify before use' : ''}</li>`).join('')}</ul>
      ${tokens ? '<p class="text-small">Code size estimate, not measured tokens saved.</p>' : ''}
    </details>
  </div>
</section>
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, html); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    if (exists || updateOnly) return '';
    return `<thinker-notice>Thinker retrieved cached notes for this turn. At the end of your final answer, include the following display reference on its own line, once, without a code fence. It renders the cache-hit notice automatically; do not ask the user to request or approve it. Use only the latest reference from this turn, never one from a previous turn. Do not call tools just to display it.\nvisualize${JSON.stringify({ path: file })}\n</thinker-notice>`;
  } catch { return ''; } // Presentation must never break retrieval or learning.
}
