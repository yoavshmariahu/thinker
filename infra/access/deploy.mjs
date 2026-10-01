#!/usr/bin/env node
// prepare creates a development function and reviewable deployment snapshot.
// apply activates that exact snapshot. Never prints or commits credentials.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import crypto from 'node:crypto';

const config = JSON.parse(fs.readFileSync(new URL('./production.json', import.meta.url)));
const root = path.resolve(import.meta.dirname, '../..');
const work = path.join(root, '.access-work');
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
function save(name, data) {
  const file = path.join(work, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}
function aws(args, region = config.region) {
  try {
    const text = execFileSync('aws', ['--profile', config.profile, '--region', region, ...args, '--output', 'json'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
    return text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    // AWS errors/argv can contain secret payloads. Only return the service's error name.
    const type = String(error.stderr).match(/\(([^)]+)\) when calling/);
    const safe = new Error(`AWS ${args[0]} ${args[1]} failed (${type?.[1] || 'see AWS service status/credentials'})`);
    safe.awsType = type?.[1];
    throw safe;
  }
}
function fileArg(name, data) { return 'file://' + save(name, data); }
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const mode = process.argv[2];
if (mode === 'prepare') {
  const snapshot = aws(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
  save('distribution-before.json', snapshot);
  const distribution = structuredClone(snapshot.DistributionConfig);
  if (distribution.DefaultCacheBehavior.TargetOriginId !== 'S3-zerotime-frontend') throw new Error('Unexpected default origin');
  const associations = distribution.DefaultCacheBehavior.FunctionAssociations.Items || [];
  if (associations.some(a => a.FunctionARN.split('/').pop() !== 'zerotime-www-redirect' && a.FunctionARN.split('/').pop() !== config.functionName)) {
    throw new Error('Unknown existing edge function; reconcile before deployment');
  }
  // The origin must remain private; gateway protection is not sufficient otherwise.
  const block = aws(['s3api', 'get-public-access-block', '--bucket', config.bucket], config.bucketRegion).PublicAccessBlockConfiguration;
  if (!Object.values(block).every(Boolean)) throw new Error('S3 public access block must be enabled');
  const policy = JSON.parse(aws(['s3api', 'get-bucket-policy', '--bucket', config.bucket], config.bucketRegion).Policy);
  const account = aws(['sts', 'get-caller-identity']).Account;
  const expectedArn = `arn:aws:cloudfront::${account}:distribution/${config.distributionId}`;
  if (policy.Statement.length !== 1 || policy.Statement[0].Principal?.Service !== 'cloudfront.amazonaws.com' ||
      policy.Statement[0].Condition?.StringEquals?.['AWS:SourceArn'] !== expectedArn) throw new Error('Review unexpected S3 bucket policy');
  let secret;
  try {
    secret = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', config.secretId]).SecretString);
  } catch (error) {
    if (error.awsType !== 'ResourceNotFoundException') throw error;
    secret = { accessCode: randomBytes(18).toString('base64url'), signingKey: randomBytes(32).toString('hex') };
    aws(['secretsmanager', 'create-secret', '--name', config.secretId, '--secret-string', fileArg('secret.json', secret)]);
  }
  if (!secret.accessCode || !/^[a-f0-9]{64}$/.test(secret.signingKey)) throw new Error('Invalid access secret');
  if (secret.additionalAccessCodes !== undefined && !Array.isArray(secret.additionalAccessCodes)) throw new Error('Invalid additional access codes');
  const accessCodes = [secret.accessCode, ...(secret.additionalAccessCodes || [])];
  if (accessCodes.some(value => typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256)) throw new Error('Invalid access code');
  const code = fs.readFileSync(path.join(root, 'infra/access/gateway.js'), 'utf8').replace('__ACCESS_CONFIG__', JSON.stringify({
    codeHashes: [...new Set(accessCodes.map(hash))], signingKey: secret.signingKey, legacyDownloadsUntil: config.legacyDownloadsUntil
  }));
  if (Buffer.byteLength(code) > 10240) throw new Error('CloudFront function exceeds 10 KB');
  const codePath = save('gateway.js', code);
  let existing;
  try { existing = aws(['cloudfront', 'describe-function', '--name', config.functionName]); }
  catch (error) { if (error.awsType !== 'NoSuchFunctionExists') throw error; }
  if (existing?.FunctionSummary.Status === 'DEPLOYED') {
    aws(['cloudfront', 'get-function', '--name', config.functionName, '--stage', 'LIVE', save('gateway-before.js', '')]);
  }
  const functionConfig = fileArg('function-config.json', { Comment: 'Server-enforced thinker docs and download access', Runtime: 'cloudfront-js-2.0' });
  const prepared = aws(['cloudfront', existing ? 'update-function' : 'create-function', '--name', config.functionName,
    ...(existing ? ['--if-match', existing.ETag] : []), '--function-config', functionConfig, '--function-code', 'fileb://' + codePath]);
  const functionArn = prepared.FunctionSummary.FunctionMetadata.FunctionARN;
  // Exercise AWS's actual edge runtime, not just Node's VM.
  const context = vm.createContext({ require: () => crypto });
  vm.runInContext(code, context);
  const event = uri => ({ version: '1.0', context: { eventType: 'viewer-request' }, viewer: { ip: '192.0.2.1' },
    request: { method: 'GET', uri, querystring: {}, headers: { host: { value: 'zerotime.dev' } }, cookies: {} } });
  const goodLogin = event('/access/session');
  goodLogin.request.headers['x-thinker-access-code'] = { value: secret.accessCode };
  const cookies = context.handler(goodLogin).cookies;
  const goodDocs = event('/docs.html'); goodDocs.request.cookies = { '__Host-thinker_session': { value: cookies['__Host-thinker_session'].value } };
  for (const [name, request, expected] of [
    ['docs-denied', event('/docs.html'), 302], ['legacy-download', event('/dist/thinker.tgz'), Date.now() < Date.parse(config.legacyDownloadsUntil) ? null : 403],
    ['other-download-denied', event('/dist/releases/old/thinker.tgz'), 403],
    ['login-denied', event('/access/session'), 401], ['login-valid', goodLogin, 200], ['docs-valid', goodDocs, null],
    ...accessCodes.slice(1).map((value, index) => {
      const request = event('/access/session');
      request.request.headers['x-thinker-access-code'] = { value };
      return [`login-additional-${index}`, request, 200];
    })
  ]) {
    const result = aws(['cloudfront', 'test-function', '--name', config.functionName, '--if-match', prepared.ETag,
      '--stage', 'DEVELOPMENT', '--event-object', 'fileb://' + save(`test-${name}.json`, request)]).TestResult;
    const parsed = JSON.parse(result.FunctionOutput || '{}');
    const output = parsed.response || parsed.request || parsed;
    if (result.FunctionErrorMessage || (expected ? output.statusCode !== expected : output.uri !== request.request.uri)) throw new Error(`Edge runtime test failed: ${name}`);
    console.log(`Edge runtime: ${name} passed (compute ${result.ComputeUtilization}%)`);
  }
  const responseConfig = { Name: config.responsePolicyName, Comment: 'Prevent private pages and credentials from persisting in browsers',
    CustomHeadersConfig: { Quantity: 1, Items: [
      { Header: 'Cache-Control', Value: 'private, no-store', Override: true }
    ] }, SecurityHeadersConfig: { ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true } } };
  const policies = aws(['cloudfront', 'list-response-headers-policies', '--type', 'custom']).ResponseHeadersPolicyList?.Items || [];
  const existingPolicy = policies.find(p => p.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name === config.responsePolicyName);
  let responsePolicyId;
  if (existingPolicy) {
    responsePolicyId = existingPolicy.ResponseHeadersPolicy.Id;
    const current = aws(['cloudfront', 'get-response-headers-policy', '--id', responsePolicyId]);
    const actual = current.ResponseHeadersPolicy.ResponseHeadersPolicyConfig;
    // AWS returns unset security headers as empty objects on subsequent reads.
    for (const [name, value] of Object.entries(actual.SecurityHeadersConfig || {})) {
      if (value && Object.keys(value).length === 0) delete actual.SecurityHeadersConfig[name];
    }
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(responseConfig))) {
      throw new Error('Existing response policy differs; reconcile before changing a policy already in use');
    }
  } else {
    responsePolicyId = aws(['cloudfront', 'create-response-headers-policy', '--response-headers-policy-config', fileArg('response-policy.json', responseConfig)]).ResponseHeadersPolicy.Id;
  }
  const visibility = { SampledRequestsEnabled: false, CloudWatchMetricsEnabled: true, MetricName: 'thinker-access' };
  const rules = [{ Name: 'AccessAttemptLimit', Priority: 0, Action: { Block: { CustomResponse: { ResponseCode: 429 } } },
    Statement: { RateBasedStatement: { Limit: 30, EvaluationWindowSec: 300, AggregateKeyType: 'IP',
      ScopeDownStatement: { ByteMatchStatement: { SearchString: Buffer.from('/access/session').toString('base64'), FieldToMatch: { UriPath: {} },
        TextTransformations: [{ Priority: 0, Type: 'NONE' }], PositionalConstraint: 'EXACTLY' } } } }, VisibilityConfig: visibility }];
  const acls = aws(['wafv2', 'list-web-acls', '--scope', 'CLOUDFRONT']).WebACLs;
  const acl = acls.find(a => a.Name === config.webAclName);
  let aclArn;
  if (acl) {
    const current = aws(['wafv2', 'get-web-acl', '--scope', 'CLOUDFRONT', '--name', acl.Name, '--id', acl.Id]);
    // Do not replace rules someone added independently.
    if (JSON.stringify(canonical(current.WebACL.Rules)) !== JSON.stringify(canonical(rules))) throw new Error('Existing WAF rules differ; review before updating');
    aclArn = acl.ARN;
  } else {
    aclArn = aws(['wafv2', 'create-web-acl', '--scope', 'CLOUDFRONT', '--name', config.webAclName,
      '--default-action', '{"Allow":{}}', '--visibility-config', fileArg('waf-visibility.json', visibility),
      '--rules', fileArg('waf-rules.json', rules)]).Summary.ARN;
  }
  if (distribution.WebACLId && distribution.WebACLId !== aclArn) throw new Error('Existing WAF association requires manual reconciliation');
  distribution.WebACLId = aclArn;
  distribution.DefaultCacheBehavior.FunctionAssociations = { Quantity: 1, Items: [{ EventType: 'viewer-request', FunctionARN: functionArn }] };
  distribution.DefaultCacheBehavior.ResponseHeadersPolicyId = responsePolicyId;
  save('distribution-after.json', distribution);
  const siteAssets = [
    ['favicon.svg', 'site/favicon.svg', 'image/svg+xml'],
    ['favicon-16x16.png', 'site/favicon-16x16.png', 'image/png'],
    ['favicon-32x32.png', 'site/favicon-32x32.png', 'image/png'],
    ['favicon-48x48.png', 'site/favicon-48x48.png', 'image/png'],
    ['apple-touch-icon.png', 'site/apple-touch-icon.png', 'image/png'],
    ['icon-192.png', 'site/icon-192.png', 'image/png'],
    ['icon-512.png', 'site/icon-512.png', 'image/png'],
    ['favicon.ico', 'site/favicon.ico', 'image/x-icon'],
    ['site.webmanifest', 'site/site.webmanifest', 'application/manifest+json'],
    ['og-image.png', 'site/og-image.png', 'image/png']
  ];
  const fileHashes = {};
  for (const file of ['site/index.html', 'site/docs.html', ...siteAssets.map(a => a[1])]) {
    if (fs.existsSync(path.join(root, file))) fileHashes[file] = hash(fs.readFileSync(path.join(root, file)));
  }
  save('plan.json', { distributionEtag: snapshot.ETag, functionEtag: prepared.ETag, functionArn, codeHash: hash(code), fileHashes });
  console.log('Prepared: signed 7-day browser sessions, private durable download URLs, private/no-store responses, 30 access requests/IP/5 minutes.');
  console.log(`Credentials stored in Secrets Manager: ${config.secretId}. Plan: .access-work/distribution-after.json`);
} else if (mode === 'apply') {
  const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json')));
  for (const [file, expected] of Object.entries(plan.fileHashes)) if (hash(fs.readFileSync(path.join(root, file))) !== expected) throw new Error(`Changed since prepare: ${file}`);
  if (hash(fs.readFileSync(path.join(work, 'gateway.js'))) !== plan.codeHash) throw new Error('Gateway code changed since prepare');
  const current = aws(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
  if (current.ETag !== plan.distributionEtag) throw new Error('Live distribution changed since prepare; reconcile first');
  const edgeOnly = process.argv.includes('--edge-only');
  if (edgeOnly && JSON.stringify(canonical(current.DistributionConfig)) !==
      JSON.stringify(canonical(JSON.parse(fs.readFileSync(path.join(work, 'distribution-after.json')))))) {
    throw new Error('Edge-only deployment requires an unchanged distribution configuration');
  }
  // Save the old objects for rollback before writing anything public.
  if (!edgeOnly) for (const key of ['index.html', 'docs.html', 'docs/index.html']) {
    aws(['s3api', 'get-object', '--bucket', config.bucket, '--key', key, save('backup-' + key.replaceAll('/', '-'), '')], config.bucketRegion);
  }
  aws(['cloudfront', 'publish-function', '--name', config.functionName, '--if-match', plan.functionEtag]);
  const plannedDist = JSON.parse(fs.readFileSync(path.join(work, 'distribution-after.json')));
  if (!edgeOnly && JSON.stringify(canonical(current.DistributionConfig)) !== JSON.stringify(canonical(plannedDist))) {
    const liveDist = aws(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
    aws(['cloudfront', 'update-distribution', '--id', config.distributionId, '--if-match', liveDist.ETag,
      '--distribution-config', 'file://' + path.join(work, 'distribution-after.json')]);
  }
  if (!edgeOnly) {
    for (const [key, file] of [['index.html', 'site/index.html'], ['docs.html', 'site/docs.html'], ['docs/index.html', 'site/docs.html']]) {
      aws(['s3api', 'put-object', '--bucket', config.bucket, '--key', key, '--body', path.join(root, file),
        '--content-type', 'text/html; charset=utf-8', '--cache-control', 'private, no-store'], config.bucketRegion);
    }
    const siteAssets = [
      ['favicon.svg', 'site/favicon.svg', 'image/svg+xml'],
      ['favicon-16x16.png', 'site/favicon-16x16.png', 'image/png'],
      ['favicon-32x32.png', 'site/favicon-32x32.png', 'image/png'],
      ['favicon-48x48.png', 'site/favicon-48x48.png', 'image/png'],
      ['apple-touch-icon.png', 'site/apple-touch-icon.png', 'image/png'],
      ['icon-192.png', 'site/icon-192.png', 'image/png'],
      ['icon-512.png', 'site/icon-512.png', 'image/png'],
      ['favicon.ico', 'site/favicon.ico', 'image/x-icon'],
      ['site.webmanifest', 'site/site.webmanifest', 'application/manifest+json'],
      ['og-image.png', 'site/og-image.png', 'image/png']
    ];
    for (const [key, file, type] of siteAssets) {
      const full = path.join(root, file);
      if (fs.existsSync(full)) {
        aws(['s3api', 'put-object', '--bucket', config.bucket, '--key', key, '--body', full,
          '--content-type', type, '--cache-control', 'public, max-age=86400'], config.bucketRegion);
      }
    }
  }
  const invalidation = aws(['cloudfront', 'create-invalidation', '--distribution-id', config.distributionId,
    '--paths', '/', '/index.html', '/docs*', '/dist/*', '/thinker101/*', '/Thinker101/*', '/access/*',
    '/favicon*', '/apple-touch-icon.png', '/icon-*', '/og-image.png', '/site.webmanifest']);
  save('invalidation.json', invalidation);
  console.log('Deployment submitted. Verify propagation and run smoke.mjs before declaring it complete.');
} else {
  throw new Error('Usage: node infra/access/deploy.mjs prepare|apply [--edge-only]');
}
