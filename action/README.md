# thinker GitHub Action

One composite action, `action/review`: it has the team's thinker server check
every pull request against the repository's desired behaviors and post the
result as a review, or runs the review on the runner when there is no server.
Until 2026-10-04 a second action at `action/` sent merged pull requests to the
server to be distilled into notes; learning now happens on each checkout
(maintenance mines merged pull requests there), so the server has no intake for
them and that action is gone.

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
