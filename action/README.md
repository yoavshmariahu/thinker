# thinker GitHub Actions

Two composite actions: `action/review` checks every pull request against the
repository's desired behaviors and posts the result as a review; the action at
`action/` sends a merged pull request to the team's thinker server to be
distilled into notes.

## Pull request review (`action/review`)

On `pull_request`, runs `thinker review --kinds behavior --base origin/<base>`
on the checkout and posts one pull request review: findings on changed lines
as inline comments, the rest and a table of the desired behaviors in play
(upheld, violated, revised, unrelated) in the body. A violated fixed behavior
requests changes and fails the check; a push that fixes it dismisses that
request. Nothing is posted when there is nothing to report. The cache is the
committed `.thinker/` of the repository (`thinker system add`, `thinker share`),
so no server is involved; the model key is a repository secret.

```yaml
# .github/workflows/thinker-review.yml
name: thinker review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # the merge base with the base branch must resolve
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: yoavshmariahu/thinker/action/review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # kinds: behavior      # '' consults every note, not only the behaviors
          # model: sonnet
          # fail-on: error       # warning | none
          # quiet: 'true'        # 'false' posts the behaviors table even when all is upheld
```

Pull requests from forks get a read-only `GITHUB_TOKEN`: the review is then in
the job log and the step summary only. Without the key the step says that
nothing was reviewed and passes. Measured on this repository: about $0.05 per
behavior in play, under a minute.

## Pull request ingest (`action`)

When a pull request is merged, this action sends it (title, description, files,
diff, review comments) to the team's thinker server, which distills it into fix
records, invariants and conventions and serves them to every checkout that syncs.
The model key stays on the server; the workflow needs only the server's url and a
token with write scope for the repository.

```yaml
# .github/workflows/thinker.yml
name: thinker
on:
  pull_request:
    types: [closed]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to send again
        required: true
jobs:
  ingest:
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: yoavshmariahu/thinker/action@main
        with:
          url: https://sync.zerotime.dev
          token: ${{ secrets.THINKER_SYNC_TOKEN }}
          pr: ${{ inputs.pr }}
```

Mint the token on the server (`thinker-server token create ci-<repo> --repos
github.com/<owner>/<repo> --scopes write`, or `POST /v1/tokens` with the admin
token) and store it as the repository secret `THINKER_SYNC_TOKEN`. The repository
must be registered on the server (`thinker-server repo add github.com/<owner>/<repo>`),
with a clone the server can read, so notes are anchored to real files.

The thinker repository is private: for `uses:` to work from another repository,
allow it under Settings → Actions → General → Access ("Accessible from repositories
owned by the user"), or copy `ingest.mjs` into the workflow's repository and run
`node ingest.mjs` with the same environment variables. The script has no
dependencies beyond Node 20.

A pull request the server has already distilled is not distilled again
(`.thinker/prs.json` in the server's checkout records it), so re-running is safe.
