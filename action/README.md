# thinker GitHub Actions

Two composite actions, both talking to the team's thinker server: `action/review`
has the server check every pull request against the repository's desired
behaviors and post the result as a review; the action at `action/` sends a
merged pull request to the server to be distilled into notes.

## Pull request review (`action/review`)

On `pull_request`, asks the team's thinker server to review the pull request
and waits for the result. The server fetches the pull request's head into its
clone, reviews the change since the merge base against the repository's
desired behaviors (`thinker review --kinds behavior`), and posts one pull
request review with its own GitHub token: findings on changed lines as inline
comments, the rest and a table of the behaviors in play (upheld, violated,
revised, unrelated) in the body. A violated fixed behavior requests changes and
fails the check; a push that fixes it dismisses that request. Nothing is posted
when there is nothing to report. The workflow needs only the server's url and a
token with write scope; no model key and no write permission on the workflow's
`GITHUB_TOKEN`. The server reviews with whatever model it has: `ANTHROPIC_API_KEY`,
or an installed agent CLI with its login (a local server on a laptop uses
`claude -p`).

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
    steps:
      - uses: yoavshmariahu/thinker/action/review@main
        with:
          url: https://sync.zerotime.dev
          token: ${{ secrets.THINKER_SYNC_TOKEN }}
          # kinds: behavior      # '' consults every note, not only the behaviors
          # fail-on: error       # warning | none
          # quiet: 'true'        # 'false' posts the behaviors table even when all is upheld
          # wait: '600'          # seconds to wait for the result; '0' sends and leaves
```

Server side: the repository is registered with a clone the server can fetch
(`thinker-server repo add github.com/<owner>/<repo>`), `THINKER_SERVER_GITHUB_TOKEN`
holds a token with pull requests: write on it (the git token when unset), and the
CI token is minted with `thinker-server token create ci-<repo> --repos
github.com/<owner>/<repo> --scopes write`. The API is `POST /v1/repos/:repo/reviews`
(`{number, headSha, headRef, baseRef, baseSha, apiUrl?, kinds?, failOn?, quiet?}`) and
`GET /v1/repos/:repo/reviews/:number` for the state and result, which the action polls.
A head the server already reviewed is not reviewed again; a new push is.

Without a server, `anthropic-api-key` runs the review on the runner instead
(`actions/checkout` with `fetch-depth: 0`, `permissions: pull-requests: write`,
`post.mjs` posts); the inputs `kinds`, `model`, `fail-on`, `quiet` apply to both.

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
