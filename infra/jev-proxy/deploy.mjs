#!/usr/bin/env node
// Deploy only this stack. Secrets enter AWS via stdin, never arguments, templates or stdout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { template } from './template.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => args[args.indexOf(name) + 1];
const config = JSON.parse(fs.readFileSync(new URL('./production.json', import.meta.url)));
const work = path.resolve('.jev-proxy-work');
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
const templateFile = path.join(work, 'template.json');
fs.writeFileSync(templateFile, JSON.stringify(template(), null, 2));
if (!flag('--apply')) {
  console.log(`Prepared ${templateFile}. Run with --apply to deploy ${config.stackName} in ${config.region}.`);
  process.exit(0);
}
function aws(argv, input) {
  try { return execFileSync('aws', ['--profile', config.profile, '--region', config.region, ...argv], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' },
  }).trim(); } catch (error) {
    // SDK/CLI diagnostics may echo input; report only the operation, not secret-bearing payloads.
    throw new Error(`AWS ${argv.slice(0, 2).join(' ')} failed (exit ${error.status}); inspect AWS resource events.`);
  }
}
const identity = JSON.parse(aws(['sts', 'get-caller-identity']));
if (identity.Account !== config.account) throw new Error('AWS account does not match production.json');
let key = process.env.TYPESAFE_API_KEY || process.env.THINKER_JEV_KEY || process.env.JEV_API_KEY;
if (flag('--env-file')) {
  const env = parseEnv(fs.readFileSync(value('--env-file'), 'utf8'));
  key ||= env.TYPESAFE_API_KEY || env.THINKER_JEV_KEY || env.JEV_API_KEY || env.JEVKEY;
}
if (!key) { try { key = fs.readFileSync(path.join(os.homedir(), '.thinker/jev-key'), 'utf8').trim(); } catch {} }
const secrets = JSON.parse(aws(['secretsmanager', 'list-secrets', '--filter', `Key=name,Values=${config.secretName}`])).SecretList;
let secretArn = secrets.find(s => s.Name === config.secretName)?.ARN;
if (!secretArn) {
  if (!key) throw new Error('No Jev API key available for the new upstream secret');
  secretArn = JSON.parse(aws(['secretsmanager', 'create-secret', '--name', config.secretName,
    '--secret-string', 'file:///dev/stdin', '--tags', 'Key=project,Value=thinker'], JSON.stringify({ apiKey: key.trim() }))).ARN;
  console.log('Created upstream secret (value hidden).');
} else if (flag('--rotate-key')) {
  if (!key) throw new Error('No replacement Jev key available');
  aws(['secretsmanager', 'put-secret-value', '--secret-id', secretArn, '--secret-string', 'file:///dev/stdin'], JSON.stringify({ apiKey: key.trim() }));
  console.log('Rotated upstream secret (cached for at most 60 seconds).');
}
console.log(`Deploying ${config.stackName} in account ${config.account}, ${config.region}…`);
// Stream only CloudFormation status; no secret values occur in this command or template.
execFileSync('aws', ['--profile', config.profile, '--region', config.region, 'cloudformation', 'deploy',
  '--stack-name', config.stackName, '--template-file', templateFile, '--capabilities', 'CAPABILITY_IAM',
  '--parameter-overrides', `SecretArn=${secretArn}`, '--tags', 'project=thinker', '--no-fail-on-empty-changeset'],
{ stdio: 'inherit', env: { ...process.env, AWS_PAGER: '' } });
const stack = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', config.stackName])).Stacks[0];
const outputs = Object.fromEntries(stack.Outputs.map(o => [o.OutputKey, o.OutputValue]));
fs.writeFileSync(path.join(work, 'outputs.json'), JSON.stringify(outputs, null, 2) + '\n');
console.log(JSON.stringify(outputs, null, 2));
