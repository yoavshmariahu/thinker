# mlflow runs of 2026-10-11: contaminated, diagnosis only

Every session here may have seen the answer key. The oracle installs a task's gold tests with
`git apply --3way`, which stages them, and the reset between sessions was `git checkout -- .`,
which restores the working tree from that index: the next sessions in the worktree found the gold
tests in the test files and in `git diff --cached`. Sessions that named at least two gold tests:

| run | nocache | hook | hook-bm25 | late / full |
|---|---:|---:|---:|---:|
| mlflow-opus-v1 (first set, counterbalanced) | 16/38 | 20/38 | 18/38 | late 16/38 |
| mlflow-astra-v1 (first set, 8 tasks) | 1/8 | 1/8 | 3/8 | full 5/8 |
| mlflow-b2-opus-v1 (harder set, partial) | 4/7 | 4/7 | 3/8 | late 5/8 |
| mlflow-b2-astra-v1 (harder set, partial) | 4/22 | 6/22 | 17/22 | full 18/22 |

The Codex job ran each task's arms in the order nocache, hook, hook-bm25, full on two worktrees,
so the third and fourth sessions of every task ran right after the first two were graded: the
hook-bm25 and full "wins" on the harder set are this leak. No number here is evidence about the
cache. Fixed in `bench/oracle.js:resetWorktree` (hard reset, clean -x, staged check) and recorded
per session as `leak` (`bench/oracle.js:goldTestsSeen`).
