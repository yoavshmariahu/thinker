#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot } from './store.js';
import { orient, lookup, createNote, refresh, verifyNote, renderNote, attest, linkNotes, outcome, looksLikeCorrection } from './ops.js';
import { mineCochange, partners } from './cochange.js';
import { hashDep } from './deps.js';
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

function mcpConfig() {
  return { thinker: { command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: repo } } };
}

function mergeJson(file, patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const next = patch(cur);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

const HELP = `thinker — cache of understanding for coding agents

  init [--hooks] [--git-hook]   create .thinker/ and register the MCP server in .mcp.json
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
  hook <prompt|stop>             Claude Code hook entrypoints (read JSON on stdin)
  seed [--areas n] [--prompts f.json] [--dry]   bootstrap coverage: one exploration session per source area
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  stats
`;

async function main() {
  switch (cmd) {
    case 'init': {
      store.init();
      if (!flags['no-mcp']) { mergeJson(path.join(repo, '.mcp.json'), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), ...mcpConfig() } })); out(`initialized ${store.dir} and registered MCP server in .mcp.json`); }
      else out(`initialized ${store.dir}`);
      if (flags.hooks) {
        const cli = path.join(HERE, 'cli.js');
        mergeJson(path.join(repo, '.claude', 'settings.json'), c => {
          const hooks = { ...(c.hooks || {}) };
          const add = (ev, command, extra = {}) => {
            hooks[ev] = (hooks[ev] || []).filter(h => !JSON.stringify(h).includes('thinker'));
            hooks[ev].push({ matcher: '', hooks: [{ type: 'command', command, ...extra }] });
          };
          add('UserPromptSubmit', `node ${cli} hook prompt`, { timeout: 15 });
          add('Stop', `node ${cli} hook stop`, { timeout: 10 });
          return { ...c, hooks };
        });
        out('installed Claude Code hooks (UserPromptSubmit → orient, Stop → distill) in .claude/settings.json');
      }
      if (flags['git-hook']) {
        const hook = path.join(repo, '.git', 'hooks', 'post-commit');
        fs.writeFileSync(hook, `#!/bin/sh\n# thinker: re-hash note dependencies and re-verify stale notes in the background\nnohup node ${path.join(HERE, 'cli.js')} check --quiet --verify --repo "${repo}" >/dev/null 2>&1 &\n`, { mode: 0o755 });
        out('installed git post-commit hook');
      }
      try { const idx = mineCochange(repo); out(`mined co-change edges from ${idx.commits} commits`); } catch {}
      const gi = path.join(repo, '.thinker', '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'log.jsonl\nstate/\n');
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
      if (pos[0] === 'prompt') {
        if (!store.exists() || !store.list().length) break;
        // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
        if (ev.session_id && looksLikeCorrection(ev.prompt)) outcome(store, { session: ev.session_id, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
        const r = await orient(store, { task: ev.prompt || '', session: ev.session_id, budget: Number(flags.budget) || 1000 });
        if (r.included.length) out(`<thinker-cache>\nCached understanding of this repo relevant to the request, distilled from previous sessions. Use the file:symbol pointers to skip orientation. These notes are partial: they say where things live and how they connect, not everything this task needs, so still search for the specific identifiers, options and paths the request mentions, and verify any path or command you cite. Notes marked STALE must be confirmed against the code.\n\n${r.text}\n</thinker-cache>`);
      } else if (pos[0] === 'stop') {
        // Distill in the background so the hook returns immediately.
        if (!ev.transcript_path || !store.exists()) break;
        const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', ev.transcript_path, '--incremental', '--quiet', '--repo', repo],
          { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
      }
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
