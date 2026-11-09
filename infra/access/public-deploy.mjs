// Deploy only public site routing/assets; preserve the distribution, WAF and private S3 origin.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { aws } from '../../scripts/metrics-postgres.js';
import { RESPONSE_POLICY, cacheControlFor } from './public-headers.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(fs.readFileSync(new URL('./production.json', import.meta.url)));
const work = path.join(root, '.access-work');
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
const save = (name, data) => {
  const file = path.join(work, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
};
const call = (args, region = config.region) => JSON.parse(aws([...args, '--output', 'json'], { ...config, region }) || '{}');
const hash = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
// The current release's files, so thinker.sh/dist serves what GitHub serves. Clients from before 0.1.35
// (`redirect: 'error'` in their updater) still read these; a redirect to GitHub would strand them.
const RELEASE = 'https://github.com/yoavshmariahu/thinker/releases/latest/download/';
const DIST = '.access-work/public-dist';
const assets = [
  ['index.html', 'site/index.html', 'text/html; charset=utf-8'],
  ['how-it-works.html', 'site/how-it-works.html', 'text/html; charset=utf-8'],
  ['home.css', 'site/home.css', 'text/css; charset=utf-8'],
  ['docs.html', 'site/docs.html', 'text/html; charset=utf-8'],
  ['docs/index.html', 'site/docs.html', 'text/html; charset=utf-8'],
  ['compression.html', 'site/compression.html', 'text/html; charset=utf-8'],
  ['clearing.html', 'site/clearing.html', 'text/html; charset=utf-8'],
  ['nav.css', 'site/nav.css', 'text/css; charset=utf-8'],
  ...fs.readdirSync(path.join(root, 'site')).filter(name => /^clearing-[a-z0-9-]+\.json$/.test(name)).sort().map(name => [name, 'site/' + name, 'application/json']),
  ['card.png', 'site/card.png', 'image/png'],
  ['message.js', 'site/message.js', 'text/javascript; charset=utf-8'],
  ['message.css', 'site/message.css', 'text/css; charset=utf-8'],
  ['robots.txt', 'site/robots.txt', 'text/plain; charset=utf-8'],
  ['sitemap.xml', 'site/sitemap.xml', 'application/xml; charset=utf-8'],
  ['.well-known/security.txt', 'site/security.txt', 'text/plain; charset=utf-8'],
  ['dist/install.sh', 'install.sh', 'text/plain; charset=utf-8'],
  ['dist/version.json', DIST + '/version.json', 'application/json'],
  ['dist/thinker.tgz', DIST + '/thinker.tgz', 'application/gzip'],
];
// AWS moves a distribution's ETag when a function it uses is published, so a step is guarded by what
// the distribution holds, never by the ETag `prepare` saw; each update takes the ETag of the moment.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const policyFor = () => {
  const items = call(['cloudfront', 'list-response-headers-policies', '--type', 'custom']).ResponseHeadersPolicyList?.Items || [];
  const found = items.find(p => p.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name === config.responsePolicyName);
  if (!found) throw new Error('Response headers policy not found: ' + config.responsePolicyName);
  return call(['cloudfront', 'get-response-headers-policy', '--id', found.ResponseHeadersPolicy.Id]);
};
const mode = process.argv[2];
if (mode === 'prepare') {
  const snapshot = call(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
  const distribution = snapshot.DistributionConfig;
  if (distribution.DefaultCacheBehavior.TargetOriginId !== 'S3-zerotime-frontend') throw new Error('Unexpected origin');
  const associations = distribution.DefaultCacheBehavior.FunctionAssociations.Items || [];
  if (associations.length !== 1 || associations[0].FunctionARN.split('/').pop() !== config.functionName) throw new Error('Unexpected edge association');
  const block = call(['s3api', 'get-public-access-block', '--bucket', config.bucket], config.bucketRegion);
  if (!Object.values(block.PublicAccessBlockConfiguration).every(Boolean)) throw new Error('S3 origin must stay private');
  save('public-distribution-before.json', snapshot);
  call(['cloudfront', 'get-function', '--name', config.functionName, '--stage', 'LIVE', save('public-gateway-before.js', '')]);
  const existing = call(['cloudfront', 'describe-function', '--name', config.functionName]);
  const prepared = call(['cloudfront', 'update-function', '--name', config.functionName, '--if-match', existing.ETag,
    '--function-config', 'file://' + save('public-function-config.json', { Comment: 'Public Thinker website and downloads', Runtime: 'cloudfront-js-2.0' }),
    '--function-code', 'fileb://' + path.join(root, 'infra/access/public-gateway.js')]);
  const cases = [['/how-it-works', '/how-it-works.html'], ['/home.css', '/home.css'], ['/docs', '/docs.html'], ['/docs/', '/docs.html'], ['/docs.html', '/docs.html'], ['/see-the-data', '/compression.html'], ['/dist/thinker.tgz', '/dist/thinker.tgz'], ['/message.js', '/message.js'],
    ['/robots.txt', '/robots.txt'], ['/sitemap.xml', '/sitemap.xml'], ['/.well-known/security.txt', '/.well-known/security.txt'], ['/security.txt', '/.well-known/security.txt']]
    .map(([uri, expected]) => ({ uri, expected, host: 'thinker.sh' }));
  for (const host of ['thinker.sh', 'zerotime.dev', 'www.zerotime.dev', 'www.thinker.sh']) {
    cases.push({ host, uri: '/compression.html', location: 'https://thinker.sh/see-the-data?run=click-1&tag=a%2Fb&tag=c' });
    if (host !== 'thinker.sh') cases.push({ host, uri: '/docs.html', location: 'https://thinker.sh/docs.html?run=click-1&tag=a%2Fb&tag=c' });
  }
  for (const { uri, expected, host, location } of cases) {
    const event = { version: '1.0', context: { eventType: 'viewer-request' }, viewer: { ip: '192.0.2.1' },
      request: { method: 'GET', uri, querystring: location ? { run: { value: 'click-1' }, tag: { value: 'a%2Fb', multiValue: [{ value: 'a%2Fb' }, { value: 'c' }] } } : {}, headers: { host: { value: host } }, cookies: {} } };
    const result = call(['cloudfront', 'test-function', '--name', config.functionName, '--if-match', prepared.ETag,
      '--stage', 'DEVELOPMENT', '--event-object', 'fileb://' + save('public-test-event.json', event)]).TestResult;
    const parsed = JSON.parse(result.FunctionOutput || '{}');
    const output = parsed.response || parsed.request || parsed;
    if (result.FunctionErrorMessage || (location ? output.statusCode !== 301 || output.headers?.location?.value !== location : output.uri !== expected)) throw new Error('Edge test failed: ' + host + uri);
    console.log('Edge runtime passed:', host + uri);
  }
  // The current release, verified against its own manifest before it is offered under thinker.sh/dist.
  fs.mkdirSync(path.join(root, DIST), { recursive: true, mode: 0o700 });
  const fetchRelease = async name => {
    const response = await fetch(RELEASE + name, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`GitHub release ${name}: ${response.status}`);
    fs.writeFileSync(path.join(root, DIST, name), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  };
  await fetchRelease('version.json'); await fetchRelease('thinker.tgz');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, DIST, 'version.json'), 'utf8'));
  if (hash(DIST + '/thinker.tgz') !== manifest.sha256) throw new Error('GitHub release archive does not match its version.json');
  console.log('Release for /dist:', manifest.version);
  // The response headers policy and the certificate: what the distribution should carry, against what it does.
  const policy = policyFor();
  save('public-response-policy-before.json', policy);
  const certificate = call(['acm', 'describe-certificate', '--certificate-arn', config.certificateArn]).Certificate;
  const aliases = distribution.Aliases.Items || [];
  if (!aliases.every(alias => certificate.SubjectAlternativeNames.includes(alias))) throw new Error('Certificate does not cover every alias: ' + aliases.join(', '));
  const swapCertificate = certificate.Status === 'ISSUED' && distribution.ViewerCertificate.ACMCertificateArn !== config.certificateArn;
  if (certificate.Status !== 'ISSUED') console.log(`Certificate ${certificate.Status}; the distribution keeps its current one this time.`);
  save('public-plan.json', { swapCertificate,
    release: manifest.version,
    hashes: Object.fromEntries([...assets.map(([, file]) => file), 'infra/access/public-gateway.js', 'infra/access/public-headers.mjs'].map(file => [file, hash(file)])) });
  console.log(`Prepared public docs, installer/downloads (release ${manifest.version}), crawler files, response headers${swapCertificate ? ', certificate swap' : ''}. Origin/WAF configuration unchanged.`);
} else if (mode === 'apply') {
  const plan = JSON.parse(fs.readFileSync(path.join(work, 'public-plan.json')));
  for (const [file, expected] of Object.entries(plan.hashes)) if (hash(file) !== expected) throw new Error('Changed since prepare: ' + file);
  const before = JSON.parse(fs.readFileSync(path.join(work, 'public-distribution-before.json'))).DistributionConfig;
  const unchanged = snapshot => { if (!same(snapshot.DistributionConfig, before)) throw new Error('Distribution changed since prepare'); return snapshot; };
  unchanged(call(['cloudfront', 'get-distribution-config', '--id', config.distributionId]));
  for (const [key] of assets) {
    try { call(['s3api', 'get-object', '--bucket', config.bucket, '--key', key, save('public-backup-' + key.replaceAll('/', '-'), '')], config.bucketRegion); }
    catch (error) { if (!/NoSuchKey/.test(String(error.stderr))) throw error; }
  }
  // Assets first: they remain gated until the tested edge routing is published.
  for (const [key, file, type] of assets) call(['s3api', 'put-object', '--bucket', config.bucket, '--key', key,
    '--body', path.join(root, file), '--content-type', type, '--cache-control', cacheControlFor(key)], config.bucketRegion);
  // Each step is rerunnable: an apply that failed part-way is run again, and what is already in place is skipped.
  const local = fs.readFileSync(path.join(root, 'infra/access/public-gateway.js'));
  call(['cloudfront', 'get-function', '--name', config.functionName, '--stage', 'DEVELOPMENT', save('public-gateway-development.js', '')]);
  if (!fs.readFileSync(path.join(work, 'public-gateway-development.js')).equals(local)) throw new Error('Edge function changed since prepare; run prepare again');
  call(['cloudfront', 'get-function', '--name', config.functionName, '--stage', 'LIVE', save('public-gateway-live.js', '')]);
  if (fs.readFileSync(path.join(work, 'public-gateway-live.js')).equals(local)) console.log('Edge function already live.');
  else call(['cloudfront', 'publish-function', '--name', config.functionName, '--if-match', call(['cloudfront', 'describe-function', '--name', config.functionName]).ETag]);
  const policy = policyFor();
  call(['cloudfront', 'update-response-headers-policy', '--id', policy.ResponseHeadersPolicy.Id, '--if-match', policy.ETag,
    '--response-headers-policy-config', 'file://' + save('public-response-policy.json', RESPONSE_POLICY(config.responsePolicyName))]);
  if (plan.swapCertificate) {
    const snapshot = call(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
    if (snapshot.DistributionConfig.ViewerCertificate.ACMCertificateArn === config.certificateArn) console.log('Certificate already on the distribution.');
    else {
      const distribution = structuredClone(unchanged(snapshot).DistributionConfig);
      distribution.ViewerCertificate = { ...distribution.ViewerCertificate, ACMCertificateArn: config.certificateArn, Certificate: config.certificateArn, CertificateSource: 'acm', CloudFrontDefaultCertificate: false };
      call(['cloudfront', 'update-distribution', '--id', config.distributionId, '--if-match', snapshot.ETag, '--distribution-config', 'file://' + save('public-distribution.json', distribution)]);
      console.log('Certificate swapped to', config.certificateArn);
    }
  }
  const invalidation = call(['cloudfront', 'create-invalidation', '--distribution-id', config.distributionId,
    '--paths', '/', '/index.html', '/how-it-works*', '/home.css', '/docs*', '/see-the-data*', '/compression*', '/clearing*', '/nav.css', '/card.png', '/message.*', '/robots.txt', '/sitemap.xml', '/security.txt', '/.well-known/*', '/dist/*', '/access/*', '/thinker101/*', '/Thinker101/*']);
  save('public-invalidation.json', invalidation);
  console.log(`Public site deployed (release ${plan.release} under /dist); invalidation:`, invalidation.Invalidation.Id);
} else throw new Error('Usage: node infra/access/deploy.mjs prepare|apply');
