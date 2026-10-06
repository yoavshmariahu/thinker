# Hosted Jev

Thinker uses this proxy by default; no TypeSafe key or account is required during
onboarding. The CLI enrolls anonymously once per machine, stores a revocable token
with mode 0600, and sends the same batched Jev request through this service. A
personal key, when present, selects direct TypeSafe access. The local cross-encoder
remains installed and takes over on errors, invalid responses, or the client's
1.5-second deadline. Low relevance scores are valid results, not fallback triggers.

## Deployed service

- AWS profile `yoav`, account `442899048927`, region `us-east-1`.
- CloudFormation stack and Lambda: `thinker-jev-proxy`.
- Endpoint: `https://dtsvgyzh00.execute-api.us-east-1.amazonaws.com/v1/systemone`.
- Upstream key: Secrets Manager `thinker/jev/upstream` (JSON `apiKey`).
- `POST /v1/enroll`: returns a 30-day token; only its SHA-256 hash is stored.
- `POST /v1/systemone`: bearer token required; fixed TypeSafe upstream, no redirects.
- `GET /health`: process health, not an upstream availability guarantee.

`template.mjs` defines HTTP API Gateway, a Node 22 ARM Lambda, a DynamoDB table,
scoped IAM permissions and 14-day Lambda logs. No VPC or NAT gateway is needed.
The runtime supplies AWS SDK v3. Upstream connections and the secret (60-second
cache) are reused across warm calls. No provisioned concurrency is purchased;
first requests can be slower. Request metadata is logged, never request/response
bodies, raw IPs or credentials. AWS and TypeSafe still process submitted content;
this is inference traffic, separate from Thinker's telemetry opt-out.

## Limits and access

The initial limits are 30 evaluations per minute and 1,000 per UTC day per token,
10,000 evaluations per UTC day across the service, five registrations per source
IP per UTC day, and 100 registrations per UTC day across the service. Evaluation
attempts reserve quota before contacting Jev, including failed attempts. DynamoDB
transactions check revocation/expiry and all quotas together. Daily and minute
keys encode their window; TTL deletion timing does not affect quota resets.

Inputs are capped at 32 KiB and 32 questions, with a 2.5-second upstream deadline.
Only `jev-1.13.0` is served; `jev-latest` maps to that version. API Gateway throttles
at 10 requests/second with a burst of 20; Lambda concurrency is capped at five.
The gateway throttle is best effort; DynamoDB enforces the evaluation counts.

Anonymous registration is frictionless access, **not unique-user identity**.
Someone can obtain another token (subject to registration caps), and users behind
a shared NAT share the registration limit. The global cap bounds model requests,
not all AWS charges or a token-accurate spending budget. Add account-backed access
before expanding a paid or larger deployment. Revoked clients fall back locally;
the CLI does not automatically re-enroll on 401. Expired tokens renew normally.

## Deploy and operate

```sh
node infra/jev-proxy/deploy.mjs                # generate a reviewable template
node infra/jev-proxy/deploy.mjs --apply --env-file /path/to/private.env
```

The dotenv file may contain `TYPESAFE_API_KEY`, `THINKER_JEV_KEY`, `JEV_API_KEY`,
or the legacy local name `JEVKEY`. Environment variables or `~/.thinker/jev-key`
also work. Values go to Secrets Manager through stdin, never command arguments,
CloudFormation templates, or stdout. Existing secrets are reused; `--rotate-key`
explicitly replaces the upstream key. Generated outputs live in ignored
`.jev-proxy-work/`. The script verifies the account before changing anything.

To revoke a client, SHA-256 hash its token locally and delete DynamoDB item
`token:<hash>` from the table named by the stack's `Table` output. Do not print
or put the raw token in a command line. To stop model traffic, set the Lambda's
reserved concurrency to zero; clients fall back locally. Restore it to five to
resume. The DynamoDB table is retained if the stack is deleted; the independently
managed upstream secret also remains. For code rollback, redeploy this directory
from the previous commit. If recreating the stack changes the API ID, update the
CLI endpoint as part of that rollout.

The CloudWatch alarm observes Lambda execution errors but has no notification
recipient configured. Handled proxy failures are status fields in Lambda logs;
filter `status >= 400`. No per-request database logging is added beyond quotas.

## Verify

```sh
THINKER_TEST=1 THINKER_TELEMETRY=off node --test test/jev-proxy.test.js test/jev.test.js
THINKER_TEST=1 THINKER_TELEMETRY=off node infra/jev-proxy/smoke.mjs /path/to/private.env
```

Unit tests use injected transports. The explicit live probe sends synthetic notes,
uses the exact same model and payload for both arms, alternates their order, and
performs no model retries. It verifies enrollment, missing authentication, real
quota enforcement, CLI credential use and revocation, then deletes its token.
A model mismatch or failed call invalidates the run rather than being omitted.

Measured from the developer machine on 2026-10-06, 20 pairs, `jev-1.13.0`, eight
short synthetic notes per request (no reasoning-effort setting applies):

| Route | Median | p95 |
|---|---:|---:|
| Direct | 114 ms | 200 ms |
| Proxy (us-east-1) | 290 ms | 362 ms |

First proxy evaluation: 600 ms. This is a small latency sample, not a correctness
comparison or production SLO; larger payloads and other locations may differ.
