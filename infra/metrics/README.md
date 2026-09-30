# PostgreSQL telemetry

Deployment verified on 2026-09-30 UTC: the existing `/metrics` endpoint targets
`thinker-metrics-postgres-ingest`, writing to `thinker_metrics.public.reports`
on `codervibes`. All 399 historical S3 reports (158 installation IDs) were
imported and compared against their source payloads and typed columns. The final
repeat import inserted zero rows and verified all 399 again. Direct Lambda and
HTTP integration checks passed, and their synthetic reports were removed.
The original S3 objects and original Lambda are retained for rollback.

The PostgreSQL writer accepts the existing telemetry JSON over the existing HTTP
API. It acknowledges a report only after PostgreSQL commits it. `reports` has
typed columns for metrics and the entire payload in `raw_json` (`jsonb`).
`file_key` is unique: historical reports retain their complete S3 object key;
new reports use the API Gateway request ID. Repeated imports and repeated Lambda
invocations for the same API request cannot duplicate a report. Separate client
requests are separate snapshots, even if their contents happen to match.

Install the operator/Lambda dependencies separately from the Thinker CLI:

```sh
npm ci --prefix infra/metrics
```

`scripts/metrics-db.js` is the older, offline SQLite dashboard. It reads S3 and
does not show reports received after switching the API to PostgreSQL. Use the
PostgreSQL query tool below for current data.

## Accessing private RDS

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
