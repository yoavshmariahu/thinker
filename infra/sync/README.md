# thinker-server on EC2

The team's central cache (`src/server/`) runs on one Amazon Linux 2023 instance,
`t4g.small`, behind Caddy, which obtains and renews the TLS certificate for
`sync.zerotime.dev` (Let's Encrypt). Data is on the instance's encrypted volume
under `/var/lib/thinker-sync`: one directory per repository with its clone, notes,
change journal, streamed sessions and queued pull requests, plus `tokens.json`.
No SSH: the instance is reached through Systems Manager Session Manager.

```sh
node infra/sync/deploy.mjs infra/sync/production.json
```

The first run creates the secret `thinker/sync/server` (a generated admin token,
`ANTHROPIC_API_KEY` from the environment if set, an optional git token for private
repositories), uploads the release and `bootstrap.sh` to
`s3://thinker-metrics-442899048927/deployments/sync/`, and creates the
CloudFormation stack `thinker-sync`: security group (443 and 80 from anywhere),
instance role (Session Manager, read of the release prefix and the secret),
Elastic IP, instance, Route 53 record. User data runs `bootstrap.sh`, which installs
Node 22, git and Caddy, unpacks the release under `/opt/thinker-sync/releases/`,
writes `/etc/thinker-sync/env` from the secret, and starts the `thinker-sync` and
`caddy` systemd units. Later runs upload a new release and run the same script on
the instance through `ssm send-command`; the stack is not touched. The script ends
with `GET https://sync.zerotime.dev/health`.

- `--secret-only --set-api-key` writes `ANTHROPIC_API_KEY` from the environment into
  the secret; `--set-git-token` does the same for `THINKER_SERVER_GIT_TOKEN` (a
  fine-grained GitHub token with read access to the repositories' contents, so the
  server can clone private ones), and `--set-github-token` for
  `THINKER_SERVER_GITHUB_TOKEN` (a token with pull requests: write on the
  repositories, so the server can post the reviews that `action/review` asks
  for; the git token is used when it is unset). Rerun without flags afterwards so
  the instance picks the secret up (bootstrap rewrites the env file and restarts
  the service).
- Without a model key the server stores notes and sessions but distills nothing;
  checkouts then keep distilling locally (`sync status` says which). Without a clone
  it stores what clients push but cannot anchor new notes, so sessions wait.

## Running it locally in a container

`infra/sync/Dockerfile` builds the same server (Node 22 on Alpine, git for the
clones). Data lives in the `/data` volume. From the repository root:

```sh
docker build -f infra/sync/Dockerfile -t thinker-sync-server .
docker run -d --name thinker-sync-server -p 127.0.0.1:8787:8787 -v thinker-sync-data:/data \
  -e THINKER_SERVER_ADMIN_TOKEN=tk_... -e ANTHROPIC_API_KEY=sk-ant-... thinker-sync-server
curl -s http://127.0.0.1:8787/health
```

Then register a repository and mint a token through the API with the admin
token, or with the server's CLI inside the container
(`docker exec thinker-sync-server node src/server/cli.js repo add github.com/owner/repo`,
`... token create team`), and in a checkout: `thinker sync login http://127.0.0.1:8787 --token <t>`.
A repository the container cannot reach over the network can be mounted and
registered with a `file://` clone url. For an end-to-end run without a model key,
`-e THINKER_LLM_CMD='node /srv/mock-llm.mjs' -v $PWD/test/fixtures/mock-llm.mjs:/srv/mock-llm.mjs:ro`
answers every model call with fixed notes.

## Operating

```sh
# the admin token
aws --profile yoav --region us-east-1 secretsmanager get-secret-value --secret-id thinker/sync/server --query SecretString --output text

# a shell on the instance
aws --profile yoav --region us-east-1 ssm start-session --target <InstanceId from the stack outputs>
sudo journalctl -u thinker-sync -f
sudo -u thinker THINKER_SERVER_DATA=/var/lib/thinker-sync node /opt/thinker-sync/current/src/server/cli.js repo list
```

Registering a repository and minting tokens go through the API with the admin
token (`PUT /v1/repos/<id>`, `POST /v1/tokens`; see `src/server/index.js`), or on
the instance with `thinker-server repo add` and `thinker-server token create`.
Clients: `thinker sync login https://sync.zerotime.dev --token <t>` in a checkout.
CI: `action/README.md`.

Spending: the server's model calls are logged per repository
(`checkout/.thinker/log.jsonl`); the worker stops for the day at
`THINKER_SERVER_DAILY_CAP` dollars (default 5; `dailyCap` in the secret overrides).

## Teardown

```sh
aws --profile yoav --region us-east-1 cloudformation delete-stack --stack-name thinker-sync
```

The volume goes with the instance. Export what matters first
(`thinker export` in a synced checkout holds the notes; the sessions live only on
the server). The secret and the S3 releases are left in place.
