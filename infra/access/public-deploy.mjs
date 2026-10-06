// Deploy only public site routing/assets; preserve the distribution, WAF and private S3 origin.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { aws } from '../../scripts/metrics-postgres.js';
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
const assets = [
  ['index.html', 'site/index.html', 'text/html; charset=utf-8'],
  ['docs.html', 'site/docs.html', 'text/html; charset=utf-8'],
  ['docs/index.html', 'site/docs.html', 'text/html; charset=utf-8'],
  ['message.js', 'site/message.js', 'text/javascript; charset=utf-8'],
  ['message.css', 'site/message.css', 'text/css; charset=utf-8'],
  ['dist/install.sh', 'install.sh', 'text/plain; charset=utf-8'],
];
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
  for (const [uri, expected] of [['/docs', '/docs.html'], ['/docs/', '/docs.html'], ['/docs.html', '/docs.html'], ['/dist/thinker.tgz', '/dist/thinker.tgz'], ['/message.js', '/message.js']]) {
    const event = { version: '1.0', context: { eventType: 'viewer-request' }, viewer: { ip: '192.0.2.1' },
      request: { method: 'GET', uri, querystring: {}, headers: { host: { value: 'zerotime.dev' } }, cookies: {} } };
    const result = call(['cloudfront', 'test-function', '--name', config.functionName, '--if-match', prepared.ETag,
      '--stage', 'DEVELOPMENT', '--event-object', 'fileb://' + save('public-test-event.json', event)]).TestResult;
    const parsed = JSON.parse(result.FunctionOutput || '{}');
    if (result.FunctionErrorMessage || (parsed.request || parsed).uri !== expected) throw new Error('Edge test failed: ' + uri);
    console.log('Edge runtime passed:', uri);
  }
  save('public-plan.json', { distributionEtag: snapshot.ETag, functionEtag: prepared.ETag,
    hashes: Object.fromEntries([...assets.map(([, file]) => file), 'infra/access/public-gateway.js'].map(file => [file, hash(file)])) });
  console.log('Prepared public docs, installer/downloads, GitHub links and message form. Origin/WAF configuration unchanged.');
} else if (mode === 'apply') {
  const plan = JSON.parse(fs.readFileSync(path.join(work, 'public-plan.json')));
  for (const [file, expected] of Object.entries(plan.hashes)) if (hash(file) !== expected) throw new Error('Changed since prepare: ' + file);
  const snapshot = call(['cloudfront', 'get-distribution-config', '--id', config.distributionId]);
  if (snapshot.ETag !== plan.distributionEtag) throw new Error('Distribution changed since prepare');
  for (const [key] of assets) {
    try { call(['s3api', 'get-object', '--bucket', config.bucket, '--key', key, save('public-backup-' + key.replaceAll('/', '-'), '')], config.bucketRegion); }
    catch (error) { if (!/NoSuchKey/.test(String(error.stderr))) throw error; }
  }
  // Assets first: they remain gated until the tested edge routing is published.
  for (const [key, file, type] of assets) call(['s3api', 'put-object', '--bucket', config.bucket, '--key', key,
    '--body', path.join(root, file), '--content-type', type, '--cache-control', 'no-cache'], config.bucketRegion);
  call(['cloudfront', 'publish-function', '--name', config.functionName, '--if-match', plan.functionEtag]);
  const invalidation = call(['cloudfront', 'create-invalidation', '--distribution-id', config.distributionId,
    '--paths', '/', '/index.html', '/docs*', '/message.*', '/dist/install.sh', '/access/*', '/thinker101/*', '/Thinker101/*']);
  save('public-invalidation.json', invalidation);
  console.log('Public site deployed; invalidation:', invalidation.Invalidation.Id);
} else throw new Error('Usage: node infra/access/deploy.mjs prepare|apply');
