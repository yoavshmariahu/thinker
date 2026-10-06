// Step gates for `thinker review`: one Jev call decides which of the review's optional steps are
// worth running for this particular change, instead of each being a flag that is on or off for
// every change alike. Speculative fan-out: every gate is asked in the same request, they run in
// parallel and cannot see one another, and code consumes only the answers that apply.
//
// Two rules the thresholds follow, and they are not symmetric:
//   * a gate never silences work on a low probability alone. Skipping a step is invisible -- nothing
//     tells you what the skipped step would have found -- so the bar to skip is high and the bar to
//     do the work is low.
//   * an uncertain answer does the work. `fallback` is what happens when the call fails, is slow, or
//     comes back outside the band the gate trusts.
import { jevConfig, jevScores } from './jev.js';

// What Jev is shown of the change: named fields, not a bag of words (jev.js:noteRecord does the same
// for a note). Measured for serving: named fields beat one prose blob of the same content.
export function changeRecord(change, symbols) {
  const freq = new Map();
  let added = 0, removed = 0;
  for (const f of change.files) for (const h of f.hunks || []) for (const l of h.lines || []) {
    if (l.startsWith('+')) added++; else if (l.startsWith('-')) removed++;
    if (!l.startsWith('+')) continue;
    const code = l.slice(1).replace(/\/\/.*$|#.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ');
    for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) freq.set(m[0], (freq.get(m[0]) || 0) + 1);
  }
  // The gates need the lines themselves. Without them `worth_reviewing` cannot tell a comment reflow
  // from a logic change (it scored one at 0.61) and `tests` cannot see an off-by-one (0.38): the
  // counts and identifiers describe the shape of a change, not what it does.
  const sample = [];
  for (const f of change.files) {
    const lines = (f.hunks || []).flatMap(h => (h.lines || []).filter(l => l.startsWith('+') || l.startsWith('-')));
    if (!lines.length) continue;
    sample.push({ path: f.path, lines: lines.slice(0, 24).map(l => l.slice(0, 200)) });
    if (sample.length >= 8) break;
  }
  return {
    files_changed: change.files.map(f => f.path).slice(0, 40),
    file_count: change.files.length,
    lines_added: added,
    lines_removed: removed,
    definitions_touched: symbols.flatMap(s => s.changed).slice(0, 40),
    definitions_removed: symbols.flatMap(s => (s.removed || []).map(r => r.qualified || r)).slice(0, 20),
    identifiers_added: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w),
    changed_lines: sample,
  };
}

// `act` is the probability at or above which the step runs. `fallback` is what happens with no
// answer. `strategy` names the key in review's strategy object the gate decides, when the caller
// left it unset.
export const GATES = {
  worth_reviewing: {
    strategy: null, act: 0.15, fallback: true,   // review unless Jev is quite sure there is nothing to review
    instructions: 'Read `the_change.changed_lines`. Could these lines plausibly introduce a defect, or alter behaviour a person depends on?',
    criteria: {
      true: 'It changes what the code does, or could: logic, control flow, data, configuration that takes effect, or a dependency version.',
      false: 'It cannot change behaviour: formatting, comments, a pure rename carried through consistently, generated output, or documentation.',
    },
  },
  callers: {
    strategy: 'callers', act: 0.5, fallback: false,
    instructions: 'To judge `the_change`, would it be necessary to see the code that CALLS the definitions it alters, rather than the definitions alone?',
    criteria: {
      true: 'It changes a signature, a return shape, a thrown error, a default, or a precondition — so whether it is correct depends on the call sites.',
      false: 'It is contained: whether it is correct can be judged from the changed code and the diff alone.',
    },
  },
  chunks: {
    strategy: null, act: 0.6, fallback: false,
    instructions: 'Is `the_change` too large or too spread out to be judged carefully in a single pass?',
    criteria: {
      true: 'Many files, or unrelated concerns mixed together, so reading it as one piece would lose detail.',
      false: 'Small enough, or coherent enough, to hold in one reading.',
    },
  },
  verify: {
    strategy: 'verify', act: 0.6, fallback: false,
    instructions: 'Read `the_change.changed_lines`. Could a reviewer reading only these lines raise a complaint about them that turns out to be wrong?',
    criteria: {
      true: 'It is subtle, relies on context not visible in the diff, or follows a convention that looks wrong without it — a first reading could misjudge it.',
      false: 'It is plain enough that a complaint about it would be straightforwardly right or wrong.',
    },
  },
  tests: {
    // Only a recommendation in the report, never an execution, so a wrong suggestion costs a line of
    // text and a missed one costs a silent bug: measured 0.03 on a comment reflow, 0.78 on a cache key,
    // 0.56 on a dropped SQL condition, which is the case worth catching.
    strategy: null, act: 0.5, fallback: false,
    instructions: 'Read `the_change.changed_lines`. Could these lines be wrong in a way that reading them would NOT reveal, so that only running the code would show it?',
    criteria: {
      true: 'Being wrong here would look correct on the page: a query, a serialization or cache key, a concurrency or ordering assumption, a format or protocol detail, a value that must match something elsewhere.',
      false: 'If these lines were wrong, a careful reader would see it on the page.',
    },
  },
};

// One call, every gate. Returns a map of name -> { p, run } plus `source`, or null when Jev is off.
// Any failure returns every gate at its fallback, so review behaves exactly as it does today.
export async function reviewGates(store, change, symbols, { gates = GATES, fetchImpl } = {}) {
  const names = Object.keys(gates);
  const fall = () => Object.fromEntries(names.map(n => [n, { p: null, run: gates[n].fallback }]));
  const cfg = jevConfig(store);
  if (!cfg.enabled || !change.files.length) return { gates: fall(), source: 'default' };
  const record = changeRecord(change, symbols);
  // jevScores asks one question per candidate; here the candidates are the gates themselves, so the
  // "notes" it is handed are the gate descriptions and the state is the change.
  const asNotes = names.map(n => ({ id: n, kind: 'gate', title: n, body: gates[n].instructions }));
  try {
    const scores = await jevScores(record, asNotes, {
      ...cfg, ...(fetchImpl ? { fetchImpl } : {}),
      subject: 'the_change',
      criteria: i => gates[names[i]].criteria,
      question: i => ({ question: gates[names[i]].instructions }),
    });
    return {
      gates: Object.fromEntries(names.map((n, i) => {
        const p = scores[i];
        const run = Number.isFinite(p) ? p >= gates[n].act : gates[n].fallback;
        return [n, { p: Number.isFinite(p) ? Number(p.toFixed(2)) : null, run }];
      })),
      source: 'jev',
    };
  } catch (e) {
    store?.log?.({ op: 'jev-error', where: 'review-gates', error: String(e.message).slice(0, 200) });
    return { gates: fall(), source: 'error' };
  }
}
