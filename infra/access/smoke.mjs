#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const config = JSON.parse(fs.readFileSync(new URL('./production.json', import.meta.url)));
const secret = JSON.parse(JSON.parse(execFileSync('aws', ['--profile', config.profile, '--region', config.region,
  'secretsmanager', 'get-secret-value', '--secret-id', config.secretId, '--output', 'json'], { encoding: 'utf8' })).SecretString);
const base = 'https://zerotime.dev';
const request = (url, options = {}) => fetch(new URL(url, base), { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
const publicPage = await request('/');
assert.equal(publicPage.status, 200);
const html = await publicPage.text();
assert.ok(!html.includes(secret.accessCode));
assert.ok(!html.includes('const ACCESS_KEY'));
assert.ok(html.includes("fetch('/access/session'"));
for (const url of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) {
  const response = await request(url);
  assert.equal(response.status, 302, url);
  assert.ok(response.headers.get('location').startsWith('/?next='));
  assert.ok(!(await response.text()).includes('thinker documentation'));
}
for (const url of ['/dist/thinker.tgz', '/dist/install.sh', '/dist/version.json', '/thinker101/install.sh', '/Thinker101/install.sh']) {
  assert.equal((await request(url)).status, 403, url);
}
assert.equal((await request('/access/session', { headers: { 'X-Thinker-Access-Code': 'invalid-code' } })).status, 401);
assert.equal((await request('/docs.html', { headers: { Cookie: '__Host-thinker_session=true' } })).status, 302);
const login = await request('/access/session', { headers: { 'X-Thinker-Access-Code': secret.accessCode } });
assert.equal(login.status, 200);
assert.match(login.headers.get('cache-control'), /no-store/);
const setCookie = login.headers.get('set-cookie');
assert.match(setCookie, /HttpOnly/);
assert.match(setCookie, /Secure/);
assert.match(setCookie, /SameSite=Strict/);
const cookie = setCookie.split(';')[0];
const { installCommand } = await login.json();
for (const url of ['/docs', '/docs/', '/docs.html', '/docs/index.html']) {
  const docs = await request(url, { headers: { Cookie: cookie } });
  assert.equal(docs.status, 200, url);
  assert.match(docs.headers.get('cache-control'), /no-store/);
  assert.ok((await docs.text()).includes('thinker documentation'));
  assert.equal((await request(url)).status, 302, 'anonymous request after a cache hit');
}
const restored = await request('/access/session', { headers: { Cookie: cookie } });
assert.equal(restored.status, 200);
assert.equal((await restored.json()).installCommand, installCommand);
const downloadUrl = installCommand.split(' ')[2];
const bootstrap = await request(downloadUrl);
assert.equal(bootstrap.status, 200);
const script = await bootstrap.text();
execFileSync('bash', ['-n'], { input: script });
assert.ok(script.includes('export THINKER_DIST_URL='));
const artifactBase = downloadUrl.replace('/install.sh', '/');
const installer = await request(artifactBase + 'installer.sh');
assert.equal(installer.status, 200);
execFileSync('bash', ['-n'], { input: await installer.text() });
const artifact = await request(artifactBase + 'thinker.tgz');
assert.equal(artifact.status, 200);
assert.match(artifact.headers.get('cache-control'), /no-store/);
const archive = Buffer.from(await artifact.arrayBuffer());
const listing = execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
assert.match(listing, /src\/cli.js/);
assert.equal((await request('/access/download/' + '0'.repeat(64) + '/thinker.tgz')).status, 403);
assert.equal((await request('https://d377du4vqz6ixi.cloudfront.net/docs.html')).status, 302);
assert.equal((await request('https://www.zerotime.dev/docs.html')).headers.get('location'), 'https://zerotime.dev/docs.html');
assert.equal((await request('https://zerotime-frontend.s3.us-west-1.amazonaws.com/docs.html')).status, 403);
console.log('PASS: anonymous/invalid/forged access blocked; every docs alias protected before and after cache hits; secure session restored; authenticated installer and archive served; S3/CDN bypasses blocked.');
if (process.argv.includes('--install')) {
  const work = path.resolve(import.meta.dirname, '../../.access-work');
  const repo = fs.mkdtempSync(path.join(work, 'install-smoke-'));
  const thinkerHome = path.join(repo, 'tool');
  execFileSync('git', ['init', '-q', repo]);
  // Isolate all client state and suppress learning, spending, telemetry and scheduled tasks.
  const env = { ...process.env, THINKER_HOME: thinkerHome, THINKER_LOG: 'off', THINKER_TELEMETRY: 'off', THINKER_NO_LEARN: '1' };
  try {
    execFileSync('bash', ['-s', '--', '--no-build', '--no-auto-update', '--clients', 'claude', '--no-learn', '--yes'], {
      input: script, cwd: repo, env, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    const safeOutput = String(error.stdout || '') + String(error.stderr || '');
    console.error(safeOutput.replaceAll(secret.accessCode, '<access-code>').replace(/\/access\/download\/[a-f0-9]{64}/g, '/access/download/<token>'));
    throw new Error('Isolated installation failed');
  }
  const installed = JSON.parse(fs.readFileSync(path.join(thinkerHome, 'install.json')));
  assert.equal(installed.dist, artifactBase + 'thinker.tgz');
  assert.ok(fs.existsSync(path.join(thinkerHome, 'app/src/cli.js')));
  assert.ok(fs.existsSync(path.join(repo, '.claude/settings.local.json')));
  console.log('PASS: real isolated installation completed; private download URL retained for updates.');
}
