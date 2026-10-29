// `thinker explain`: write, once, what each part of the agents' context is and why someone would cut it
// (part-explain.js), for the parts that have no explanation yet. The Save page's cards are these words;
// everything else on that page is a number, and a number cannot tell you what Artifact is.
//
// It is never run on its own: the page asks for it when a person opens the cards and agrees to the spend,
// and in a desktop app, where the hooks have no agent CLI to call, it is queued for the session's own
// model like the rest of the learning (session-work.js).
import { lastSnapshot, snapshotView } from '../context-snapshot.js';
import { discoverRepos } from '../machine.js';
import { mergeViews } from '../context-view.js';
import { Store } from '../store.js';
import { readExplains, missingExplains, explainParts, viewParts, PER_BATCH } from '../part-explain.js';
import { withinDailyCap } from '../maintain.js';
import { enqueueJob, recentAppSession } from '../session-work.js';
import { available } from '../llm.js';
import { formatTokens } from '../model-usage.js';

function mergedView(store, days) {
  let found = []; try { found = discoverRepos(store); } catch { return null; }
  const views = [];
  for (const r of found.filter(x => !x.disabled && x.sessions > 0)) {
    try { const v = lastSnapshot(new Store(r.checkout), days)?.view; if (v) views.push({ repo: r.id, name: r.name, checkout: r.checkout, view: v }); } catch {}
  }
  return views.length ? mergeViews(views) : null;
}

async function explainCommand({ store, flags, out, availableFn = available, enqueueFn = enqueueJob, appFn = recentAppSession, explainFn = explainParts, capFn = withinDailyCap }) {
  const days = Number(flags.days) || 30;
  const limit = Math.max(1, Number(flags.limit) || 24);
  // --keys: exactly the parts the page is showing, or about to show, in the order it named them (part-explain.js
  // `attachExplains` puts the key on every row). Without it, the heaviest waste first.
  const keys = String(flags.keys || '').split(',').map(k => k.trim()).filter(Boolean).slice(0, 80);
  // the kept report if there is one; only a first visit reads the transcripts. --all is every repository the
  // page merges, from the reports already kept: the parts are the same machine's, and the explanations are kept
  // for the machine, so one run covers every repository that lists them. A repository with no report yet is left
  // out rather than read here -- opening its page writes one.
  const view = flags.all ? mergedView(store, days) : (lastSnapshot(store, days)?.view || snapshotView(store, days));
  if (!view) { out('No context report has been made yet; open the Find Savings page or run `thinker context --refresh`.'); return; }
  const have = readExplains();
  const missing = keys.length
    ? (xs => keys.map(k => xs.get(k)).filter(p => p && !have[p.key]))(new Map(viewParts(view).map(p => [p.key, p])))
    : missingExplains(view, have).slice(0, limit);

  if (flags.json && !flags.write) { out(JSON.stringify({ have: Object.keys(have).length, missing: missing.length, parts: missing.map(p => ({ key: p.key, name: p.name, kind: p.kind })) }, null, 2)); return; }
  if (!missing.length) { out(`Every part of the last ${days} days is explained (${Object.keys(have).length} kept).`); return; }

  // In a desktop app there is no CLI with a login to call: queue it for the session's own model instead.
  if (!availableFn().length) {
    const app = appFn(store);
    if (app || process.env.THINKER_SESSION_QUEUE) {
      enqueueFn(store, 'explain', ['explain', '--repo', store.repo, '--days', String(days), ...(keys.length ? ['--keys', keys.join(',')] : ['--limit', String(limit)])]);
      out(`No agent CLI is signed in here, so this is queued for your ${app || 'app'} session to answer.`);
      return;
    }
    out('No model is available: sign in to an agent CLI, or set ANTHROPIC_API_KEY.');
    return;
  }

  const cap = capFn(store);
  if (!cap.ok) { out(`The day's token budget is used up (${formatTokens(cap.spent)} of ${formatTokens(cap.cap)}); try again tomorrow or raise maintain.dailyTokens.`); return; }

  if (!flags.quiet) out(`Explaining ${missing.length} part${missing.length === 1 ? '' : 's'} in ${Math.ceil(missing.length / PER_BATCH)} call${Math.ceil(missing.length / PER_BATCH) === 1 ? '' : 's'}…`);
  const r = await explainFn(store, missing, { model: flags.model, onError: (e, g) => { if (!flags.quiet) out(`  could not explain ${g.map(p => p.name).join(', ')}: ${String(e.message).slice(0, 120)}`); } });
  if (flags.json) { out(JSON.stringify({ saved: r.saved, failed: r.failed, tokens: r.tokens }, null, 2)); return; }
  out(`Explained ${r.saved} part${r.saved === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''} · ~${formatTokens(r.tokens)} tokens.`);
}

export const commands = { explain: explainCommand };
