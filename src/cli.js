#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot, gitHead } from './store.js';
import { orient, HOOK_BUDGET, rememberTask, phraseNotes, phraseKey, lookup, createNote, refresh, verifyNote, renderNote, attest, linkNotes, outcome, looksLikeCorrection, lateNotes, completenessNudge } from './ops.js';
import { listMergedPrs, distillPr, minedPrs, recordMinedPrs, nextPrs, stratifyPrs } from './prs.js';
import { discoverAreas, subsystemForFile } from './topology.js';
import { loadCochange } from './cochange.js';
import { mineCochange, partners } from './cochange.js';
import { hashDep } from './deps.js';
import { CLIENTS, parseClients, installClient, uninstallClients, trustCodex, hookClient, sessionOf, toolFiles, promptOutput, toolOutput, parkPending, takePending } from './clients.js';
import { recordEvent, traceFile, toolName, toolInput, hydrate, findSessions } from './transcripts.js';
import { available, provider, findBin } from './llm.js';
import { summarize, renderUsage, sessionKey } from './usage.js';
import { parseTranscript, exploreCount, distillEvents, saveNotes, transcriptsFor, injectedIds } from './distill.js';
import { MORE_NOTES_INTRO } from './cache-guidance.js';
import { benchmarkAgent, latestBenchmark, renderBenchmarkReport, runBenchmarkAgent, saveBenchmark } from './benchmark.js';

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

// Learning from sessions is on unless switched off, which evals do to keep the cache fixed.
const NO_LEARN = /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '');
const learnOn = () => !NO_LEARN && !flags['no-learn'] && !flags['serve-only'];

const mcpEntry = () => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: repo } });

const HELP = `thinker — knowledge cache for coding agents

  setup [--clients list|all|auto] [--areas n] [--prs n] [--no-seed] [--no-prs] [--no-learn] [--late] [--shared] [--git-hook] [--no-trust] [--export f.tgz] [--yes]
                                 everything for a new repo in one step: build the cache (co-change, merged PRs,
                                 one exploration session per source area) and wire it into the coding agents found;
                                 sessions are distilled into new notes as they end (--no-learn or THINKER_NO_LEARN=1 turns that off, for evals)
  init [--no-learn] [--no-hooks] [--late] [--local] [--git-hook] [--no-mcp] [--no-trust] [--yes] [--clients list|all|auto]
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
  phrase [ids...] [--model m] [--force]
                                 add to each note how a user would put it, in the words of the product (for retrieval)
  distill [transcript] [--format auto|claude|codex|cursor|gemini|events] [--min-explore n] [--dry] [--model m]
                                 turn a session into notes; reads any of these agents' transcripts, or a plain event trace
  learn [--days n] [--max n] [--idle-min n] [--prs [n]] [--dry]
                                 distill every session any supported agent ran in this repo that has not been distilled yet;
                                 --prs also mines merged pull requests that were not mined before (default 20)
  record <session>               append events (JSON lines on stdin: {t:prompt|say|tool, ...}) to a session trace, for agents without hooks
  seed [--areas n] [--prompts f.json] [--agent a] [--dry]   bootstrap coverage: one exploration session per source area
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  mine-prs [owner/repo] [--limit n] [--dry]
                                 distill merged PRs into fix / invariant / convention notes: those merged since the last run,
                                 then older ones; mined PRs are recorded in .thinker/prs.json and never distilled twice
                                 (default repo: the GitHub origin; --before <iso> [--after <iso>] [--again] picks a window by hand)
  hook <prompt|tool|stop [--nudge]> [--client c]   hook entrypoints (JSON on stdin): prompt = early injection, tool = late file-keyed injection, stop = nudge + distill
  usage [--here] [--days n] [--json]
                                 how the cache has been used on this machine, in every repository: notes served, what sessions
                                 did with them, what was learned, and an estimate of the tool calls and tokens saved
                                 (--here: this repository only; history is kept in ~/.thinker/log.jsonl)
  benchmark run "<repo question>" [--agent a] [--model m] [--budget n]
                                 run a paired, read-only onboarding benchmark without and with relevant cached notes
  benchmark report              show the latest comparison (answers are saved for human quality review)
  stats
`;

async function main() {
  switch (cmd) {
    case 'init': {
      // hooks serve notes and learn from sessions by default. flags: --no-learn (serve only, for evals; --serve-only is
      //        the older name), --no-hooks (MCP server only), --late (file-keyed notes),
      //        --local (write .claude/settings.local.json, not shared), --git-hook, --no-mcp, --clients,
      //        --no-trust (leave Codex's trust in the project and the hooks to the user), --yes (do not ask)
      await init({ clients: parseClients(flags.clients, 'auto'), hooks: !flags['no-hooks'], learn: !flags['no-hooks'] && learnOn(), late: !!flags.late, shared: !flags.local, mcp: !flags['no-mcp'], gitHook: !!flags['git-hook'] });
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
      // pack this repo's cache (notes, co-change index, record of mined PRs, config) for delivery
      const file = path.resolve(pos[0] || `thinker-cache-${path.basename(repo)}.tgz`);
      const items = ['notes', 'cochange.json', 'prs.json', 'config.json'].filter(x => fs.existsSync(path.join(store.dir, x)));
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
      const r = lookup(store, { query: pos.join(' '), budget: Number(flags.budget) || 2500, maxNotes: flags.n ? Number(flags.n) : 3 });
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
    case 'phrase': {
      // how a user would put what each note is about; notes that have it for their present text are left (--force)
      let notes = store.list().filter(n => n.status !== 'invalid' && (!pos.length || pos.includes(n.id)));
      if (!flags.force) notes = notes.filter(n => !n.says?.length || n.saysFor !== phraseKey(n));
      const per = 8, conc = Number(flags.conc) || 4;
      const groups = []; for (let i = 0; i < notes.length; i += per) groups.push(notes.slice(i, i + per));
      let n = 0, cost = 0;
      await Promise.all(Array.from({ length: conc }, async () => {
        while (groups.length) {
          const g = groups.shift();
          try { const r = await phraseNotes(store, g, { model: flags.model }); n += r.done.length; cost += r.cost || 0; }
          catch (e) { out(`phrase: ${g.length} notes skipped (${String(e.message).slice(0, 120)})`); }
        }
      }));
      out(`phrasings written for ${n} of ${notes.length} notes${cost ? ` ($${cost.toFixed(2)})` : ''}`);
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
      await distillFile(file, { minExplore: Number(flags['min-explore']) || 1, dry: !!flags.dry, model: flags.model, quiet: !!flags.quiet, incremental: !!flags.incremental, format: flags.format, session: typeof flags.session === 'string' ? flags.session : undefined });
      break;
    }
    case 'hook': {
      // model calls made by thinker run agents too; their hooks must do nothing
      if (process.env.THINKER_IN_LLM) break;
      const ev = JSON.parse(readStdin() || '{}');
      const client = hookClient(flags.client, ev);
      if (process.env.THINKER_HOOK_DEBUG) fs.appendFileSync(process.env.THINKER_HOOK_DEBUG, JSON.stringify({ hook: pos[0], client, ev }) + '\n');
      // Cursor also runs the Claude Code hooks it imports; its own hooks do the work
      if (client === 'cursor-import') break;
      const session = sessionOf(ev);
      // installed hooks carry --record; THINKER_NO_LEARN=1 switches learning off without reinstalling them
      if (NO_LEARN) flags.record = false;
      if (pos[0] === 'prompt') {
        if (client === 'cursor') out(JSON.stringify({ continue: true })); // cannot add context here; see clients.js
        if (flags.record && store.exists()) { recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt }); learnInBackground(client); }
        if (!store.exists() || !store.list().length) break;
        // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
        if (session !== 'unknown' && looksLikeCorrection(ev.prompt)) outcome(store, { session, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
        if (session !== 'unknown') rememberTask(store, session, ev.prompt);
        const r = await orient(store, { task: ev.prompt || '', session: session === 'unknown' ? undefined : session, budget: Number(flags.budget) || HOOK_BUDGET });
        if (!r.included.length) break;
        const more = r.more?.length ? `\n\n${MORE_NOTES_INTRO}\n${r.more.map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n')}` : '';
        const text = `<thinker-cache>\nNotes about this repo from earlier sessions. Their tracked code dependencies were re-hashed just now${r.included.some(n => n.status === 'stale') ? '; check notes marked STALE against code' : ' and match the working tree'}. Use matching pointers to reach the code; ignore neighboring topics. A fresh note is a map, not a complete plan for this change. Look up only a specific missing answer, then edit and verify.\n\n${r.text}${more}\n</thinker-cache>`;
        if (client === 'cursor') parkPending(store.dir, session, text);
        else out(promptOutput(client, text));
      } else if (pos[0] === 'tool') {
        // After a tool call: the agent opened files; serve notes anchored to them, once each.
        if (!store.exists()) break;
        // Cursor reports a shell command's output in afterShellExecution, not in postToolUse
        if (ev.hook_event_name === 'afterShellExecution') { if (flags.record) recordEvent(store.dir, session, { t: 'tool', name: 'Bash', input: { command: ev.command }, result: ev.output }); out('{}'); break; }
        if (flags.record && !(client === 'cursor' && toolName(ev.tool_name) === 'Bash')) { const name = toolName(ev.tool_name); recordEvent(store.dir, session, { t: 'tool', name, input: toolInput(name, ev.tool_input), result: ev.tool_response ?? ev.tool_output ?? ev.output }); }
        const parts = [];
        if (flags.record) learnInBackground(client);
        // Cursor drops context added to an MCP call's result: wait for the next tool call,
        // unless the agent asked the cache itself, in which case it has the notes already
        const mcpCall = /^MCP:/i.test(ev.tool_name || '');
        if (client === 'cursor' && mcpCall && !/orient|lookup/i.test(ev.tool_name)) { /* keep the bundle for the next call */ }
        else if (client === 'cursor') {
          let p = takePending(store.dir, session);
          // the prompt hook does not run in every Cursor mode: orient from the transcript's request instead
          const turn = path.join(store.dir, 'state', `oriented-${String(ev.generation_id || session).replace(/[^\w.-]/g, '_')}`);
          if (!p && !mcpCall && !fs.existsSync(turn) && ev.transcript_path && fs.existsSync(ev.transcript_path) && store.list().length) {
            const task = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'prompt').pop()?.text;
            if (task) { const r = await orient(store, { task, session, budget: Number(flags.budget) || HOOK_BUDGET }); if (r.included.length) p = `<thinker-cache>\nNotes about this repo from earlier sessions; their code dependencies were re-hashed just now.\n\n${r.text}\n</thinker-cache>`; }
          }
          fs.mkdirSync(path.dirname(turn), { recursive: true }); fs.writeFileSync(turn, '');
          if (p && !mcpCall) parts.push(p);
        }
        if (client === 'claude' || flags.late) {
          const name = toolName(ev.tool_name), command = toolInput(name, ev.tool_input).command || '';
          // an edit tool, or a shell command that writes a file in place
          const edited = name === 'Edit' || name === 'Write' || (name === 'Bash' && /\b(sed|perl)\s+(-\w+\s+)*-\w*i\b|\btee\s|>{1,2}\s*[\w./-]+\.\w+/.test(command));
          const r = lateNotes(store, { session, files: toolFiles(ev, repo), edited });
          if (r.text) parts.push(r.text);
        }
        if (parts.length) out(toolOutput(client, parts.join('\n\n')));
      } else if (pos[0] === 'stop') {
        if (!store.exists()) break;
        // completeness nudge (once per session, never when already continuing from a stop hook)
        if (flags.nudge && !ev.stop_hook_active) {
          let changed = [];
          try { changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString().split('\n').map(l => l.slice(3).trim()).filter(f => f && !f.startsWith('.thinker') && !f.startsWith('.mcp.json') && !f.startsWith('.claude/')); } catch {}
          const n = completenessNudge(store, { session, changed, cochange: loadCochange(repo) });
          if (n.text) { out(JSON.stringify({ decision: 'block', reason: n.text })); break; }
        }
        if (client === 'cursor') out('{}');
        // Claude Code: its transcript. Other agents: the trace the hooks recorded,
        // plus the agent's closing message from the hook input or its transcript.
        let source = ev.transcript_path;
        const native = ev.transcript_path && fs.existsSync(ev.transcript_path) && (() => { try { return parseTranscript(ev.transcript_path).events.some(e => e.t === 'tool'); } catch { return false; } })();
        if (flags.record && !native) {
          let last = ev.last_assistant_message || ev.prompt_response;
          if (!last && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { last = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'say').pop()?.text; } catch {} }
          recordEvent(store.dir, session, { t: 'say', text: last });
          source = traceFile(store.dir, session);
        }
        if (flags['no-distill'] || NO_LEARN) break;
        if (!source || !fs.existsSync(source)) break;
        const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo],
          { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } });
        child.unref();
      }
      break;
    }
    case 'learn': {
      await learn({ days: Number(flags.days) || 14, idleMin: flags['idle-min'] === undefined ? 2 : Number(flags['idle-min']), max: Number(flags.max) || 50, dry: !!flags.dry, quiet: !!flags.quiet });
      if (flags.prs) await mineMore({ limit: flags.prs === true ? 20 : Number(flags.prs) || 20, model: flags.model, dry: !!flags.dry });
      break;
    }
    case 'record': {
      // thinker record <session>: events as JSON lines on stdin; then `thinker distill <printed file>`
      let f = traceFile(store.init().dir, pos[0] || 'manual'), n = 0;
      for (const l of readStdin().split('\n')) { let j; try { j = JSON.parse(l); } catch { continue; } if (!['prompt', 'say', 'tool'].includes(j.t)) continue; if (j.t === 'tool') { j.name = toolName(j.name); j.input = toolInput(j.name, j.input); } recordEvent(store.dir, pos[0] || 'manual', j); n++; }
      out(`recorded ${n} events in ${f}`);
      break;
    }
    case 'mine-prs': {
      // thinker mine-prs [owner/repo] [--limit n] [--dry]; a window by hand: --before <iso> [--after <iso>] [--again]
      await mineMore({ slug: pos[0], before: flags.before, after: flags.after, again: !!flags.again, limit: Number(flags.limit) || (flags.before || flags.after ? 60 : 20), model: flags.model, dry: !!flags.dry });
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
      await seed({ areas: Number(flags.areas) || 12, model: flags.model, dry: !!flags.dry, prompts: flags.prompts, agent: typeof flags.agent === 'string' ? flags.agent : undefined });
      break;
    }
    case 'usage': {
      const days = Number(flags.days) || undefined;
      const u = summarize(store, { days, all: !flags.here });
      out(flags.json ? JSON.stringify(u, null, 2) : renderUsage(u, { days }));
      break;
    }
    case 'benchmark': {
      const sub = pos.shift();
      if (sub === 'report') {
        out(renderBenchmarkReport(latestBenchmark(store)));
        break;
      }
      if (sub !== 'run') {
        out('Run a small benchmark in this repository:\n  thinker benchmark run "explain how <a real workflow> works"\n  thinker benchmark report\n\nUse a concrete question that the cache has notes about. Each run makes two read-only agent calls; answers are saved for review.');
        break;
      }
      const task = pos.join(' ').trim();
      if (!task) { out('usage: thinker benchmark run "<repo question>" [--agent claude|codex|cursor|gemini] [--model m]'); process.exitCode = 1; break; }
      const selected = benchmarkAgent(typeof flags.agent === 'string' ? flags.agent : undefined);
      if (!selected) { out('benchmark needs an installed agent CLI: claude, codex, cursor (agent), or gemini'); process.exitCode = 1; break; }
      const oriented = await orient(store, { task, budget: Number(flags.budget) || 1000, recordUsage: false, backgroundVerify: false });
      if (!oriented.included.length) {
        out('No relevant notes matched that question, so a paired run would not test thinker. Try a more concrete question covered by `thinker list`, or build the cache first with `thinker setup`.');
        process.exitCode = 1; break;
      }
      const instruction = 'Read-only repository benchmark. Answer the request from the actual code. Be concrete and cite file:symbol locations. Do not edit files, run destructive commands, or change git state.';
      const baselinePrompt = `${instruction}\n\nREQUEST:\n${task}`;
      const cachePrompt = `${instruction}\n\n<thinker-cache>\n${oriented.text}\n</thinker-cache>\n\nUse relevant pointers above to avoid re-deriving known repository structure. Verify claims against code when needed.\n\nREQUEST:\n${task}`;
      out(`Running two read-only ${selected} calls for the same question (first without thinker, then with ${oriented.included.length} relevant notes).`);
      const baseline = await runBenchmarkAgent(selected, { repo, prompt: baselinePrompt, model: typeof flags.model === 'string' ? flags.model : undefined, timeoutMs: Number(flags.timeout) ? Number(flags.timeout) * 1000 : undefined });
      out(`  no cache: ${Math.round(baseline.wallMs / 1000)}s${baseline.inputTokens ? `, ${baseline.inputTokens} input tokens` : ''}`);
      const cached = await runBenchmarkAgent(selected, { repo, prompt: cachePrompt, model: typeof flags.model === 'string' ? flags.model : undefined, timeoutMs: Number(flags.timeout) ? Number(flags.timeout) * 1000 : undefined });
      out(`  thinker:  ${Math.round(cached.wallMs / 1000)}s${cached.inputTokens ? `, ${cached.inputTokens} input tokens` : ''}`);
      const record = { version: 1, createdAt: new Date().toISOString(), repo, task, agent: selected, model: typeof flags.model === 'string' ? flags.model : null, notes: oriented.included.map(n => n.id), runs: { baseline, cache: cached } };
      saveBenchmark(store, record);
      out('\n' + renderBenchmarkReport(record));
      break;
    }
    case 'stats': {
      const notes = store.list();
      const by = {}; for (const n of notes) by[n.status] = (by[n.status] || 0) + 1;
      const kinds = {}; for (const n of notes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      out(JSON.stringify({ repo, notes: notes.length, status: by, kinds, uses: notes.reduce((s, n) => s + (n.uses || 0), 0) }, null, 2));
      break;
    }
    case 'health': {
      const notes = store.list();
      out(`\n=== Thinker Cache Health Report for ${path.basename(repo)} ===\n`);
      out(`Total notes: ${notes.length}`);
      if (!notes.length) {
        out('The cache is empty. Run `thinker setup` to initialize.\n');
        break;
      }
      const kinds = {};
      const statusCounts = { fresh: 0, stale: 0, invalid: 0 };
      let withSays = 0;
      let brokenDeps = 0;
      const subs = {};

      const refreshed = refresh(store, notes, { persist: false });
      for (const n of refreshed) {
        kinds[n.kind] = (kinds[n.kind] || 0) + 1;
        statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
        if (n.says?.length) withSays++;
        const check = (n.deps || []).some(d => d.missing);
        if (check) brokenDeps++;
        const sub = (n.deps && n.deps[0]) ? subsystemForFile(repo, n.deps[0].path) : 'other';
        subs[sub] = (subs[sub] || 0) + 1;
      }

      out('\nKinds breakdown:');
      for (const [k, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
        out(`  ${k.padEnd(14)}: ${count}`);
      }

      out('\nSubsystem coverage:');
      for (const [s, count] of Object.entries(subs).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        out(`  ${s.padEnd(28)}: ${count} notes`);
      }

      out('\nQuality metrics:');
      out(`  Status:         ${statusCounts.fresh} fresh, ${statusCounts.stale} stale, ${statusCounts.invalid} invalid`);
      out(`  Phrasing:       ${withSays}/${notes.length} (${Math.round((withSays / notes.length) * 100)}%) notes have product phrasings`);
      out(`  Broken deps:    ${brokenDeps} notes point to missing files`);

      const alerts = [];
      if (!kinds.overview && !kinds.callpath) alerts.push('Cache lacks structural overview or callpath notes');
      if (kinds.invariant > 10 && (kinds.callpath || 0) + (kinds.overview || 0) < 3) alerts.push('Cache is skewed towards micro-rules with few structural maps');
      if (withSays < notes.length * 0.5) alerts.push('More than 50% of notes lack search phrasings (run `thinker phrase`)');
      if (brokenDeps > 0) alerts.push(`${brokenDeps} notes have broken file dependencies (run \`thinker check\`)`);

      if (alerts.length) {
        out('\nHealth warnings:');
        for (const a of alerts) out(`  ⚠ ${a}`);
      } else {
        out('\nHealth status: EXCELLENT (well balanced and grounded)');
      }
      out('');
      break;
    }
    default: out(HELP);
  }
}

async function init({ clients, hooks, learn, late, shared, mcp, gitHook }) {
  store.init();
  out(`initialized ${store.dir}`);
  for (const c of clients) for (const line of installClient(c, { repo, cli: path.join(HERE, 'cli.js'), mcpEntry: mcpEntry(), hooks, learn, late, shared, mcp })) out(line);
  if (clients.includes('codex') && (hooks || mcp) && !flags['no-trust']) {
    // Codex reads a project's .codex/ only once the project is trusted, and runs a hook only once it is reviewed
    let ok = !!flags.yes;
    if (!ok && process.stdin.isTTY) {
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`Codex: mark this repository as trusted${hooks ? " and thinker's hooks as reviewed" : ''} in your Codex config, so Codex uses them without asking? [Y/n] `); rl.close();
      ok = !/^n/i.test(a.trim());
    }
    if (ok) for (const line of trustCodex(repo)) out(line);
    else out('Codex: not marked as trusted; Codex asks you to trust the project and review the hooks before they run (--yes does it here without asking)');
  }
  if (clients.includes('cursor')) {
    // Cursor loads an MCP server only once it is approved for the workspace
    const agentBin = findBin(['agent', 'cursor-agent']);
    const r = agentBin ? spawnSync(agentBin, ['mcp', 'enable', 'thinker'], { cwd: repo, encoding: 'utf8', timeout: 60_000 }) : null;
    if (r && r.status === 0) out('Cursor: approved the thinker MCP server for this workspace');
    else out('Cursor: approve the thinker MCP server when Cursor asks (Settings → MCP), or run: agent mcp enable thinker');
  }
  if (gitHook) {
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    if (fs.existsSync(hook) && !fs.readFileSync(hook, 'utf8').includes('thinker')) out(`skipped git hook: ${hook} already exists and is not ours`);
    else { fs.writeFileSync(hook, `#!/bin/sh\n# thinker: re-hash note dependencies${learn ? ' and re-verify stale notes' : ''} in the background\nnohup node "${path.join(HERE, 'cli.js')}" check --quiet${learn ? ' --verify' : ''} --repo "${repo}" >/dev/null 2>&1 &\n`, { mode: 0o755 }); out('installed git post-commit hook'); }
  }
  if (!fs.existsSync(path.join(store.dir, 'cochange.json'))) { try { const idx = mineCochange(repo); out(`mined co-change edges from ${idx.commits} commits`); } catch {} }
  const gi = path.join(repo, '.thinker', '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
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
  const agent = typeof flags.agent === 'string' ? flags.agent : exploreAgent();
  const canBuild = !!provider();
  const canSeed = !!agent;
  const canMine = prs && hasBin('gh');
  out(`thinker setup for ${path.basename(repo)}`);
  out(`  clients:      ${clients.join(', ')}`);
  out(`  explore:      ${areas && canSeed ? `${areas} source areas, one ${agent} session each` : areas ? 'skipped (needs an agent CLI: claude, codex, agent or gemini)' : 'skipped'}`);
  out(`  merged PRs:   ${canMine && canBuild ? `up to ${prs} from ${slug}` : flags['no-prs'] || (slug && !prs) ? 'skipped' : !slug ? 'skipped (origin is not a GitHub repository)' : 'skipped (needs the gh CLI and an agent CLI)'}`);
  // measured on PostHog: ~$0.45 per exploration session incl. distillation, ~$0.06 per mined PR
  const est = (areas && canSeed ? areas * 0.45 : 0) + (canMine && canBuild ? prs * 0.06 : 0);
  out(`  learning:     ${learnOn() ? 'on: each session is distilled into notes when it ends, through the login of the agent that ran it (about $0.05 a session with Claude Sonnet; --no-learn turns it off)' : 'off'}`);
  if (est) out(`  model usage:  through your ${agent || provider()} login; roughly $${est.toFixed(0)} when measured with Claude Sonnet (varies with repo size and model)`);
  if (est && !flags.yes && process.stdin.isTTY) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question('Continue? [Y/n] '); rl.close();
    if (/^n/i.test(a.trim())) { out('stopped before building; nothing was changed'); return; }
  }
  await init({ clients, hooks: true, learn: learnOn(), late: !!flags.late, shared: !!flags.shared, mcp: true, gitHook: !!flags['git-hook'] });
  if (canMine && canBuild) await minePrs(slug, { limit: prs, model: flags.model, before: typeof flags.before === 'string' ? flags.before : undefined });
  if (areas && canSeed) await seed({ areas, model: flags.model, agent });
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  if (notes.length && canBuild && !flags['no-phrase']) {
    out(`generating search phrasings for ${notes.length} notes...`);
    try { await phraseNotes(store, notes, { model: flags.model }); } catch (e) { out(`phrasing warning: ${e.message}`); }
  }
  if (typeof flags.export === 'string') { execFileSync('node', [path.join(HERE, 'cli.js'), 'export', flags.export, '--repo', repo], { stdio: 'inherit' }); }
  out(`\nthinker is set up for ${path.basename(repo)}: ${notes.length} notes, served to ${clients.join(', ')}.`);
  if (!notes.length) out(learnOn() ? 'The cache is empty. It fills from your own sessions as you work.' : 'The cache is empty and learning is off. Re-run setup without --no-learn, or where an agent CLI is available.');
}

// mine-prs and learn --prs: the repo defaults to the GitHub origin, and what is needed is checked first
async function mineMore({ slug, ...opts }) {
  slug = slug || githubSlug();
  if (!slug) { out('merged PRs: origin is not a GitHub repository; name one: thinker mine-prs <owner/repo>'); return; }
  if (!hasBin('gh')) { out('merged PRs: needs the GitHub CLI (gh), logged in'); return; }
  if (!provider()) { out('merged PRs: needs an agent CLI (claude, codex, agent or gemini) or ANTHROPIC_API_KEY'); return; }
  store.init();
  return minePrs(slug, opts);
}

async function minePrs(slug, { before, after, again, limit = 20, model, dry }) {
  const rec = minedPrs(store, slug);
  const fetchLimit = Math.min(Math.max(limit * 3, 60), 250);
  // without a window: what was merged since the last run, then further back; never a PR mined before
  const listed = before || after
    ? listMergedPrs(slug, { before: before || new Date().toISOString(), after, limit: fetchLimit }).filter(p => again || !rec.mined.has(p.number))
    : nextPrs(slug, rec, { limit: fetchLimit });
  if (!listed.length) { out(`no merged PRs of ${slug} left to mine (${rec.mined.size} mined so far)`); return { cost: 0, saved: 0 }; }
  const failed = new Set();
  const filtered = listed
    .filter(p => !/^(chore|deps|docs|revert|ci|build|test)\b|\bbump\b|dependabot|renovate|snapshot/i.test(p.title) && (p.body || '').length > 120 && p.additions <= 600 && p.additions >= 5);
  const prs = stratifyPrs(filtered, limit);
  out(`${prs.length} PRs to mine (stratified across subsystems from ${filtered.length} candidates)`);
  let cost = 0, saved = 0;
  for (const pr of prs) {
    try {
      const r = await distillPr(slug, pr, { model: model || store.config().distillModel || 'sonnet' });
      cost += r.cost || 0;
      if (dry) { out(`#${pr.number} ${pr.title.slice(0, 60)} → ${r.notes.map(n => n.kind).join(',') || '-'}`); continue; }
      const s2 = saveNotes(store, r.notes, { source: { type: 'pr', ref: `${slug}#${pr.number}` } });
      saved += s2.saved.length + s2.merged.length;
      out(`#${pr.number} ${pr.title.slice(0, 60)} → ${[...s2.saved, ...s2.merged].map(n => `[${n.kind}] ${n.id}`).join(', ') || '-'}${s2.skipped.length ? ` (skipped ${s2.skipped.length})` : ''}`);
    } catch (e) { failed.add(pr.number); out(`#${pr.number} error ${String(e.message).slice(0, 120)}`); }
  }
  // PRs passed over by the filter are recorded too; failed ones are not, so the next run takes them again
  if (!dry) { recordMinedPrs(store, slug, listed.filter(p => !failed.has(p.number))); store.log({ op: 'mine-prs', slug, prs: prs.length - failed.size, passed: listed.length - prs.length, saved, cost }); }
  out(`mined ${prs.length - failed.size} PRs → ${saved} notes, cost $${cost.toFixed(2)}${rec.mined.size ? ` (${rec.mined.size} mined earlier were skipped)` : ''}`);
  return { cost, saved };
}

function sourceAreas(limit) {
  return discoverAreas(repo, { limit });
}

// One read-only exploration session with the given agent; returns the file
// holding its transcript (the agent's own, or its streamed output).
function explore(agent, prompt, model) {
  const env = { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const opts = { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, env };
  const bin = findBin({ claude: ['claude'], codex: ['codex'], cursor: ['agent', 'cursor-agent'], gemini: ['agy', 'gemini'] }[agent] || []);
  if (!bin) return { error: `the ${agent} CLI was not found` };
  const stream = path.join(store.dir, 'state', `explore-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(stream), { recursive: true });
  if (agent === 'claude') {
    const r = spawnSync(bin, ['-p', '--model', model || 'sonnet', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit,Write,NotebookEdit', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '40'], { ...opts, input: prompt });
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    const transcript = transcriptsFor(repo).find(f => f.includes(j.session_id));
    return transcript ? { transcript, cost: j.total_cost_usd || 0, turns: j.num_turns } : { error: 'no transcript found' };
  }
  const m = model && !['haiku', 'sonnet', 'opus', 'fable'].includes(model) ? model : process.env.THINKER_LLM_MODEL;
  if (path.basename(bin) === 'agy') {
    const agyArgs = ['-p', prompt, '--model', m || 'gemini-3.8-flash-high', '--output-format', 'json', '--dangerously-skip-permissions'];
    const r = spawnSync(bin, agyArgs, { ...opts, cwd: repo });
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    const convId = j.conversation_id;
    if (convId) {
      const transcript = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcript)) return { transcript, cost: 0, turns: j.num_turns };
    }
    return { error: 'agy transcript not found: ' + (r.stderr || r.stdout || '').slice(0, 200) };
  }
  let r;
  if (agent === 'codex') r = spawnSync(bin, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...(m ? ['--model', m] : []), '--cd', repo, '-'], { ...opts, input: prompt });
  else if (agent === 'cursor') r = spawnSync(bin, ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', ...(m ? ['--model', m] : []), '--workspace', repo, prompt], opts);
  else r = spawnSync(bin, ['--output-format', 'stream-json', ...(m ? ['-m', m] : [])], { ...opts, input: prompt });
  if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || '').slice(0, 200) };
  // failures these CLIs report inside their output (usage limits, auth)
  for (const l of String(r.stdout).split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'turn.failed' || (j.type === 'result' && j.is_error)) return { error: String(j.error?.message || j.result || j.message || 'failed').slice(0, 200) };
  }
  fs.writeFileSync(stream, r.stdout);
  return { transcript: stream, temp: true };
}

async function seed({ areas, model, dry, prompts, agent }) {
  const areaList = discoverAreas(repo, { limit: areas });
  const list = prompts ? JSON.parse(fs.readFileSync(prompts, 'utf8')).map(p => ({ prompt: p })) : areaList.map(a => {
    if (a.isFile) {
      return {
        dir: a.dir, n: a.n,
        prompt: `Orient a new contributor in ${a.dir}: what this module is responsible for, its primary classes and functions (cite file:symbol), how control and data flow into and out of it, the key invariants and conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
      };
    }
    return {
      dir: a.dir, n: a.n,
      prompt: `Orient a new contributor in ${a.dir}/ (${a.n} source files): what this subsystem is responsible for, its main entry points and how control flows into and out of it (cite file:symbol), the two or three things that must change together when extending it, local conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
    };
  });
  if (dry) { for (const a of list) out(`${(a.dir || '-').padEnd(40)} ${a.n || ''}`); return; }
  agent = agent || exploreAgent();
  if (!agent) { out('no agent CLI found to explore with (claude, codex, agent or gemini)'); return; }
  let cost = 0, ok = 0;
  for (const a of list) {
    const t0 = Date.now();
    const label = (a.dir || a.prompt.slice(0, 40)).padEnd(40);
    const r = explore(agent, a.prompt, model);
    if (r.error) { out(`${label} ${agent} failed: ${r.error}`); continue; }
    cost += r.cost || 0; ok++;
    out(`${label} ${agent}${r.turns ? ` ${r.turns} turns` : ''}${r.cost ? ` $${r.cost.toFixed(2)}` : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    try { await distillFile(r.transcript, { minExplore: 1, dry: false, model: undefined, quiet: false, incremental: false }); } catch (e) { out(`${label} distill failed: ${String(e.message).slice(0, 160)}`); }
    if (r.temp) fs.rmSync(r.transcript, { force: true });
  }
  out(`explored ${ok} of ${list.length} areas with ${agent}${cost ? `, agent cost $${cost.toFixed(2)}` : ''}`);
}
// the agent that explores: THINKER_LLM if it names one, else the first installed
function exploreAgent() {
  const agents = available().filter(p => ['claude', 'codex', 'cursor', 'gemini'].includes(p));
  return agents.includes(process.env.THINKER_LLM) ? process.env.THINKER_LLM : agents[0] || null;
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

// Catch-up learning: works without any end-of-session hook, so it covers
// agents and modes that do not fire one (Cursor's headless mode, for one).
async function learn({ days, idleMin, max, dry, quiet }) {
  if (NO_LEARN) { if (!quiet) out('learning is switched off (THINKER_NO_LEARN)'); return; }
  const lock = path.join(store.init().dir, 'state', 'learn.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 15 * 60_000) { if (!quiet) out('another learn run is in progress'); return; } } catch {}
  if (!dry) fs.writeFileSync(lock, String(process.pid));
  try {
    const sessions = findSessions(repo, { sinceMs: days * 86400_000, storeDir: store.dir }).filter(s => Date.now() - s.mtime >= idleMin * 60_000);
    let done = 0;
    for (const s of sessions) {
      let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', path.basename(s.file).replace(/\.jsonl?$/, '') + '.json'), 'utf8')); } catch {}
      let total = 0; try { total = parseTranscript(s.file).lineCount; } catch { continue; }
      if ((state.line || 0) >= total) continue;
      if (done >= max) break;
      if (dry) { out(`${s.client.padEnd(7)} ${s.session}  ${total - (state.line || 0)} new lines`); continue; }
      if (!quiet) out(`${s.client} ${s.session}`);
      process.env.THINKER_LLM_PREFER = s.client;
      try { await distillFile(s.file, { minExplore: 3, quiet, incremental: true, session: s.session }); done++; } catch (e) { if (!quiet) out(`  failed: ${String(e.message).slice(0, 160)}`); }
    }
    if (!quiet && !dry) out(`learned from ${done} of ${sessions.length} sessions`);
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}
// From a hook: start catch-up in the background, at most every ten minutes.
function learnInBackground(client) {
  if (NO_LEARN) return;
  const mark = path.join(store.dir, 'state', 'learn.last');
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 10 * 60_000) return; } catch {}
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, '');
  spawn('node', [path.join(HERE, 'cli.js'), 'learn', '--quiet', '--days', '2', '--max', '5', '--repo', repo], { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } }).unref();
}

async function distillFile(file, { minExplore, dry, model, quiet, incremental, format, session }) {
  const stateDir = path.join(store.dir, 'state');
  const stateFile = path.join(stateDir, path.basename(file).replace(/\.jsonl?$/, '') + '.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const fromLine = incremental ? (state.line || 0) : 0;
  const { events, lineCount } = parseTranscript(file, { fromLine, format });
  hydrate(events, repo, { trace: session ? traceFile(store.dir, session) : null });
  // a turn-end hook and a session-end hook can both ask for the same session
  const lock = stateFile + '.lock';
  if (incremental && !dry) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return; } catch {}
    fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  }
  try { return await distillEventsToNotes(); } finally { if (incremental && !dry) fs.rmSync(lock, { force: true }); }
  async function distillEventsToNotes() {
  const n = exploreCount(events);
  if (n < minExplore) { if (!quiet) out(`only ${n} exploration calls since last distill (<${minExplore}); nothing to distill`); return; }
  if (!events.some(e => e.t === 'say')) { if (!quiet) out('the session has no answer from the agent yet; nothing to distill'); return; }
  // notes served in this session: named in the transcript, or recorded on the note when a hook served it
  const ids = new Set(injectedIds(file, { fromLine }));
  if (session) for (const n of store.list()) if ((n.servedIn || []).includes(session)) ids.add(n.id);
  const served = [...ids].filter(id => !(incremental && (state.assessed || []).includes(id))).map(id => store.get(id)).filter(Boolean);
  const r = await distillEvents(events, { model: model || store.config().distillModel || 'sonnet', repoHint: repo, served });
  if (dry) { out(JSON.stringify({ notes: r.notes, assessments: r.assessments }, null, 2)); out(`(${r.notes.length} notes, cost $${(r.cost || 0).toFixed(3)}, trace ${r.traceChars} chars)`); return; }
  const s = saveNotes(store, r.notes, { source: { type: 'agent', ref: path.basename(file, '.jsonl') } });
  // under the session's id, which is what servings are logged under: a transcript's file name is
  // that id only for Claude Code (Codex adds a date, a recorded trace a prefix, Gemini another suffix)
  const applied = attest(store, r.assessments, { session: session || sessionKey(path.basename(file)) });
  if (!quiet) for (const a of applied) out(`attest  ${a.verdict.padEnd(12)} ${a.id} → c=${Math.round(a.confidence * 100)}%`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ line: lineCount, assessed: [...new Set([...(state.assessed || []), ...served.map(n => n.id)])], at: new Date().toISOString() }));
  store.log({ op: 'distill', transcript: path.basename(file), explore: n, saved: s.saved.map(x => x.id), merged: s.merged.map(x => x.id), skipped: s.skipped, cost: r.cost });
  if (!quiet) {
    for (const x of s.saved) out(`saved   ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.merged) out(`merged  ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.skipped) out(`skipped ${x.title}: ${x.reason}`);
    out(`distilled ${events.length} events (${n} exploration calls) → ${s.saved.length} new, ${s.merged.length} merged${r.cost ? `; cost $${r.cost.toFixed(3)}` : ""}`);
  }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
