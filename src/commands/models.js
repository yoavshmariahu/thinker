// `thinker models`: the models reachable beyond the agent's own login (providers.js), the routes that name them,
// the subagents that run on them (model-agents.js), and the profile of how each did (model-profile.js).
import path from 'node:path';
import { readRegistry, writeRegistry, addProvider, recordProbe, removeProvider, setRoute, dropRoute, probeProvider, storeKey, keyFileFor, resolveRoute, isRouteId, FORMATS } from '../providers.js';
import { installAgents, TEMPLATES, isAgentName } from '../model-agents.js';
import { installExploreAgent } from '../explore-agent.js';
import { updateMachineConfig } from '../repo-switch.js';
import { refreshProfile, readProfile, profileView, renderProfile } from '../model-profile.js';
import { thinkerHome } from '../update.js';
import { isGitCheckout } from '../store.js';
import { formatDollars } from '../prices.js';

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
const rel = f => f.replace(process.env.HOME || '\0', '~');

function listLines(reg) {
  const out = [];
  const ps = Object.entries(reg.providers);
  if (!ps.length) out.push('No providers registered. thinker models add <id> <url> --key-env NAME (or --key-file, --key) registers a gateway or a provider and probes it.');
  for (const [id, p] of ps) {
    const models = Object.keys(p.models || {}), priced = models.filter(m => p.models[m]?.price).length;
    out.push(`${id}: ${p.url}  speaks ${p.formats?.length ? p.formats.join(', ') : 'nothing the proxy forwards yet'}  ${models.length} models${priced ? ` (${priced} priced)` : ''}  key from ${p.auth?.env ? `$${p.auth.env}` : p.auth?.file ? rel(p.auth.file) : 'nowhere (no key)'}${p.probedAt ? `  probed ${p.probedAt.slice(0, 16).replace('T', ' ')}` : '  never probed'}`);
    if (p.checks && !p.formats?.length) out.push(`  checks: ${Object.entries(p.checks).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  const rs = Object.entries(reg.routes);
  if (rs.length) { out.push('', 'Routes (a subagent whose model is thinker/<alias> runs there):'); for (const [a, r] of rs) out.push(`  thinker/${a} -> ${r.provider}/${r.model}${r.format ? ` as ${r.format}` : ''}`); }
  const as = Object.entries(reg.agents);
  if (as.length) { out.push('', 'Subagents written by thinker (Claude Code, user scope):'); for (const [n, a] of as) out.push(`  ${n}: ${a.model} (${a.template || 'reader'})`); }
  return out;
}

async function modelsCommand({ pos, flags, out, repo, store }) {
  const sub = pos[0] || 'list';
  const home = thinkerHome();
  const reg = readRegistry(home);
  const fail = m => { out(`thinker models: ${m}`); process.exitCode = 2; };
  if (sub === 'list') { for (const l of listLines(reg)) out(l); return; }
  if (sub === 'add' || sub === 'probe') {
    let id = pos[1];
    if (sub === 'add') {
      const url = pos[2];
      if (!id || !url) return fail('add takes <id> <url>');
      let auth;
      if (flags['key-env']) auth = { env: String(flags['key-env']) };
      else if (flags['key-file']) auth = { file: path.resolve(String(flags['key-file'])) };
      else if (flags.key) auth = { file: storeKey(id, flags.key, home) };
      else if (flags['no-key']) auth = { none: true };
      else if (!reg.providers[id]?.auth) return fail('say where the key comes from: --key-env NAME, --key-file path, --key value (kept in a private file under ' + rel(home) + '/keys), or --no-key');
      try { addProvider(reg, { id, url, auth, label: flags.label ? String(flags.label) : undefined }); } catch (e) { return fail(e.message); }
      if (flags.key) out(`Key kept in ${keyFileFor(id, home)} (chmod 600); the registry names the file, never the key.`);
    }
    const ids = id ? [id] : Object.keys(reg.providers);
    if (!ids.length) return fail('no providers to probe');
    for (const pid of ids) {
      const p = reg.providers[pid]; if (!p) return fail(`no provider ${pid}`);
      out(`Probing ${pid} at ${p.url} …`);
      let found;
      try { found = await probeProvider(p, { model: flags.model ? String(flags.model) : null }); } catch (e) { return fail(`${pid}: ${e.message}`); }
      recordProbe(reg, pid, found);
      const n = Object.keys(found.models).length;
      out(`  /v1/models: ${found.checks.models}${n ? ` (${n} models${Object.values(found.models).some(m => m.price) ? ', with prices' : ''})` : ''}`);
      for (const f of FORMATS) out(`  ${f}: ${found.checks[f] ?? 'not tried'}${found.formats.includes(f) ? ' ✓' : ''}${found.probeModel && found.checks[f] != null ? ` (with ${found.probeModel})` : ''}`);
      if (found.checks.format) out(`  ${found.checks.format}`);
      out(found.formats.length ? `  ${pid} speaks ${found.formats.join(' and ')}; the proxy ${found.formats.includes('messages') ? 'forwards Messages as they come' : 'translates to Chat (wire-chat.js: no thinking, no cache_control, no server tools)'}.` : `  ${pid} answered neither format with its own shape; nothing can be routed there yet (a wrong key reads as 401 above, a wrong base URL as 404).`);
    }
    writeRegistry(reg, home);
    return;
  }
  if (sub === 'remove') {
    if (!pos[1]) return fail('remove takes <id>');
    try { removeProvider(reg, pos[1]); } catch (e) { return fail(e.message); }
    writeRegistry(reg, home); out(`Removed ${pos[1]} and its routes. Subagents naming them fail on their next call until reassigned.`); return;
  }
  if (sub === 'route') {
    const alias = pos[1];
    if (!alias) return fail('route takes <alias> <provider>/<model> (or --off)');
    try {
      if (flags.off) { dropRoute(reg, alias); writeRegistry(reg, home); out(`Dropped thinker/${alias}.`); return; }
      if (!pos[2]) return fail('route takes <alias> <provider>/<model>');
      const r = setRoute(reg, alias, pos[2], { format: flags.format ? String(flags.format) : undefined });
      writeRegistry(reg, home);
      const res = resolveRoute(`thinker/${alias}`, reg);
      out(`thinker/${alias} -> ${r.provider}/${r.model} as ${res.format}. A subagent whose model is thinker/${alias} runs there from its next call; the proxy must be on (thinker proxy status).`);
    } catch (e) { return fail(e.message); }
    return;
  }
  if (sub === 'price') {
    const t = String(pos[1] || ''), i = t.indexOf('/');
    if (i <= 0) return fail('price takes <provider>/<model> --input $/M --output $/M');
    const p = reg.providers[t.slice(0, i)]; if (!p) return fail(`no provider ${t.slice(0, i)}`);
    const input = Number(flags.input), output = Number(flags.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return fail('--input and --output are dollars a million tokens');
    p.models ||= {}; p.models[t.slice(i + 1)] = { ...(p.models[t.slice(i + 1)] || { source: 'manual' }), price: { input, output, ...(flags['cache-read'] != null ? { cacheRead: Number(flags['cache-read']) } : {}) } };
    writeRegistry(reg, home); out(`${t}: ${formatDollars(input)}/M in, ${formatDollars(output)}/M out (the Report and the profile price it so).`); return;
  }
  if (sub === 'assign') {
    const name = pos[1], model = pos[2];
    if (!name) return fail('assign takes <Agent> <model> (--off removes)');
    if (String(name).toLowerCase() === 'explore') {
      // Explore has its own writer (explore-agent.js); its switch is agents.explore in the machine config
      const value = flags.off ? false : model;
      if (!flags.off && !model) return fail('assign Explore takes a model (thinker/<alias>, thinker/<provider>/<model>, or a Claude model id)');
      if (model && isRouteId(model)) { try { resolveRoute(model, reg); } catch (e) { return fail(e.message); } }
      updateMachineConfig(home, cfg => { cfg.agents = { ...(cfg.agents || {}), explore: value }; return cfg; });
      const ex = installExploreAgent({ claudeDir: claudeDir(), model: value || null });
      out(ex.action === 'kept' ? `${rel(ex.file)} is your own file and was left alone; agents.explore is ${JSON.stringify(value)} for the record.` : ex.action === 'removed' || ex.action === 'absent' ? `Explore runs on the session's model again (agents.explore off).` : `Explore runs on ${model} (${rel(ex.file)}; new sessions pick it up).`);
      return;
    }
    if (!isAgentName(name)) return fail('an agent name is a word of letters, digits, dashes and underscores');
    if (flags.off) { if (!reg.agents[name]) return fail(`no subagent ${name} written by thinker`); delete reg.agents[name]; }
    else {
      if (!model) return fail('assign takes <Agent> <model>');
      if (isRouteId(model)) { try { resolveRoute(model, reg); } catch (e) { return fail(e.message); } }
      const template = flags.template ? String(flags.template) : (reg.agents[name]?.template || 'reader');
      if (!TEMPLATES[template]) return fail(`--template is one of ${Object.keys(TEMPLATES).join(', ')}`);
      reg.agents[name] = { model, template, ...(flags.description ? { description: String(flags.description) } : reg.agents[name]?.description ? { description: reg.agents[name].description } : {}), at: new Date().toISOString() };
    }
    writeRegistry(reg, home);
    const acts = installAgents({ claudeDir: claudeDir(), agents: reg.agents });
    for (const a of acts) if (a.action !== 'unchanged') out(a.action === 'kept' ? `${rel(a.file)} is your own file and was left alone` : a.action === 'removed' ? `removed ${rel(a.file)}` : `${a.name} runs on ${a.model} (${rel(a.file)}, ${reg.agents[a.name]?.template}); a new session sees it, and the Agent tool's subagent_type names it.`);
    if (!flags.off && !isRouteId(model)) out(`Note: ${model} is not a thinker route, so the subagent's calls go to the session's own upstream with the session's login.`);
    return;
  }
  if (sub === 'profile') {
    const days = Math.max(1, Math.min(365, Number(flags.days) || 30));
    let prof;
    if (flags.refresh || !readProfile(home).at) {
      if (!isGitCheckout(repo)) return fail('profile --refresh reads this repository\'s sessions; run it inside a git checkout (the kept profile shows anywhere)');
      try { if (!store.exists()) store.init(); } catch {}
      prof = refreshProfile(store, { home, days });
    } else prof = readProfile(home);
    const v = profileView(prof, { repo: flags.here ? repo : null });
    if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
    for (const l of renderProfile(v)) out(l);
    out('', `thinker models profile --refresh reads this repository's sessions again (${days} days); --here shows this repository alone; --json is the data. thinker models route <alias> <provider>/<model> acts on a recommendation.`);
    return;
  }
  return fail(`unknown subcommand ${sub} (list, add, probe, remove, route, price, assign, profile)`);
}

export const commands = { models: modelsCommand };
