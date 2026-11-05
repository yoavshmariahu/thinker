// A new task protocol, not a continuation carrying either earlier solution.
// The request and reference grader stay frozen; neither reference code nor grader
// feedback is put into the coding prompts.
export const TEST = 'pnpm --filter @posthog/frontend jest --runInBand --testPathPattern=products/workflows/frontend/Broadcasts';
export function stagedTask(original) {
  const start = original.prompt.indexOf('Once a scheduled broadcast');
  const end = original.prompt.indexOf('\n\nRead each', start);
  if (start < 0 || end < 0) throw Error('Original broadcast request boundaries not found');
  const request = original.prompt.slice(start, end);
  return {
    ...original,
    prompt: `This is turn 1 of a seven-turn coding, testing, and review session. Work only from this checkout: no git history, reference patches, remote issue/PR pages, or prior agent traces.\n\n${request}\n\nThe frontend dependencies are installed and the focused Broadcasts tests have passed at this base. You may and must run focused tests. The command is:\n${TEST}\n\nA full backend database/service stack is not provisioned: use meaningful mocked unit tests where possible and explicitly identify anything you cannot execute. Do not call an unrun test a pass. Do not install or change dependency versions.\n\nFirst inspect the relevant code and write a short behavioral acceptance checklist from the request and existing code. Include state transitions, who may stop/edit, immediate versus scheduled sending, relaunch behavior, failure recovery, and preserving existing configuration. Map each item to a test or another concrete verification. Read only what you need; no mandatory full-file rereads. Do not implement yet.`,
    turns: [
      `Turn 2 of 7: Write focused regression tests before production changes. Exercise the requested stop/edit and relaunch behavior through real exported logic with mocked external APIs. Run ${TEST}. Confirm the new tests fail for the missing behavior, not missing dependencies or broken test setup. Repair test setup if needed, but do not weaken an assertion to make the current bug pass. Report the failing assertions and how they map to the acceptance checklist.`,
      `Turn 3 of 7: Implement the smallest coherent change that addresses the request and your regression tests. Keep existing behavior outside the request. Run ${TEST}; diagnose and fix failures. Report the observed command result and any remaining failing acceptance items.`,
      `Turn 4 of 7: Review as an adversarial maintainer. Trace the frontend and backend behavior together, including stale state, asynchronous failures, concurrent actions, pending versus already-started work, and safety of retrying a launch. Add or improve focused regression tests for problems you find, fix them, and rerun ${TEST}. Do not assume passing frontend tests proves unexecuted backend integration behavior.`,
      `Turn 5 of 7: Revisit every acceptance item against the current patch and actual test evidence. Review compatibility with existing schedule data, permissions, read-only/editable state, and user-visible confirmation/error handling. Correct uncovered behavior rather than polishing prose. Run ${TEST} after changes. List unmet or unverified items honestly.`,
      `Turn 6 of 7: Bounded repair round. You may perform at most three edit-and-test cycles to resolve remaining failures or uncovered acceptance items. Use actual failed assertions and concrete code review findings. Never delete or relax a regression assertion merely to get green tests. Stop when all executable checks pass or the three-cycle budget is used. Run ${TEST} and report which acceptance items are still unverified.`,
      `Turn 7 of 7: Final verification. Review the full diff for accidental behavior changes and test weakening; run ${TEST} once more. Summarize the implemented behavior, exact test command and result, remaining limitations, and whether each acceptance item is met. Claim completion only for behavior supported by evidence. Do not make unrelated edits.`,
    ],
  };
}
