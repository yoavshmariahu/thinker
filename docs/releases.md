# Cutting a release

From a checkout containing the release runner, choose the next stable version:

```bash
bash scripts/release.sh 0.1.44
```

You need Node 20+, npm, Git, GitHub CLI (`gh`), Bash, tar and curl. Log in to
GitHub with `gh auth login`; your account needs permission to push branches and
tags and create releases. Your npm account needs publishing access to
`@zerotimedev/thinker`. The runner checks npm login before publishing; in a
terminal it starts `npm login --auth-type=web` if necessary. Complete any browser
login or 2FA prompts from npm.

The command:

1. Fetches `origin/main` and creates a temporary, isolated checkout. It leaves
   your current branch and uncommitted work alone.
2. Bumps `package.json` and `package-lock.json`, installs dependencies, runs the
   full tests with `THINKER_TEST=1`, and opens `release/vX.Y.Z` as a PR to `main`.
3. Prints the PR URL and waits. **Review and merge the PR yourself**, then press
   Enter. The runner never merges a PR or pushes to `main`.
4. Tests the merged commit, builds and checks the archive, creates and pushes
   `vX.Y.Z`, uploads the three assets to a draft GitHub release, then publishes it
   with generated release notes.
5. Verifies the published assets and public latest-release manifest, packs the
   npm installer from that same commit, publishes it and verifies its version
   in the registry.

To open the PR and exit instead of waiting:

```bash
bash scripts/release.sh 0.1.44 --no-wait
# Review and merge in GitHub, then:
bash scripts/release.sh 0.1.44
```

An open PR also causes the runner to exit when there is no interactive terminal.
Exit code 2 means it is waiting for review; 1 means an error; 0 means completion.

## Retrying or finishing an existing release

Rerun the **same version** after an interruption or error:

```bash
bash scripts/release.sh 0.1.44
```

The runner reuses its branch and PR, pins an existing tag's commit even if main
has advanced, repairs interrupted draft uploads, and skips an npm version that
is already published. Public GitHub assets are verified, never overwritten.
Resuming an older release preserves a newer release's `latest` designation on
GitHub and npm. Authentication and network failures stop the command with a
resume instruction; a missing npm login is not reported as a successful release.

With no version, `bash scripts/release.sh` uses the version at freshly fetched
`origin/main`. This also finishes releases whose version PR was created by hand.
Use an explicit version when resuming after main has advanced. Versions must be
stable `X.Y.Z` values (`vX.Y.Z` also works); aliases such as `patch`, commit refs,
and prereleases are not accepted.

For an intentional GitHub-only release, set `THINKER_NPM_PUBLISH=0`. Rerun without
that setting to finish npm publishing. Do not run `npm publish` at the repository
root: the public npm package is the small installer generated under `dist/npm`,
not the root development package. The runner builds and publishes that package
from the release commit automatically.
