# This repository uses pull requests

We use PRs here to test Thinker’s CI hooks, especially review against the system’s
desired behaviors. Teams using Thinker choose their own Git workflow: landing
direct commits is supported and does not require adopting our contributor policy.
The guard below is a manually installed safeguard for this repository only;
Thinker setup and installation do not install it in user repositories.

1. Work on an isolated task branch/worktree.
2. Run `THINKER_TELEMETRY=off npm test`.
3. Push the task branch and open a pull request to `main`.
4. Wait for tests and inspect the Thinker review, then merge through GitHub.
5. Update local `main` from remote and remove the task worktree.

Do not push `main` directly or bypass the local guard. Install the guard once:

```sh
node scripts/install-pr-guard.mjs
```

It preserves any existing pre-push hook and blocks direct main updates/deletion.
It is a local workflow guard, not a security boundary: other clones, APIs and
`--no-verify` can bypass local hooks. Those bypasses are prohibited by repo policy.

GitHub returned HTTP 403 for private-repository rulesets and branch protection on
2026-10-04: the owning account must upgrade to GitHub Pro for remote enforcement.
After upgrading, an administrator can apply the prepared policy:

```sh
gh api --method PUT repos/yoavshmariahu/thinker/branches/main/protection \
  --input .github/main-protection.json
```

The policy requires a PR and the `test` check, applies to administrators, and blocks
force pushes and deletion. It deliberately requires zero separate approvals so a
solo maintainer can merge their own PR after CI passes. The Thinker review workflow runs on non-draft PRs but requires
`THINKER_SYNC_TOKEN` and server-side review credentials before it performs a review;
a successful job without those credentials is not evidence that behaviors were checked.
When configured, its report is retained as a CI artifact for 30 days.
It is not a required status check until server credentials/availability are verified.
