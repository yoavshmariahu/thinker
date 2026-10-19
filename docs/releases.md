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

## Holding a release

To cut a version without anyone updating to it yet:

```bash
bash scripts/release.sh 0.1.44 --hold
```

It runs the same steps (PR, tests, tag, assets, verification), with three differences:
the GitHub release is a pre-release and is not marked latest, the runner checks
the release's own download URL instead of the latest one, and npm gets the version
under the `next` tag, not `latest`. Everything that follows latest stays where it is:
`thinker update`, the daily background update, the installer's default and
`npx @zerotimedev/thinker`.

To install a held release by name:

```bash
thinker update v0.1.44                  # an installed thinker
bash install.sh --ref v0.1.44           # a fresh install
npx @zerotimedev/thinker@next           # through npm
```

`thinker update v0.1.44` pins that machine to the tag: its background updates check
that tag only, so it does not move to a later release by itself. `thinker update
latest` puts it back on the normal track.

To release a held version to everyone:

```bash
bash scripts/release.sh 0.1.44 --promote
```

This clears the pre-release flag and marks the release latest on GitHub, waits for
the public latest manifest to point at it, and moves npm's `latest` tag to it
(`npm dist-tag add`). Nothing is rebuilt or republished. It refuses a version that is
not fully published yet (finish it with `--hold`) and a version older than the
current latest. Rerunning it is safe.

A held release resumed without `--hold` stays held: the runner reads the
pre-release flag back from GitHub, and only `--promote` makes it latest. A later
version released normally becomes latest as usual, whether or not the held one was
promoted.

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
and prerelease versions (`0.1.44-beta`) are not accepted; use `--hold` instead.

For an intentional GitHub-only release, set `THINKER_NPM_PUBLISH=0`. Rerun without
that setting to finish npm publishing. Do not run `npm publish` at the repository
root: the public npm package is the small installer generated under `dist/npm`,
not the root development package. The runner builds and publishes that package
from the release commit automatically.
