// `thinker containers`: the agents on this machine that run in a container, and putting thinker in there
// with them. See src/containers.js for why a container gets nothing from an install on the host.
import { execFileSync } from 'node:child_process';
import { findAgentContainers, installInContainer, containerSnippet, describeContainer, worktreeMounts } from '../containers.js';
import { knownRepos } from '../usage.js';
import { thinkerHome } from '../update.js';

const WIRABLE_NOTE = 'thinker is on this machine but not inside the container, so the agent in there gets no notes and nothing is learned from its sessions.';

export async function containersCommand({ flags = {}, store, out = console.log, exec = execFileSync } = {}) {
  if (flags.devcontainer) { out(containerSnippet()); return; }

  let repos = [];
  // every checkout this machine's log has named (usage.js:knownRepos keeps them per origin), so an offer is
  // about the person's own work and never about a container that happens to run on the machine
  try { repos = knownRepos(store, { all: true }).flatMap(r => r.checkouts || []).filter(Boolean); } catch {}
  const found = findAgentContainers({ exec, repos, home: thinkerHome() });

  if (flags.json) { out(JSON.stringify(found, null, 2)); return; }

  if (!found.docker) { out('thinker containers: no docker on this machine, so there is nothing to look at.'); return; }
  if (!found.containers.length) { out('thinker containers: no running container has a coding agent in it.'); return; }

  const wirable = found.containers.filter(c => c.wirable);
  const target = flags.install;
  if (target) {
    const picked = target === true || target === 'all' ? wirable
      : found.containers.filter(c => c.id.startsWith(String(target)) || c.name === target);
    if (!picked.length) { out(`thinker containers: no container matches ${target === true ? 'anything to install into' : `"${target}"`}.`); process.exitCode = 1; return; }
    for (const c of picked) {
      if (!c.wirable) { out(`${c.name || c.id}: ${describeContainer(c).split(' -- ').pop()}; nothing done.`); continue; }
      out(`${c.name || c.id}: installing thinker and wiring ${c.agents.join(', ')}…`);
      const r = installInContainer(c, { exec });
      for (const s of r.steps) out(`  ${s.ok ? '✓' : '✗'} ${s.what}${s.detail ? ` — ${String(s.detail).split('\n')[0].slice(0, 120)}` : ''}`);
      if (r.ok) {
        out(`  thinker is in ${r.target} and ${r.wired} read it from inside. The cache is the one in the checkout you already mount, so the notes and what it learns stay in the repository.`);
        const worktrees = worktreeMounts(c);
        if (worktrees.length) out(`  One thing to know: ${worktrees.map(m => m.inside).join(', ')} is a git worktree, whose .git names a path on the host. git cannot read it inside the container, so thinker will find no repository there. Mount the main checkout instead, or clone inside.`);
        out('  A container rebuild wipes this. To keep it: thinker containers --devcontainer');
      } else { process.exitCode = 1; }
    }
    return;
  }

  out('Containers running a coding agent:\n');
  for (const c of found.containers) out('  ' + describeContainer(c));
  if (wirable.length) {
    out(`\n${WIRABLE_NOTE}`);
    out(`Install it in ${wirable.length === 1 ? 'the one that can take it' : 'them'}: thinker containers --install ${wirable.length === 1 ? (wirable[0].name || wirable[0].id) : 'all'}`);
    out('Keep it across rebuilds: thinker containers --devcontainer');
  }
}

export const commands = { containers: containersCommand };
