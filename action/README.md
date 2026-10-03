# thinker pull request ingest (GitHub Action)

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
