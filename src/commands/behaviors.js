// `thinker behaviors`: the repository's behavior graph as the hooks read it (behaviors.js, one computation): the
// features and the behaviors beneath them with how many tests name each, what a change did to them since a base
// commit, the tests that change has to pass and what it still owes the graph. Nothing is run and nothing is
// written; the hooks that hold an agent to it are behavior-hooks.js. `--base <ref>` counts the change from
// another commit than HEAD (`origin/main`, say, for a whole branch); `--json` is the same reading as data.
import { BEHAVIORS_FILE, readGraph, isFeature } from '../behaviors.js';
import { behaviorsConfig } from '../behavior-hooks.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The reading in lines, as the command prints it. */
export function renderBehaviors(g, { on = true } = {}) {
  const { tree, index, changes: ch, selection: sel } = g, L = [];
  if (!tree.nodes.size) return [`This repository names no behaviors: there is no ${BEHAVIORS_FILE} here, so thinker holds nothing to one.`];
  const state = id => (ch.added.includes(id) ? '  + added' : ch.modified.includes(id) ? '  ~ modified' : ch.tests.includes(id) ? '  ~ tests changed' : '');
  L.push(`Behaviors (${BEHAVIORS_FILE})${on ? '' : '   [the hooks are off: behaviors.enabled]'}`);
  const walk = (id, depth) => {
    const n = tree.nodes.get(id), t = (index.tests.get(id) || []).length, c = (index.code.get(id) || []).length;
    const held = isFeature(tree, id) ? (t ? plural(t, 'end-to-end test') : '') : `${plural(t, 'test')}${c ? '' : ', no code tied'}`;
    L.push(`${'  '.repeat(depth + 1)}${id}: ${n.text}${held ? `   [${held}]` : ''}${n.uses.length ? `   uses ${n.uses.join(', ')}` : ''}${state(id)}`);
    for (const k of n.children) walk(k, depth + 1);
  };
  for (const n of tree.nodes.values()) if (!n.parent) walk(n.id, 0);
  for (const id of ch.deleted) L.push(`  ${id}  - deleted`);
  if (sel.tests.length) {
    L.push('', 'Tests this change has to pass:');
    for (const t of sel.tests) L.push(`  ${t.rel}${t.e2e ? '  [end-to-end]' : ''}  ${t.why.map(w => (w.as === 'own' ? w.id : `${w.id} (${w.as})`)).join('; ')}`);
    if (g.command) L.push('', `  ${g.command}`);
  } else L.push('', sel.direct.length ? 'No test names the behaviors this change touched.' : 'No behavior has changed since the base.');
  if (sel.problems.length) { L.push('', 'Owed to the graph:'); for (const p of sel.problems) L.push(`  - ${p}`); }
  return L;
}

async function behaviorsCommand({ flags, repo, out }) {
  const g = readGraph(repo, typeof flags.base === 'string' ? flags.base : undefined);
  if (flags.json) {
    const { tree, index, changes: ch, selection: sel } = g;
    out(JSON.stringify({
      behaviors: [...tree.nodes.values()].map(n => ({ id: n.id, text: n.text, parent: n.parent, uses: n.uses, tests: index.tests.get(n.id) || [], code: index.code.get(n.id) || [] })),
      changes: { base: ch.base, modified: ch.modified, added: ch.added, deleted: ch.deleted, tests: ch.tests },
      tests: sel.tests, command: g.command, owed: sel.problems,
    }, null, 2));
    return;
  }
  for (const l of renderBehaviors(g, { on: behaviorsConfig().enabled })) out(l);
}

export const commands = { behaviors: behaviorsCommand };
