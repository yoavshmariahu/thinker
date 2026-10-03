#!/usr/bin/env node
// Deploys thinker-server to EC2: packs this checkout, uploads it and bootstrap.sh to S3, makes sure
// the secret exists, then creates the CloudFormation stack (first time) or tells the running
// instance to install the new release (through Systems Manager, no SSH). Ends with a health check.
//
//   node infra/sync/deploy.mjs infra/sync/production.json [--no-release] [--secret-only]
//
// ANTHROPIC_API_KEY in the environment is written into the secret when the secret is created, or
// with --set-api-key; the admin token is generated once and never printed (read it from the secret).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const configFile = args.find(a => !a.startsWith('--')) || 'infra/sync/production.json';
const flag = f => args.includes(f);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
for (const k of ['region', 'stackName', 'hostname', 'hostedZoneId', 'vpc', 'subnet', 'artifactBucket', 'secretName']) if (!config[k]) throw new Error(`missing ${k} in ${configFile}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function aws(a, { input, quiet = false } = {}) {
  const full = ['--region', config.region, ...(config.profile ? ['--profile', config.profile] : []), '--output', 'json', ...a];
  try { return execFileSync('aws', full, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }); }
  catch (e) { if (quiet) throw e; throw new Error(`aws ${a.slice(0, 3).join(' ')}: ${String(e.stderr || e.message).split('\n')[0]}`); }
}
const json = s => { try { return JSON.parse(s); } catch { return null; } };
const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// 1. the secret: admin token, model key, git token
let secretArn;
try { secretArn = json(aws(['secretsmanager', 'describe-secret', '--secret-id', config.secretName], { quiet: true })).ARN; } catch {}
if (!secretArn) {
  const value = { adminToken: 'tk_' + crypto.randomBytes(24).toString('hex'), anthropicApiKey: process.env.ANTHROPIC_API_KEY || '', gitToken: process.env.THINKER_SERVER_GIT_TOKEN || '' };
  const r = json(aws(['secretsmanager', 'create-secret', '--name', config.secretName, '--description', 'thinker-server: admin token, model key, git token', '--secret-string', 'file:///dev/stdin'], { input: JSON.stringify(value) }));
  secretArn = r.ARN;
  log(`created secret ${config.secretName}${value.anthropicApiKey ? '' : ' (no ANTHROPIC_API_KEY in the environment: set anthropicApiKey in the secret and rerun with --secret-only)'}`);
} else if (flag('--set-api-key') || flag('--set-git-token')) {
  const cur = json(json(aws(['secretsmanager', 'get-secret-value', '--secret-id', config.secretName])).SecretString) || {};
  if (flag('--set-api-key')) { if (!process.env.ANTHROPIC_API_KEY) throw new Error('--set-api-key needs ANTHROPIC_API_KEY in the environment'); cur.anthropicApiKey = process.env.ANTHROPIC_API_KEY; }
  if (flag('--set-git-token')) { if (!process.env.THINKER_SERVER_GIT_TOKEN) throw new Error('--set-git-token needs THINKER_SERVER_GIT_TOKEN in the environment'); cur.gitToken = process.env.THINKER_SERVER_GIT_TOKEN; }
  aws(['secretsmanager', 'put-secret-value', '--secret-id', config.secretName, '--secret-string', 'file:///dev/stdin'], { input: JSON.stringify(cur) });
  log('secret updated');
}

// 2. the release: what the server needs of this checkout, as git sees it plus new files
let key = null;
if (!flag('--no-release') && !flag('--secret-only')) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sync-release-'));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'src', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && fs.existsSync(path.join(root, f)));
  const list = path.join(scratch, 'files.txt'); fs.writeFileSync(list, files.join('\n') + '\n');
  const tgz = path.join(scratch, 'release.tgz');
  execFileSync('tar', ['--no-xattrs', '-czf', tgz, '-C', root, '-T', list], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex').slice(0, 16);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  key = `deployments/sync/${commit}-${hash}.tgz`;
  aws(['s3', 'cp', tgz, `s3://${config.artifactBucket}/${key}`, '--only-show-errors', '--sse', 'AES256']);
  aws(['s3', 'cp', path.join(here, 'bootstrap.sh'), `s3://${config.artifactBucket}/deployments/sync/bootstrap.sh`, '--only-show-errors', '--sse', 'AES256']);
  const cur = path.join(scratch, 'current'); fs.writeFileSync(cur, key + '\n');
  aws(['s3', 'cp', cur, `s3://${config.artifactBucket}/deployments/sync/current`, '--only-show-errors', '--sse', 'AES256']);
  fs.rmSync(scratch, { recursive: true, force: true });
  log(`uploaded release ${key} (${files.length} files)`);
}

// 3. the stack
let stack = null;
try { stack = json(aws(['cloudformation', 'describe-stacks', '--stack-name', config.stackName], { quiet: true }))?.Stacks?.[0] || null; } catch {}
const parameters = { Hostname: config.hostname, HostedZoneId: config.hostedZoneId, VpcId: config.vpc, SubnetId: config.subnet, InstanceType: config.instanceType || 't4g.small', ArtifactBucket: config.artifactBucket, SecretArn: secretArn };
const outputs = s => Object.fromEntries((s.Outputs || []).map(o => [o.OutputKey, o.OutputValue]));
if (!stack) {
  if (flag('--secret-only')) process.exit(0);
  const input = { StackName: config.stackName, TemplateBody: fs.readFileSync(path.join(here, 'stack.yaml'), 'utf8'), Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })), Capabilities: ['CAPABILITY_IAM'], Tags: [{ Key: 'project', Value: 'thinker' }] };
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sync-cf-')), 'input.json'); fs.writeFileSync(tmp, JSON.stringify(input), { mode: 0o600 });
  log(`creating stack ${config.stackName} (instance, elastic ip, dns ${config.hostname})`);
  try { aws(['cloudformation', 'create-stack', '--cli-input-json', `file://${tmp}`]); } finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
  aws(['cloudformation', 'wait', 'stack-create-complete', '--stack-name', config.stackName]);
  stack = json(aws(['cloudformation', 'describe-stacks', '--stack-name', config.stackName])).Stacks[0];
  log(`stack created: ${JSON.stringify(outputs(stack))}`);
  log('the instance is installing (first boot takes a few minutes)');
} else if (key) {
  const instance = outputs(stack).InstanceId;
  log(`updating release on ${instance} through Systems Manager`);
  const cmd = json(aws(['ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript', '--comment', 'thinker-sync release', '--parameters', JSON.stringify({ commands: [`aws s3 cp s3://${config.artifactBucket}/deployments/sync/bootstrap.sh /usr/local/sbin/thinker-sync-bootstrap --region ${config.region}`, 'chmod 755 /usr/local/sbin/thinker-sync-bootstrap', '/usr/local/sbin/thinker-sync-bootstrap 2>&1 | tail -n 20'], executionTimeout: ['1200'] })]));
  const id = cmd.Command.CommandId;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const inv = json(aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', instance], { quiet: true }).replace(/^$/, '{}'));
    if (!inv || ['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) continue;
    console.log(inv.StandardOutputContent || ''); if (inv.StandardErrorContent) console.error(inv.StandardErrorContent);
    if (inv.Status !== 'Success') throw new Error(`release failed: ${inv.Status}`);
    break;
  }
}

// 4. health
const url = `https://${config.hostname}`;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) }); if (r.ok) { log(`${url}/health: ${await r.text()}`); process.exit(0); } } catch {}
  await new Promise(r => setTimeout(r, 10_000));
}
console.error(`${url} did not answer in 10 minutes; see the instance's /var/log/thinker-sync-bootstrap.log through Session Manager`);
process.exit(1);
