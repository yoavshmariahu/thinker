# Public website

The site, docs and current installer/downloads are public. `production.json` sets
`publicSite: true`; `deploy.mjs` uses `public-deploy.mjs` and `public-gateway.js`.
The homepage and docs include a GitHub link and the shared message widget.
Old signed distribution URLs still resolve, so existing clients keep updating.
The S3 origin stays private and the existing CloudFront/WAF configuration is preserved.

From an isolated worktree, run `node infra/access/deploy.mjs prepare`, inspect
`.access-work/public-plan.json`, then run `node infra/access/deploy.mjs apply`.
Preparation tests routing in the AWS edge runtime. Apply backs up existing
objects and the prior LIVE function, uploads the pages, message assets and installer,
publishes routing, and invalidates the changed URLs. It does not rebuild the CLI archive.
Run `THINKER_TEST=1 node infra/access/smoke.mjs` after propagation.
Keep `.access-work/public-*` backups outside the worktree before cleanup.

The material below documents the retired code gate and remains for rollback only.

# Website access gateway

`zerotime.dev` uses CloudFront distribution `E2QP47JPHAN302` and the private
`zerotime-frontend` S3 bucket. Access is enforced by a viewer-request CloudFront
Function **before cache lookup**, including on the distribution hostname. The
older API Gateway routes on this distribution serve a separate application and
are preserved. Thinker's `/metrics` endpoint is also unchanged.

## Access flow

- The landing page, icons and existing `/gokce-bday` site remain public. Other
  static paths require authorization, including all docs aliases, `/dist/*`,
  legacy code-in-path installers and future static objects. A temporary exception
  allows exactly `/dist/thinker.tgz`, `/dist/install.sh`, and `/dist/version.json`
  until **2026-10-02 06:30:25 UTC** (October 1, 11:30:25 p.m. Pacific).
  `production.json:legacyDownloadsUntil` is a fixed deadline checked before every
  cache lookup; access automatically closes at the deadline without redeployment.
- `GET /access/session` accepts the code in `X-Thinker-Access-Code`. The gateway
  compares its SHA-256 hash with the private configuration, then sets a signed
  seven-day `__Host-thinker_session` cookie (`Secure; HttpOnly; SameSite=Strict`).
  A subsequent request restores the UI using that cookie. The browser stores no
  access code, and the public HTML contains no credentials.
- Anonymous docs requests redirect to the landing page and return to the requested
  docs path/fragment after login. Content is withheld by the gateway, not hidden
  by JavaScript. Protected responses use `Cache-Control: private, no-store`.
- A successful login returns a private installation command. Its download token
  is a separate HMAC credential, scoped to installer/archive/version files. It
  cannot authorize docs or mint a browser session. The wrapper passes the private
  distribution URL into the installer, which persists it for future updates.
  Download credentials deliberately last until key rotation so unattended
  updates do not expire after seven days. Treat these URLs like passwords.
- WAF limits `/access/session` requests to approximately 30 per source IP per
  five-minute window, returning 429. This includes session restoration. AWS rate
  limits are approximate; users sharing an IP share this limit. WAF sampling is
  disabled and CloudFront access logging is disabled to avoid logging credentials.
- S3 blocks public access and allows reads only from this CloudFront distribution.
  This prevents bypassing the gateway through an S3 object URL.

Existing installations with
`https://zerotime.dev/dist/thinker.tgz` in `~/.thinker/install.json` must obtain the
new install command to retain downloads/updates after the temporary window.
The window does not repair the GitHub lookup in old updaters or give clients a
private URL. This gate cannot retract files
that people previously downloaded.

## Credentials and deployment

The `thinker/site/access` secret in AWS Secrets Manager, us-east-1, contains
`accessCode`, `signingKey`, and an optional `additionalAccessCodes` array. All
configured codes are accepted and are case-sensitive. IAM operators with
secret/function read access are trusted. Do not commit the rendered function,
private URLs, test cookies or `.access-work/` files.

```sh
# Run from an isolated worktree; uses the yoav AWS profile.
node --test test/access-gateway.test.js
node infra/access/deploy.mjs prepare
# Inspect .access-work/distribution-before.json and distribution-after.json.
node infra/access/deploy.mjs apply
# Wait until CloudFront reports Deployed, then verify live behavior.
node infra/access/smoke.mjs --install
```

`prepare` creates/reuses the secret, uploads the DEVELOPMENT function, runs AWS
edge-runtime tests, and prepares WAF and response headers. `apply` checks the
snapshot ETag and page hashes, saves previous pages, publishes the function,
updates the distribution, uploads the pages and invalidates cached routes.
Neither command rebuilds or replaces the current CLI archive. The deployment
uses the existing `/dist/install.sh` and `/dist/thinker.tgz` objects.
For function-only changes, `apply --edge-only` requires the distribution config
to be unchanged, then publishes the function and invalidates caches without
rewriting website pages.

The smoke test checks anonymous/invalid/forged access, every docs alias before and
after an authenticated cache hit, cookie attributes and restoration, the installer
and archive, and S3/CDN bypass attempts. `--install` also runs a real installation
in `.access-work/` with learning, telemetry, builds and scheduled updates disabled.
It verifies that future downloads retain the private distribution URL. Run
`--install` from a terminal: the existing installer opens `/dev/tty` when piped.

To add a code while retaining the existing one, append it to
`additionalAccessCodes` in Secrets Manager and run `prepare`/`apply --edge-only`.
To rotate the primary access code, edit `accessCode` in Secrets Manager and run
`prepare`/`apply`. To revoke existing sessions **and** download credentials, also
replace `signingKey` with a new cryptographically random 32-byte key encoded as
64 hex characters. Code-only rotation does not revoke existing sessions/downloads.
The new configuration takes effect after CloudFront propagation.

## Rollback

Keep the deployment's private `.access-work/` snapshot outside the disposable
worktree until rollout is accepted. It contains `distribution-before.json` and
`backup-index.html`, `backup-docs.html`, `backup-docs-index.html`. Revert the edge
association using the saved distribution config and a **fresh** live ETag; restore
those three S3 objects and invalidate the changed paths. Restoring the old edge
function reopens the old public access, so use only as an intentional rollback.
For an update to an already deployed gate, also retain the previous LIVE function
code before publishing; changing its association alone does not restore code.

AWS references: [viewer-request functions and cache order](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-cloudfront-events.html),
[function event and response format](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html),
[runtime cryptography](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html),
[WAF rate limits](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html).
