#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot, gitHead } from './store.js';
import { orient, lookup, createNote, refresh, verifyNote, renderNote, attest, linkNotes, outcome, looksLikeCorrection, lateNotes, completenessNudge } from './ops.js';
import { listMergedPrs, distillPr } from './prs.js';
import { loadCochange } from './cochange.js';
import { mineCochange, partners } from './cochange.js';
import { hashDep } from './deps.js';
import { CLIENTS, parseClients, installClient, uninstallClients, hookClient, sessionOf, toolFiles, promptOutput, toolOutput, parkPending, takePending } from './clients.js';
import { parseTranscript, exploreCount, distillEvents, saveNotes, transcriptsFor, injectedIds } from './distill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else pos.push(argv[i]);
}
const repo = findRepoRoot(flags.repo || process.env.THINKER_REPO || process.cwd());
const store = new Store(repo);
const out = s => process.stdout.write(s + '\n');
const readStdin = () => fs.readFileSync(0, 'utf8');

const mcpEntry = () => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: repo } });

const HELP = `thinker — cache of understanding for coding agents

  setup [--clients list|all|auto] [--areas n] [--prs n] [--no-seed] [--no-prs] [--learn] [--late] [--shared] [--git-hook] [--export f.tgz] [--yes]
                                 everything for a new repo in one step: build the cache (co-change, merged PRs,
                                 one exploration session per source area) and wire it into the coding agents found
  init [--hooks | --serve-only] [--late] [--local] [--git-hook] [--no-mcp] [--clients list|all|auto]
                                 set up .thinker/, hooks and the MCP server for this repo (clients: claude, codex, cursor, gemini; default claude)
  uninstall [--purge]            remove hooks and MCP registration (notes are kept unless --purge)
  export [file.tgz]              pack this repo's cache for delivery
  import <file.tgz|url>          unpack a delivered cache and check it against this checkout
  serve                          run the MCP server (stdio)
  orient "<task>" [--file f] [--budget n]
  lookup "<query>"
  list [--stale] [--all]         list notes
  show <id>                      print a note
  rm <id>
  add [file.json]                add a human-written note (JSON on stdin or file)
  check                          re-hash dependencies, mark stale notes
  cochange [file]                mine co-change edges from git history / show partners of a file
  relink                         recompute cross-note links
  verify [ids...] [--model m]    re-verify stale notes with a small model
  distill [transcript.jsonl] [--min-explore n] [--dry] [--model m]
  seed [--areas n] [--prompts f.json] [--dry]   bootstrap coverage: one exploration session per source area
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  mine-prs <owner/repo> --before <iso> [--after <iso>] [--limit n]   distill merged PRs into fix / invariant / convention notes
  hook <prompt|tool|stop [--nudge]> [--client c]   hook entrypoints (JSON on stdin): prompt = early injection, tool = late file-keyed injection, stop = nudge + distill
  stats
`;

async function main() {
  switch (cmd) {
    case 'init': {
      // flags: --hooks (serve + learn), --serve-only (no learning at session end), --late (file-keyed notes),
      //        --local (write .claude/settings.local.json, not shared), --git-hook, --no-mcp, --clients
      init({ clients: parseClients(flags.clients), hooks: !!(flags.hooks || flags['serve-only']), learn: !!flags.hooks && !flags['serve-only'], late: !!flags.late, shared: !flags.local, mcp: !flags['no-mcp'], gitHook: !!flags['git-hook'] });
      break;
    }
    case 'setup': {
      await setup();
      break;
    }
    case 'uninstall': {
      // remove hooks and MCP registration for every client; notes stay unless --purge
      uninstallClients(repo);
      const gh = path.join(repo, '.git', 'hooks', 'post-commit');
      if (fs.existsSync(gh) && fs.readFileSync(gh, 'utf8').includes('thinker')) fs.unlinkSync(gh);
      if (flags.purge) fs.rmSync(store.dir, { recursive: true, force: true });
      out(`removed thinker hooks and MCP registration from ${repo}${flags.purge ? ' and deleted .thinker/' : ' (notes kept in .thinker/)'}`);
      break;
    }
    case 'export': {
      // pack this repo's cache (notes, co-change index, config) for delivery
      const file = path.resolve(pos[0] || `thinker-cache-${path.basename(repo)}.tgz`);
      const items = ['notes', 'cochange.json', 'config.json'].filter(x => fs.existsSync(path.join(store.dir, x)));
      const head = gitHead(repo);
      fs.writeFileSync(path.join(store.dir, 'cache-manifest.json'), JSON.stringify({ repo: path.basename(repo), commit: head, notes: store.list().length, exportedAt: new Date().toISOString() }, null, 2));
      execFileSync('tar', ['-czf', file, '-C', store.dir, ...items, 'cache-manifest.json']);
      out(`exported ${store.list().length} notes at ${String(head).slice(0, 10)} → ${file}`);
      break;
    }
    case 'import': {
      // unpack a delivered cache into .thinker/ and check it against this checkout
      const src = pos[0]; if (!src) { out('usage: thinker import <file.tgz | https://…>'); process.exit(1); }
      fs.mkdirSync(store.dir, { recursive: true });
      let file = src;
      if (/^https?:\/\//.test(src)) { file = path.join(store.dir, 'cache-download.tgz'); execFileSync('curl', ['-fsSL', '-o', file, src]); }
      const names = execFileSync('tar', ['-tzf', file]).toString().split('\n').filter(Boolean);
      if (names.some(n => n.startsWith('/') || n.split('/').includes('..'))) { out('refusing to unpack: archive contains unsafe paths'); process.exit(1); }
      execFileSync('tar', ['-xzf', file, '-C', store.dir]);
      if (file.endsWith('cache-download.tgz')) fs.unlinkSync(file);
      const notes = refresh(store, store.list());
      const stale = notes.filter(n => n.status === 'stale').length;
      let man = {}; try { man = JSON.parse(fs.readFileSync(path.join(store.dir, 'cache-manifest.json'), 'utf8')); } catch {}
      out(`imported ${notes.length} notes${man.commit ? ` built at ${String(man.commit).slice(0, 10)}` : ''}; ${stale} are stale against this checkout (they are served with a warning and re-verified in the background)`);
      break;
    }
    case 'serve': {
      const p = spawn('node', [path.join(HERE, 'mcp.js')], { stdio: 'inherit', env: { ...process.env, THINKER_REPO: repo } });
      p.on('exit', c => process.exit(c || 0));
      break;
    }
    case 'orient': {
      const r = await orient(store, { task: pos.join(' '), file: flags.file, budget: Number(flags.budget) || 1000 });
      out(r.included.length ? r.text : '(no matching notes)');
      break;
    }
    case 'lookup': {
      const r = lookup(store, { query: pos.join(' '), budget: Number(flags.budget) || 2500 });
      out(r.included.length ? r.text : '(nothing cached about that)');
      break;
    }
    case 'list': {
      let notes = refresh(store, store.list());
      if (flags.stale) notes = notes.filter(n => n.status === 'stale');
      if (!flags.all) notes = notes.filter(n => n.status !== 'invalid');
      for (const n of notes) out(`${n.status.padEnd(7)} ${String(n.kind).padEnd(10)} ${n.id.padEnd(45)} c=${Math.round((n.confidence ?? 0.7) * 100)}% uses=${n.uses || 0}  ${n.title}`);
      out(`${notes.length} notes`);
      break;
    }
    case 'show': {
      const n = store.get(pos[0]); if (!n) { out('no such note'); process.exit(1); }
      out(flags.json ? JSON.stringify(n, null, 2) : renderNote(n) + `\nsource: ${JSON.stringify(n.source)}  verified: ${n.verified}  status: ${n.status}  attest: ${JSON.stringify(n.attest || {})}  related: ${(n.related || []).join(', ') || '-'}`);
      break;
    }
    case 'rm': { out(store.remove(pos[0]) ? 'removed' : 'no such note'); break; }
    case 'add': {
      const input = JSON.parse(pos[0] ? fs.readFileSync(pos[0], 'utf8') : readStdin());
      const r = createNote(store, input, { source: { type: flags.source || 'human' } });
      if (r.error) { out('error: ' + r.error); process.exit(1); }
      out(`saved ${r.note.id}` + (r.dropped.length ? ` (dropped: ${JSON.stringify(r.dropped)})` : ''));
      break;
    }
    case 'cochange': {
      if (pos[0]) { const idx = JSON.parse(fs.readFileSync(path.join(store.dir, 'cochange.json'), 'utf8')); for (const p of partners(idx, pos[0], { minSupport: 2, minConf: 0.3 })) out(`${p.file}  ${Math.round(p.conf * 100)}%  n=${p.support}`); break; }
      const idx = mineCochange(repo, { commits: Number(flags.commits) || 800 });
      out(`mined ${idx.commits} commits, ${Object.keys(idx.totals).length} files → ${store.dir}/cochange.json`);
      break;
    }
    case 'relink': { const notes = store.list(); for (const n of notes) linkNotes(store, n, notes); out(`linked ${notes.length} notes`); break; }
    case 'rehash': {
      // Re-baseline every note's dependency hashes against the current tree
      // without LLM verification (use after upgrading thinker's hashing).
      let n = 0;
      for (const note of store.list()) { note.deps = (note.deps || []).map(d => hashDep(store.repo, d)).filter(d => !d.missing); note.status = note.status === 'invalid' ? 'invalid' : 'fresh'; delete note.stale; delete note.verifying; store.put(note); n++; }
      out(`rehashed ${n} notes`);
      break;
    }
    case 'check': {
      const notes = refresh(store, store.list());
      const stale = notes.filter(n => n.status === 'stale');
      if (!flags.quiet) {
        for (const n of stale) out(`stale  ${n.id}: ${n.stale.changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ')}`);
        out(`${stale.length}/${notes.length} notes stale`);
      }
      if (flags.verify && stale.length) await verifyAll(stale);
      break;
    }
    case 'verify': {
      let notes = refresh(store, store.list());
      notes = pos.length ? notes.filter(n => pos.includes(n.id)) : notes.filter(n => n.status === 'stale');
      await verifyAll(notes);
      break;
    }
    case 'distill': {
      let file = pos[0];
      if (!file) { file = transcriptsFor(repo)[0]; if (!file) { out('no transcript found for ' + repo); process.exit(1); } }
      await distillFile(file, { minExplore: Number(flags['min-explore']) || 1, dry: !!flags.dry, model: flags.model, quiet: !!flags.quiet, incremental: !!flags.incremental });
      break;
    }
    case 'hook': {
      const ev = JSON.parse(readStdin() || '{}');
      const client = hookClient(flags.client, ev);
      // Cursor also runs the Claude Code hooks it imports; its own hooks do the work
      if (client === 'cursor-import') break;
      const session = sessionOf(ev);
      if (pos[0] === 'prompt') {
        if (client === 'cursor') out(JSON.stringify({ continue: true })); // cannot add context here; see clients.js
        if (!store.exists() || !store.list().length) break;
        // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
        if (session !== 'unknown' && looksLikeCorrection(ev.prompt)) outcome(store, { session, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
        const r = await orient(store, { task: ev.prompt || '', session: session === 'unknown' ? undefined : session, budget: Number(flags.budget) || 600 });
        if (!r.included.length) break;
        const text = `<thinker-cache>\nNotes about this repo from earlier sessions. Their code dependencies were re-hashed just now and match the current code${r.included.some(n => n.status === 'stale') ? ', except notes marked STALE' : ''}, so the facts below are current: rely on them and do not re-read files only to confirm them. They cover where things are and how they connect, not the design of this change.\n\n${r.text}\n</thinker-cache>`;
        if (client === 'cursor') parkPending(store.dir, session, text);
        else out(promptOutput(client, text));
      } else if (pos[0] === 'tool') {
        // After a tool call: the agent opened files; serve notes anchored to them, once each.
        if (!store.exists()) break;
        const parts = [];
        if (client === 'cursor') { const p = takePending(store.dir, session); if (p) parts.push(p); }
        if (client !== 'cursor' || flags.late) { const r = lateNotes(store, { session, files: toolFiles(ev, repo) }); if (r.text) parts.push(r.text); }
        if (parts.length) out(toolOutput(client, parts.join('\n\n')));
      } else if (pos[0] === 'stop') {
        if (!store.exists()) break;
        // completeness nudge (once per session, never when already continuing from a stop hook)
        if (flags.nudge && !ev.stop_hook_active) {
          let changed = [];
          try { changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString().split('\n').map(l => l.slice(3).trim()).filter(f => f && !f.startsWith('.thinker') && !f.startsWith('.mcp.json') && !f.startsWith('.claude/')); } catch {}
          const n = completenessNudge(store, { session: ev.session_id || 'unknown', changed, cochange: loadCochange(repo) });
          if (n.text) { out(JSON.stringify({ decision: 'block', reason: n.text })); break; }
        }
        // Distill in the background so the hook returns immediately.
        if (!ev.transcript_path || flags['no-distill']) break;
        const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', ev.transcript_path, '--incremental', '--quiet', '--repo', repo],
          { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
      }
      break;
    }
    case 'mine-prs': {
      // thinker mine-prs <owner/repo> --before <iso> [--after <iso>] [--limit n] [--dry]
      await minePrs(pos[0], { before: flags.before, after: flags.after, limit: Number(flags.limit) || 60, model: flags.model, dry: !!flags.dry });
      break;
    }
    case 'outcome': {
      // thinker outcome <session-id> good|bad [reason]  — for CI / external integrations
      const r = outcome(store, { session: pos[0], positive: pos[1] !== 'bad', reason: pos.slice(2).join(' ') });
      out(`${r.length} notes updated: ${r.map(x => `${x.id} c=${Math.round(x.confidence * 100)}%`).join(', ') || '-'}`);
      break;
    }
    case 'seed': {
      // Bootstrap coverage: one exploration session per source area, distilled.
      await seed({ areas: Number(flags.areas) || 12, model: flags.model || 'sonnet', dry: !!flags.dry, prompts: flags.prompts });
      break;
    }
    case 'stats': {
      const notes = store.list();
      const by = {}; for (const n of notes) by[n.status] = (by[n.status] || 0) + 1;
      const kinds = {}; for (const n of notes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      out(JSON.stringify({ repo, notes: notes.length, status: by, kinds, uses: notes.reduce((s, n) => s + (n.uses || 0), 0) }, null, 2));
      break;
    }
    default: out(HELP);
  }
}

function init({ clients, hooks, learn, late, shared, mcp, gitHook }) {
  store.init();
  out(`initialized ${store.dir}`);
  for (const c of clients) for (const line of installClient(c, { repo, cli: path.join(HERE, 'cli.js'), mcpEntry: mcpEntry(), hooks, learn, late, shared, mcp })) out(line);
  if (gitHook) {
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    if (fs.existsSync(hook) && !fs.readFileSync(hook, 'utf8').includes('thinker')) out(`skipped git hook: ${hook} already exists and is not ours`);
    else { fs.writeFileSync(hook, `#!/bin/sh\n# thinker: re-hash note dependencies${learn ? ' and re-verify stale notes' : ''} in the background\nnohup node "${path.join(HERE, 'cli.js')}" check --quiet${learn ? ' --verify' : ''} --repo "${repo}" >/dev/null 2>&1 &\n`, { mode: 0o755 }); out('installed git post-commit hook'); }
  }
  if (!fs.existsSync(path.join(store.dir, 'cochange.json'))) { try { const idx = mineCochange(repo); out(`mined co-change edges from ${idx.commits} commits`); } catch {} }
  const gi = path.join(repo, '.thinker', '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'log.jsonl\nstate/\n');
}

// owner/name of the GitHub repository behind `origin`, or null
function githubSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}
const hasBin = b => { try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

// One step for a new repo: build the cache, then wire it into the clients.
async function setup() {
  const clients = parseClients(flags.clients, parseClients('auto'));
  const num = (v, d) => v === undefined || v === true || Number.isNaN(Number(v)) ? d : Number(v);
  const areas = flags['no-seed'] ? 0 : num(flags.areas, 12);
  const slug = flags['no-prs'] ? null : (typeof flags.slug === 'string' ? flags.slug : githubSlug());
  const prs = slug ? num(flags.prs, 60) : 0;
  const canBuild = hasBin('claude') || !!process.env.ANTHROPIC_API_KEY;
  const canSeed = hasBin('claude');
  const canMine = prs && hasBin('gh');
  out(`thinker setup for ${path.basename(repo)}`);
  out(`  clients:      ${clients.join(', ')}`);
  out(`  explore:      ${areas && canSeed ? `${areas} source areas, one agent session each` : areas ? 'skipped (needs the claude CLI)' : 'skipped'}`);
  out(`  merged PRs:   ${canMine && canBuild ? `up to ${prs} from ${slug}` : flags['no-prs'] || (slug && !prs) ? 'skipped' : !slug ? 'skipped (origin is not a GitHub repository)' : 'skipped (needs the gh CLI and a model)'}`);
  // measured on PostHog: ~$0.45 per exploration session incl. distillation, ~$0.06 per mined PR
  const est = (areas && canSeed ? areas * 0.45 : 0) + (canMine && canBuild ? prs * 0.06 : 0);
  if (est) out(`  model usage:  roughly $${est.toFixed(0)} through your Claude login (estimate from earlier builds; varies with repo size)`);
  if (est && !flags.yes && process.stdin.isTTY) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question('Continue? [Y/n] '); rl.close();
    if (/^n/i.test(a.trim())) { out('stopped before building; nothing was changed'); return; }
  }
  init({ clients, hooks: true, learn: !!flags.learn, late: !!flags.late, shared: !!flags.shared, mcp: true, gitHook: !!flags['git-hook'] });
  if (canMine && canBuild) await minePrs(slug, { before: new Date().toISOString(), limit: prs, model: flags.model });
  if (areas && canSeed) await seed({ areas, model: flags.model || 'sonnet' });
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  if (typeof flags.export === 'string') { execFileSync('node', [path.join(HERE, 'cli.js'), 'export', flags.export, '--repo', repo], { stdio: 'inherit' }); }
  out(`\nthinker is set up for ${path.basename(repo)}: ${notes.length} notes, served to ${clients.join(', ')}.`);
  if (!notes.length) out('The cache is empty. With --learn it fills from your own Claude Code sessions; or re-run setup where the claude CLI is available.');
}

async function minePrs(slug, { before, after, limit, model, dry }) {
  const prs = listMergedPrs(slug, { before, after, limit })
    .filter(p => !/^(chore|deps|docs|revert|ci|build|test)\b|\bbump\b|dependabot|renovate|snapshot/i.test(p.title) && (p.body || '').length > 120 && p.additions <= 600 && p.additions >= 5);
  out(`${prs.length} PRs to mine`);
  let cost = 0, saved = 0;
  for (const pr of prs) {
    try {
      const r = await distillPr(slug, pr, { model: model || store.config().distillModel || 'sonnet' });
      cost += r.cost || 0;
      if (dry) { out(`#${pr.number} ${pr.title.slice(0, 60)} → ${r.notes.map(n => n.kind).join(',') || '-'}`); continue; }
      const s2 = saveNotes(store, r.notes, { source: { type: 'pr', ref: `${slug}#${pr.number}` } });
      saved += s2.saved.length + s2.merged.length;
      out(`#${pr.number} ${pr.title.slice(0, 60)} → ${[...s2.saved, ...s2.merged].map(n => `[${n.kind}] ${n.id}`).join(', ') || '-'}${s2.skipped.length ? ` (skipped ${s2.skipped.length})` : ''}`);
    } catch (e) { out(`#${pr.number} error ${String(e.message).slice(0, 120)}`); }
  }
  out(`mined ${prs.length} PRs → ${saved} notes, cost $${cost.toFixed(2)}`);
  return { cost, saved };
}

function sourceAreas(limit) {
  const files = execFileSync('git', ['ls-files'], { cwd: repo, maxBuffer: 1 << 26 }).toString().split('\n').filter(f => /\.(py|ts|tsx|js|jsx|go|rs|rb|java|kt|cs|php|swift|scala|ex|exs)$/.test(f) && !/(^|\/)(node_modules|vendor|third_party|dist|build|__snapshots__|migrations)\//.test(f) && !/(^|\/)(tests?|__tests__|spec)\//.test(f) && !/\.(test|spec|stories)\.\w+$/.test(f));
  const count = {};
  for (const f of files) { const parts = f.split('/'); const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.'; count[key] = (count[key] || 0) + 1; }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([dir, n]) => ({ dir, n }));
}

async function seed({ areas, model, dry, prompts }) {
  const list = prompts ? JSON.parse(fs.readFileSync(prompts, 'utf8')).map(p => ({ prompt: p })) : sourceAreas(areas).map(a => ({ dir: a.dir, n: a.n, prompt: `Orient a new contributor in ${a.dir}/ (${a.n} source files): what this area is responsible for, its main entry points and how control flows into and out of it (cite file:symbol), the two or three things that must change together when extending it, local conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.` }));
  if (dry) { for (const a of list) out(`${(a.dir || '-').padEnd(40)} ${a.n || ''}`); return; }
  const { spawnSync } = await import('node:child_process');
  let cost = 0;
  for (const a of list) {
    const t0 = Date.now();
    const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit,Write,NotebookEdit', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '40'], { cwd: repo, input: a.prompt, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let j; try { j = JSON.parse(r.stdout); } catch { out(`${a.dir || a.prompt.slice(0, 40)}: agent failed: ${(r.stderr || '').slice(0, 200)}`); continue; }
    cost += j.total_cost_usd || 0;
    const transcript = transcriptsFor(repo).find(f => f.includes(j.session_id));
    if (!transcript) { out(`${a.dir}: no transcript found`); continue; }
    out(`${(a.dir || a.prompt.slice(0, 40)).padEnd(40)} ${j.num_turns} turns $${(j.total_cost_usd || 0).toFixed(2)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await distillFile(transcript, { minExplore: 1, dry: false, model: undefined, quiet: false, incremental: false });
  }
  out(`seeded ${list.length} areas, agent cost $${cost.toFixed(2)}`);
}

async function verifyAll(notes) {
  let cost = 0;
  for (const n of notes) {
    try {
      const r = await verifyNote(store, n, { model: flags.model });
      cost += r.cost || 0;
      out(`${r.verdict.padEnd(12)} ${n.id}: ${r.reason}`);
    } catch (e) { out(`error        ${n.id}: ${e.message}`); }
  }
  out(`verified ${notes.length} notes ($${cost.toFixed(3)})`);
}

async function distillFile(file, { minExplore, dry, model, quiet, incremental }) {
  const stateDir = path.join(store.dir, 'state');
  const stateFile = path.join(stateDir, path.basename(file, '.jsonl') + '.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const fromLine = incremental ? (state.line || 0) : 0;
  const { events, lineCount } = parseTranscript(file, { fromLine });
  const n = exploreCount(events);
  if (n < minExplore) { if (!quiet) out(`only ${n} exploration calls since last distill (<${minExplore}); nothing to distill`); return; }
  const served = injectedIds(file, { fromLine }).map(id => store.get(id)).filter(Boolean);
  const r = await distillEvents(events, { model: model || store.config().distillModel || 'sonnet', repoHint: repo, served });
  if (dry) { out(JSON.stringify({ notes: r.notes, assessments: r.assessments }, null, 2)); out(`(${r.notes.length} notes, cost $${(r.cost || 0).toFixed(3)}, trace ${r.traceChars} chars)`); return; }
  const s = saveNotes(store, r.notes, { source: { type: 'agent', ref: path.basename(file, '.jsonl') } });
  const applied = attest(store, r.assessments, { session: path.basename(file, '.jsonl') });
  if (!quiet) for (const a of applied) out(`attest  ${a.verdict.padEnd(12)} ${a.id} → c=${Math.round(a.confidence * 100)}%`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ line: lineCount, at: new Date().toISOString() }));
  store.log({ op: 'distill', transcript: path.basename(file), explore: n, saved: s.saved.map(x => x.id), merged: s.merged.map(x => x.id), skipped: s.skipped, cost: r.cost });
  if (!quiet) {
    for (const x of s.saved) out(`saved   ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.merged) out(`merged  ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.skipped) out(`skipped ${x.title}: ${x.reason}`);
    out(`distilled ${events.length} events (${n} exploration calls) → ${s.saved.length} new, ${s.merged.length} merged; cost $${(r.cost || 0).toFixed(3)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
