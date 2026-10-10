# PostgreSQL telemetry

Deployment verified on 2026-09-30 UTC: the existing `/metrics` endpoint targets
`thinker-metrics-postgres-ingest`, writing to `thinker_metrics.public.reports`
on `codervibes`. All 399 historical S3 reports (158 installation IDs) were
imported and compared against their source payloads and typed columns. The final
repeat import inserted zero rows and verified all 399 again. Direct Lambda and
HTTP integration checks passed, and their synthetic reports were removed.
The original S3 objects and original Lambda are retained for rollback.

The optional device-ID column and ingestion update were deployed on 2026-09-30
UTC. Live checks verified that two installation IDs group into one device and
that legacy clients remain accepted. The new client code must be distributed
before ordinary reports begin carrying device IDs; no historical IDs were inferred.

The PostgreSQL writer accepts the existing telemetry JSON over the existing HTTP
API. It acknowledges a report only after PostgreSQL commits it. `reports` has
typed columns for metrics and the entire payload in `raw_json` (`jsonb`).
`file_key` is unique: historical reports retain their complete S3 object key;
new reports use the API Gateway request ID. Repeated imports and repeated Lambda
invocations for the same API request cannot duplicate a report. Separate client
requests are separate snapshots, even if their contents happen to match.

Updated clients send `deviceId`, stored in the nullable `reports.device_id`
column. It is `v1:` followed by a Thinker-specific HMAC-SHA256 hash of the OS
machine identifier (macOS IOPlatformUUID, Linux machine-id, Windows MachineGuid).
The raw identifier never leaves the device. It is independent of installation
directories, but is an OS identity, not a guaranteed unique physical machine or
person: reinstallation can change it and cloned systems may share it.
Unavailable IDs and historical reports remain NULL; they cannot be backfilled
from installation IDs alone. Device counts cover only clients that have updated.

```sql
SELECT count(DISTINCT device_id) AS known_devices,
       count(DISTINCT install_id) FILTER (WHERE device_id IS NULL) AS installations_without_device_id
FROM v_latest_installs;

SELECT device_id, count(DISTINCT install_id) AS installations
FROM reports WHERE device_id IS NOT NULL GROUP BY device_id;

SELECT platform, count(*) AS devices FROM v_latest_devices GROUP BY platform;
```

`v_latest_devices` provides one latest snapshot per known device; it excludes
unknown devices. Reports are rolling snapshots, so adding every installation's
values on a shared device can still double-count usage. `npm test` sets
`THINKER_TEST=1`; this and Node's inherited `NODE_TEST_CONTEXT` block network
telemetry except to loopback test servers. Background jobs obey the same guard.

Install the operator/Lambda dependencies separately from the Thinker CLI:

```sh
npm ci --prefix infra/metrics
```

`scripts/metrics-db.js` is the older, offline SQLite dashboard. It reads S3 and
does not show reports received after switching the API to PostgreSQL. Use the
PostgreSQL query tool below for current data.

## Accessing private RDS

### Local SQL dashboard (Metabase)

Requires Docker (OrbStack or Docker Desktop), Node 20+, AWS CLI with the `yoav`
profile logged in, and the Session Manager plugin. From the checkout root:

```sh
node scripts/metrics-dashboard.mjs start
node scripts/metrics-dashboard.mjs login
```

Open **http://localhost:3030** and use the printed login. The **Thinker metrics**
collection contains **Cache & distillation performance**, **Telemetry diagnostics**,
**PR delivery & review**, **Holdout: what the notes save**, and **Waitlist** dashboards with saved SQL queries. Choose
**New → SQL query → Thinker telemetry (read-only)** to write your own SQL, save
results, chart them, or export CSV. `start` prints the direct dashboard URLs.
All dashboards have platform, version, device ID, and report-type filters.
`start` refreshes dropdown choices as new devices and versions appear; existing
chart layouts are preserved. Performance filters apply to each installation's
latest snapshot, while diagnostics and waitlist queries can examine all uploads.
Use **Unknown** for a missing device ID or untyped historical upload.

Metabase Open Source v0.63.18 runs locally, bound only to `127.0.0.1:3030`.
It uses the existing `thinker/metrics/reader` account through the private SSM
tunnel on port 15432, with TLS and full RDS certificate/hostname verification.
The production database receives no schema changes. Saved questions, dashboards,
and accounts live in a separate local Postgres 17 Docker volume. Database
credentials are encrypted by Metabase. Anonymous Metabase tracking is disabled.
There is no additional hosted server or Metabase subscription.

```sh
node scripts/metrics-dashboard.mjs tunnel  # opens/verifies private RDS SSM tunnel only
node scripts/metrics-dashboard.mjs status
node scripts/metrics-dashboard.mjs verify  # runs every saved query and checks read-only access/TLS
node scripts/metrics-dashboard.mjs stop
```

Run `start` again after restarting your Mac or an expired AWS session. It reuses
the dashboard and saved queries and opens a new tunnel when needed. `stop` stops
both Docker containers without deleting data; it leaves the shared database
tunnel available for other query tools. A newly opened tunnel logs to
`.metrics-work/dashboard/tunnel.log`. If AWS login expired, run
`aws login --profile yoav` and retry.

Keep `.metrics-work/dashboard/state.json` private and backed up: it contains the
local login, application database password, and encryption key. Back up the
`thinker-dashboard_dashboard-data` Docker volume too. Do not delete that volume
or lose the encryption key; recreating containers alone preserves your dashboard.
If you change the local admin password in Metabase, update `password` in the
private state file so the launcher can continue configuring the connection.

The starter dashboard distinguishes installation IDs from devices/people and
labels report arrivals separately from usage. Historical reports may include
test telemetry; the snapshot-pattern query helps inspect it. Device coverage is
partial, and usage fields are rolling snapshots, so raw report sums are not
reliable totals of real users or cumulative savings.

### Distillation performance (client 0.1.2+)

The optional `raw_json.distillation` block (`schemaVersion: 1`) carries whole-run
attempts, successes, failures, summed duration in milliseconds, timing sample
count, legacy completions without outcome instrumentation, and provider-reported
model costs/tokens with known/unknown coverage counts. It also carries model
attempt failures and counts of completed runs without new notes or merges.
The existing JSONB ingestion path preserves this block without a schema migration.
Old uploads remain missing these measurements; they are never backfilled as zero.

`distill-run` log records time the model invocation, retries/fallbacks, note
persistence and assessments. Skipped sessions and dry runs do not enter the
performance counters. A handled error is a failed whole run; provider retries
that eventually succeed only increase failed model attempts. Abrupt process kills
cannot emit an outcome. Mean duration is summed duration / measured run count;
failure rate is failed / instrumented attempts, excluding uninstrumented history.
Cost includes provider-reported spending on distillation attempts, including
failed ones. Providers that do not report prices stay unknown. Partial known cost
is shown with missing-cost counts, rather than claimed as a complete bill.

The **Waitlist** dashboard lists submitted email addresses and first/latest signup
times, deduplicated by the stored email string. Its table can be exported as CSV.
The `event` field distinguishes `install`, `daily`, `waitlist`, and missing types
(displayed as **Unknown**). An upload is a snapshot, not a distinct user or action.

### Command-line access

The `thinker_metrics` database runs on the private `codervibes` RDS instance.
Start a tunnel with the AWS CLI and Session Manager plugin:

```sh
aws --profile yoav --region us-east-1 ssm start-session \
  --target i-078f0fd7bd61f4b65 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["codervibes.cc9u406wsj02.us-east-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'
```

Keep the tunnel running. In another terminal:

```sh
mkdir -p .metrics-work
curl --fail --silent --show-error \
  https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem \
  -o .metrics-work/rds.pem

node scripts/metrics-postgres.js query \
  'SELECT event, count(*) AS reports, count(DISTINCT install_id) AS installs FROM reports GROUP BY event' \
  --secret thinker/metrics/reader --tunnel-port 15432 --ca .metrics-work/rds.pem
```

The query command uses a read-only transaction, defaults to AWS profile `yoav`
and region `us-east-1`, and reads credentials from Secrets Manager in memory.
It also accepts `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and
`PGSSLROOTCERT` for other PostgreSQL destinations. TLS certificate and hostname
verification remain enabled through the tunnel.

Useful queries:

```sql
SELECT install_id, platform, cache_total_notes, requests_total, hit_rate,
       timestamp FROM v_active_installs ORDER BY timestamp DESC;

SELECT * FROM v_kind_distribution ORDER BY total_notes DESC;

SELECT timestamp, raw_json #> '{effectiveness,estimatedSavings}' AS savings
FROM reports ORDER BY timestamp DESC LIMIT 20;
```

Reports contain rolling usage snapshots. Summing every report can double-count
overlapping periods, especially installation and daily reports. Use
`v_latest_installs` for one deterministic latest snapshot per installation.
`v_hourly_volume` summarizes submitted reports; it is not a deduplicated event log.

## Provisioning and deployment

1. The bootstrap creates the dedicated `thinker_metrics` database, restricted
   `thinker_metrics_writer` and `thinker_metrics_reader` logins, and the
   `thinker/metrics/writer` and `thinker/metrics/reader` secrets. It preserves
   existing role passwords on rerun. The RDS admin secret contains only its
   username/password, so supply the hostname explicitly:

   ```sh
   node infra/metrics/bootstrap.mjs \
     --secret 'rds!db-f6966b5f-f65e-420d-8d56-ede2230405f8' \
     --host codervibes.cc9u406wsj02.us-east-1.rds.amazonaws.com \
     --tunnel-port 15432 --ca .metrics-work/rds.pem
   ```

2. Import and verify S3. The writer role has `INSERT` and `SELECT`, which are
   sufficient for the import. The importer lists S3, syncs the objects, validates
   single-part S3 ETags and payloads before writing, then inserts and verifies
   every column and JSON payload within a transaction. Errors fail the command;
   no reports are silently skipped. Existing keys with different contents fail.
   These telemetry objects are small JSON uploads encrypted with SSE-S3, for
   which the ETag is the content MD5. Other ETag formats are rejected.

   ```sh
   node scripts/metrics-postgres.js migrate --secret thinker/metrics/writer \
     --tunnel-port 15432 --ca .metrics-work/rds.pem
   ```

3. The production configuration is checked in as `infra/metrics/production.json`:

   ```json
   {
     "profile": "yoav",
     "region": "us-east-1",
     "host": "codervibes.cc9u406wsj02.us-east-1.rds.amazonaws.com",
     "vpc": "vpc-065641281fc27f26f",
     "subnets": ["subnet-04750b7f5da2effdb", "subnet-00a581cf00582cd60"],
     "databaseSecurityGroup": "sg-0646b6f9fa534f985",
     "artifactBucket": "thinker-metrics-442899048927",
     "apiId": "khsky10r4l"
   }
   ```

   ```sh
   node infra/metrics/deploy.mjs infra/metrics/production.json
   ```

   CloudFormation deploys `thinker-metrics-postgres-ingest` without changing the
   API target. It creates a dedicated security group permitted to reach RDS on
   port 5432, a Lambda execution role, and API invocation permission. The Lambda
   has one pooled connection per execution environment and reserved concurrency
   of five. Credentials are passed as a `NoEcho` stack parameter and
   stored in Lambda's encrypted environment. AWS CLI input uses a temporary file
   with mode `0600` in a private directory and deletes it after the command.
   The writer needs no S3 permissions
   or internet access. Code artifacts are stored under `deployments/` in S3.
   To rotate its password, update the database login and writer secret, then
   rerun deployment. The function does not fetch secrets at runtime.

4. Run the live integration check. It verifies persistence, duplicate invocation,
   malformed input, views, and reader/writer permissions. It removes its own
   synthetic reports using the administrative login, including on failure.

   ```sh
   node infra/metrics/smoke.mjs \
     --admin-secret 'rds!db-f6966b5f-f65e-420d-8d56-ede2230405f8' \
     --host codervibes.cc9u406wsj02.us-east-1.rds.amazonaws.com
   ```

5. Change the API's target to the candidate after validation. The current API
   was created using API Gateway quick create, so use its `Target` setting:

   ```sh
   aws --profile yoav --region us-east-1 apigatewayv2 update-api \
     --api-id khsky10r4l \
     --target arn:aws:lambda:us-east-1:442899048927:function:thinker-metrics-postgres-ingest
   ```

   Repeat the smoke check with
   `--endpoint https://khsky10r4l.execute-api.us-east-1.amazonaws.com/metrics`.
   If it fails, restore the old target immediately. Confirm genuine reports
   arrive in PostgreSQL.

6. Allow old in-flight Lambda invocations to finish (the old timeout is 15
   seconds), rerun `migrate`, and run `verify` against a fresh S3 manifest. Every
   S3 key and payload must match PostgreSQL. Rerunning migration must insert zero
   rows once S3 is stable. Retain the original objects and old Lambda for rollback.

   ```sh
   node scripts/metrics-postgres.js verify --secret thinker/metrics/reader \
     --tunnel-port 15432 --ca .metrics-work/rds.pem
   ```

## Rollback

Restore the original API target:

```sh
aws --profile yoav --region us-east-1 apigatewayv2 update-api \
  --api-id khsky10r4l \
  --target arn:aws:lambda:us-east-1:442899048927:function:thinker-metrics-ingest
```

Reports already accepted by PostgreSQL remain there. Once the PostgreSQL writer
is repaired, rerun the S3 import to capture reports received during rollback.
The rollback does not copy PostgreSQL reports back to S3.

## Validation

`npm test` includes HTTP behavior, metric mapping, parameterized insertion,
duplicate protection, S3 checksums and migration rollback tests. Validate the
deployment template with `aws cloudformation validate-template`. Deployment
still requires a real PostgreSQL round trip and a live endpoint check.

AWS references: [private database tunnels](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html),
[Lambda RDS TLS certificates](https://docs.aws.amazon.com/lambda/latest/dg/services-rds.html).

## PR delivery and review (delivery schema 1)

Updated clients include `raw_json.delivery`, a numeric 30-day snapshot independent
of the outer daily usage `periodHours`. The existing JSONB ingestion preserves it;
no Lambda or PostgreSQL schema migration is needed. Existing clients without the
block remain unknown, not zero. `thinker impact sync` refreshes GitHub PR lifecycle
metadata locally before reporting. Telemetry neither fetches GitHub nor uploads
PR identities, source excerpts, titles, session IDs or confirmation text.

**PR delivery & review** includes merged PR observations, weighted mean tokens per
complete-counter PR, human-confirmed fixes before merge, token coverage and token
histograms, review decision counts, observed merge duration, cache participation,
and missing/unassigned evidence. All-time underlying work for merges in the last
30 days is included; repository overhead covers that same 30-day period.

Queries choose the latest installation snapshot per known device, falling back to
installation identity. They do not add hourly overlapping uploads. Daily trend
points likewise select one snapshot per source per day and represent overlapping
30-day windows, not daily event totals. Two contributors can report the same PR,
so counts are labeled observations rather than unique global PRs. Separate local
journals for several worktrees of one repository use the checkout with most linked
evidence; consolidating exports gives more complete measurements.

Token averages use sum of complete PR tokens / complete PR observations, never an
average of medians. Coverage means complete counters for the recorded linked work,
not certainty every contributor/subagent was recorded. Fixed bugs require a local
human decision and a fixing commit within the PR and timing window. Cache support
is provenance, not a claim that a review without cache would miss the issue.

Refresh existing dashboards without restarting Docker:

```sh
node scripts/metrics-dashboard.mjs refresh
node scripts/metrics-dashboard.mjs verify
```

`THINKER_DASHBOARD_WORK` can select the existing private dashboard state directory
when operating from an isolated worktree. Refresh adds the delivery dashboard and
preserves the existing performance/diagnostics/waitlist layouts. Verification
executes every saved query, validates filter mappings and checks read-only TLS.
No test or demo payload is sent to production to populate the charts.

## Holdout: what the notes save (holdout schema 1)

Every client withholds notes from a share of sessions (15% by default) and records
what each session cost from its own transcript. Updated clients include
`raw_json.holdout`, a 30-day snapshot of that comparison independent of the outer
`periodHours`: for sessions served notes and sessions held out, the session count,
the sums of tool calls, model turns, input and output tokens, and how many sessions
measured each; the same per model name; and the sessions on neither side (nothing to
serve, or no transcript). No session, repository or prompt identity is uploaded, and
a repository that opted out of telemetry is left out. The existing JSONB ingestion
preserves the block; no Lambda or schema migration is needed. Clients without it
remain unknown, not zero.

The dashboard pools the latest snapshot per known device (installation fallback).
Every average is the pooled sum / the pooled count of sessions that measured it,
never an average of per-source averages. "Input tokens saved" is (average held-out −
average served) × served sessions, and does not subtract the tokens spent building
and maintaining the cache. Averages move with a few very long sessions, so read them
beside the session counts; the per-source table shows where the sessions come from.
The trend chart takes one snapshot per source per day, each covering the 30 days
before it. Run `refresh` to add the dashboard to an existing setup, then `verify`.

## Website messages

The bottom-right **Send us a message** button on the homepage and docs opens a
modal with a required message (up to 5,000 characters) and optional reply email.
`POST /messages` on the existing API writes to `website_messages`, separately
from telemetry `reports`. It records a server timestamp and page path, never
query strings. The writer has INSERT/SELECT and the reader has SELECT only.
A client-generated UUID makes unchanged retries idempotent. Invalid input is
rejected; a failed database write never reports success. The form retains text
on errors and timeouts. Message contents and email addresses are not logged.

Run the existing bootstrap once to create the table and grant its permissions,
then deploy the metrics Lambda before publishing the site. Run dashboard
`refresh` with the existing `THINKER_DASHBOARD_WORK` directory to add the
**Messages** dashboard; existing layouts are preserved. The full-width table
shows every message newest first, with optional email, page and receipt time.
Dashboard `verify` executes its query along with existing queries.
