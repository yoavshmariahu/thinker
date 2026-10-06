#!/usr/bin/env node
// Deploys a candidate writer. Changing the public API target is a separate step,
// after a direct Lambda invocation proves the database connection and INSERT.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aws, awsInput } from '../../scripts/metrics-postgres.js';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const key of ['host', 'vpc', 'subnets', 'databaseSecurityGroup', 'artifactBucket', 'apiId']) {
  if (!config[key]) throw new Error(`Missing deployment config: ${key}`);
}
const writer = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', 'thinker/metrics/writer'], config)).SecretString);
if (writer.host !== config.host || writer.dbname !== 'thinker_metrics' || writer.username !== 'thinker_metrics_writer') {
  throw new Error('Writer secret does not match deployment database');
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(directory, '../../.metrics-work');
fs.mkdirSync(scratch, { recursive: true });
const zip = path.join(scratch, `writer-${Date.now()}.zip`);
execFileSync('zip', ['-qr', zip, 'index.mjs', 'handler.mjs', 'report.mjs', 'messages.mjs', 'package.json', 'node_modules'], { cwd: directory });
const hash = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const key = `deployments/metrics-postgres/${hash}.zip`;
aws(['s3', 'cp', zip, `s3://${config.artifactBucket}/${key}`, '--only-show-errors', '--sse', 'AES256'], config);
const stack = 'thinker-metrics-postgres';
let exists = false;
try { aws(['cloudformation', 'describe-stacks', '--stack-name', stack], config); exists = true; }
catch (err) { if (!String(err.stderr).includes('does not exist')) throw err; }
const parameters = {
  VpcId: config.vpc, SubnetIds: config.subnets.join(','), DatabaseSecurityGroup: config.databaseSecurityGroup,
  DatabaseHost: config.host, DatabaseName: writer.dbname, DatabaseUser: writer.username, DatabasePassword: writer.password,
  ArtifactBucket: config.artifactBucket, ArtifactKey: key, ApiId: config.apiId,
};
const input = {
  StackName: stack, TemplateBody: fs.readFileSync(path.join(directory, 'stack.yaml'), 'utf8'),
  Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
  Capabilities: ['CAPABILITY_IAM'],
};
console.log(`${exists ? 'Updating' : 'Creating'} candidate writer stack ${stack}`);
try {
  awsInput(['cloudformation', exists ? 'update-stack' : 'create-stack'], input, config);
} catch (err) {
  if (String(err.stderr).includes('No updates are to be performed')) {
    console.log('Candidate writer already up to date'); process.exit(0);
  }
  // Never dump execFileSync's error object: it may include the input credentials.
  console.error('CloudFormation deployment failed:', String(err.stderr)); process.exit(1);
}
aws(['cloudformation', 'wait', exists ? 'stack-update-complete' : 'stack-create-complete', '--stack-name', stack], config);
console.log(aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs'], config));
