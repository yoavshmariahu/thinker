// Agents that run in a container, on a machine where thinker is installed on the host.
//
// Why this exists. A devcontainer has its own home, so the wiring thinker writes on the host
// (`~/.claude/settings.json` and the rest) is not what the agent inside reads -- and when the container
// mounts the host's agent home, which is the common pattern so a login is not repeated, the agent does read
// thinker's hooks and every one of them names a path on the host that does not exist inside, so each fails
// and the agent swallows it. Either way the session gets no notes, nothing is learned from it, and the
// machine reports an agent used daily with no request against the cache (telemetry.js:recentSessions,
// `sessionStore: 'missing'`). Measured on production telemetry on 2026-11-05: 20 machines used an agent that
// day and 13 of them asked the cache nothing.
//
// What works, tested live on 2026-11-05 against a `mcr.microsoft.com/devcontainers/javascript-node:22`
// container with the repository bind-mounted: copy this install into the container, run `connect` inside,
// and the agent's prompt hook there serves notes out of the repository's own cache, with every pointer
// resolved against the code inside the container. The repository is already shared -- it is the bind mount
// the person works in -- so the cache needs no copying and what the session learns lands in the same place.
//
// What this does not do: the container cannot reach the proxy on the host (it binds loopback), so the
// clearing does not reach those sessions yet; and an install copied from macOS into a linux container
// carries no working native modules, so the local reranker is absent there (the regex and wasm paths are
// not). Nothing here reads a container's environment, command line or image labels: the names below are a
// container's id, its image, its mount paths and the agent binaries found on its PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { thinkerHome } from './update.js';

// the agents thinker wires that have a command of their own to find on a PATH (clients.js:BINS and the
// other integrations); a container that has none of these is not a container anybody codes in
export const AGENT_BINS = {
  claude: ['claude'], codex: ['codex'], cursor: ['cursor-agent', 'agent'], gemini: ['gemini', 'agy'],
  copilot: ['copilot'], opencode: ['opencode'], goose: ['goose'], devin: ['devin'], droid: ['droid'],
  qwen: ['qwen'], kiro: ['kiro-cli'], cline: ['cline'], kilo: ['kilo'], augment: ['auggie'], windsurf: ['windsurf'],
};
// Native modules built for the host are the wrong architecture inside, and they are most of the bytes
// (onnxruntime 427 MB of a 566 MB install on 2026-11-05). The copy leaves them out, with the repository's
// own tests and research output, so what goes in is about 140 MB of JavaScript and wasm.
export const COPY_EXCLUDES = ['node_modules/onnxruntime-node', 'node_modules/onnxruntime-web', 'node_modules/@img', 'node_modules/@huggingface', 'test', 'research', '.git'];
const EXEC_TIMEOUT = 20_000;

const run = (args, { exec = execFileSync, timeout = EXEC_TIMEOUT, input } = {}) =>
  String(exec('docker', args, { encoding: 'utf8', timeout, input, stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 })).trim();

// Whether this machine has a docker that answers. Never a reason to warn: most machines have none.
export function dockerAvailable({ exec = execFileSync } = {}) {
  try { run(['version', '--format', '{{.Server.Version}}'], { exec, timeout: 5000 }); return true; } catch { return false; }
}

// One probe per container, in one `docker exec`: which agents are on its PATH, whether thinker is already
// there, and the home the agent would read its wiring from. A container that refuses exec (paused, or a
// runtime that does not allow it) is reported with the reason and never offered.
function probe(id, { exec = execFileSync } = {}) {
  const names = Object.entries(AGENT_BINS).flatMap(([client, bins]) => bins.map(b => `${client}:${b}`));
  const script = [
    `for pair in ${names.join(' ')}; do`,
    '  client=${pair%%:*}; bin=${pair#*:};',
    '  command -v "$bin" >/dev/null 2>&1 && echo "agent=$client";',
    'done;',
    'command -v thinker >/dev/null 2>&1 && echo "thinker=path";',
    '[ -d "$HOME/.thinker/app" ] && echo "thinker=home";',
    'command -v node >/dev/null 2>&1 && echo "node=$(node -v 2>/dev/null)";',
    'echo "home=$HOME"',
  ].join(' ');
  try {
    const out = run(['exec', id, 'sh', '-lc', script], { exec });
    const lines = out.split('\n').map(l => l.trim());
    const value = key => (lines.find(l => l.startsWith(key + '=')) || '').slice(key.length + 1) || null;
    return {
      agents: [...new Set(lines.filter(l => l.startsWith('agent=')).map(l => l.slice(6)))],
      thinker: lines.some(l => l.startsWith('thinker=')),
      node: value('node'), home: value('home'), reachable: true, why: null,
    };
  } catch (err) {
    return { agents: [], thinker: false, node: null, home: null, reachable: false, why: String(err?.message || err).split('\n')[0].slice(0, 120) };
  }
}

// The containers running right now that an agent works in, with the bind mounts they share with this
// machine. `repos` (usage.js:knownRepos) is what makes an offer about the person's own work rather than
// about every container on the machine: a mount whose host side is a repository this machine's log has
// named, or holds a cache, is one they work in.
export function findAgentContainers({ exec = execFileSync, repos = [], home = thinkerHome() } = {}) {
  if (!dockerAvailable({ exec })) return { docker: false, containers: [] };
  let ids = [];
  try { ids = run(['ps', '--format', '{{.ID}}'], { exec }).split('\n').filter(Boolean); } catch { return { docker: true, containers: [] }; }
  const known = new Set(repos.map(r => path.resolve(r)));
  const out = [];
  for (const id of ids.slice(0, 40)) {
    let info = null;
    try { info = JSON.parse(run(['inspect', id], { exec }))[0]; } catch { continue; }
    const mounts = (info?.Mounts || []).filter(m => m.Type === 'bind' && m.Source && m.Destination)
      .map(m => ({ host: m.Source, inside: m.Destination }));
    // a mount this machine works in: a repository it has seen, or any checkout with a cache in it
    const shared = mounts.filter(m => known.has(path.resolve(m.host)) || isCheckout(m.host));
    const p = probe(id, { exec });
    // A container we could look into and found no agent in is not a container anybody codes in. One we
    // could not look into is only worth naming when it works in a checkout this machine shares -- then it
    // is plausibly the person's dev container and the reason belongs in the list; otherwise it is somebody
    // else's service and none of thinker's business.
    if (p.reachable ? !p.agents.length : !shared.length) continue;
    out.push({
      id, image: info?.Config?.Image || null, name: (info?.Name || '').replace(/^\//, '') || null,
      agents: p.agents, thinker: p.thinker, node: p.node, home: p.home,
      reachable: p.reachable, why: p.why, mounts, shared,
      // what a wiring would be worth: an agent, a shared checkout to serve from, and a node to run on
      wirable: p.reachable && !p.thinker && !!p.node && shared.length > 0,
    });
  }
  return { docker: true, containers: out, home };
}

const isCheckout = dir => { try { return fs.existsSync(path.join(dir, '.thinker')) || fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

// A git worktree cannot be used from inside a container on its own: its `.git` is a file naming a gitdir on
// the host, so `git rev-parse` fails inside and thinker finds no repository at all (seen on 2026-11-05: the
// hook ran, found nothing, and said nothing). Worth saying before an install rather than after.
export function worktreeMounts(container) {
  return (container.shared || []).filter(m => { try { return fs.statSync(path.join(m.host, '.git')).isFile(); } catch { return false; } });
}

// Copy this install into the container and wire the agents found there. No network, and the same build as
// the host, so the container cannot end up on another version. `tar` rather than `docker cp`, because the
// native modules must be left out (COPY_EXCLUDES) and `docker cp` takes no excludes.
export function installInContainer(container, { app = path.join(thinkerHome(), 'app'), exec = execFileSync, spawn = spawnSync, clients } = {}) {
  const home = container.home || '/root';
  const target = `${home}/.thinker/app`;
  const steps = [];
  const step = (what, fn) => { try { const detail = fn(); steps.push({ what, ok: true, detail: detail || null }); return true; } catch (err) { steps.push({ what, ok: false, detail: String(err?.message || err).split('\n')[0].slice(0, 200) }); return false; } };

  if (!step('make the directory', () => run(['exec', '-u', 'root', container.id, 'sh', '-lc', `mkdir -p ${target} && chown -R $(stat -c %u:%g ${home}) ${home}/.thinker`], { exec })))
    return { ok: false, steps, target };

  // tar on this side, untar inside: one stream, no temporary file, excludes honoured
  if (!step('copy thinker in', () => {
    const args = ['-cf', '-', ...COPY_EXCLUDES.flatMap(e => ['--exclude', e]), '.'];
    const tar = spawn('tar', args, { cwd: app, maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' });
    if (tar.status !== 0) throw new Error(`tar exited ${tar.status}: ${String(tar.stderr || '').slice(0, 120)}`);
    const put = spawn('docker', ['exec', '-i', '-u', 'root', container.id, 'tar', '-xf', '-', '-C', target], { input: tar.stdout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    if (put.status !== 0) throw new Error(`untar exited ${put.status}: ${String(put.stderr || '').slice(0, 120)}`);
    return `${Math.round(tar.stdout.length / 1e6)} MB`;
  })) return { ok: false, steps, target };

  step('give it to the container user', () => run(['exec', '-u', 'root', container.id, 'sh', '-lc', `chown -R $(stat -c %u:%g ${home}) ${home}/.thinker`], { exec }));

  const wire = (clients || container.agents).join(',');
  const connected = step('wire the agents inside', () =>
    // `--no-proxy`, and it is not optional. A plain `connect` enables the context proxy as a service of the
    // machine: it writes `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` into the agent's settings and leaves
    // launchd or systemd to keep the process up. A container has neither, and the detached fallback does not
    // survive in one -- measured on 2026-11-05 in a devcontainer: the URL was written, the service recorded
    // itself as on, and nothing was ever listening on the port, including after a prompt. Claude Code in
    // there would have sent every request to a dead loopback port and failed every model call. That is the
    // fault the mandatory rule is about ("the proxy never takes over someone else's route... never trade a
    // person's working harness for it"), and an install that caused it would be worse than no install.
    //
    // So a container gets the hooks, the MCP server and the notes, and its route is left exactly as it is.
    // The clearing does not reach these sessions yet; making it would mean a proxy that stays up inside a
    // container, or one on the host the container can reach, and either is its own change with its own
    // measurement.
    run(['exec', container.id, 'sh', '-lc', `cd ${home} && node ${target}/src/cli.js connect --clients ${wire} --no-proxy 2>&1 | tail -3`], { exec, timeout: 120_000 }));
  const version = step('check it runs', () => run(['exec', container.id, 'sh', '-lc', `node ${target}/src/cli.js version`], { exec, timeout: 60_000 }));
  return { ok: connected && version, steps, target, wired: wire };
}

// The same install, made part of the image so a rebuild keeps it. Printed, never written: a person's
// devcontainer or Dockerfile is theirs.
export function containerSnippet({ version = 'latest' } = {}) {
  return [
    '// .devcontainer/devcontainer.json -- thinker inside the container, kept across rebuilds',
    '{',
    '  "postCreateCommand": "npx -y thinkersh --no-build",',
    '  // the cache lives in the repository you already mount, so nothing else is needed;',
    '  // mount a volume at ~/.thinker to keep what it learns about this machine across rebuilds:',
    '  "mounts": ["source=thinker-home,target=/home/node/.thinker,type=volume"]',
    '}',
    '',
    '# or in a Dockerfile',
    `RUN npx -y thinkersh --no-build${version && version !== 'latest' ? `  # pins ${version}` : ''}`,
  ].join('\n');
}

// One line per container for a terminal, and the reason a container is not offered.
export function describeContainer(c) {
  const where = c.shared.length ? c.shared.map(m => m.inside).join(', ') : 'no shared checkout';
  const state = c.thinker ? 'thinker already inside'
    : !c.reachable ? `cannot run a command in it (${c.why})`
    : !c.node ? 'no node inside to run thinker'
    : !c.shared.length ? 'works in no checkout this machine shares'
    : 'can be wired';
  return `${c.name || c.id}  ${c.agents.join(', ')}  ${where}  -- ${state}`;
}
