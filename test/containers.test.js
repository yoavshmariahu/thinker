import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentContainers, installInContainer, worktreeMounts, describeContainer, containerSnippet, COPY_EXCLUDES } from '../src/containers.js';
import { containersCommand } from '../src/commands/containers.js';

// Every docker call is injected: the suite must never need a daemon, and must never start or change a
// container on the machine it runs on.
const dockerFake = ({ containers = {}, inspect = {}, probes = {}, version = '29.8.2', calls = [] } = {}) => (bin, args) => {
  calls.push(args);
  const sub = args[0];
  if (sub === 'version') { if (!version) throw new Error('Cannot connect to the Docker daemon'); return version; }
  if (sub === 'ps') return Object.keys(containers).join('\n');
  if (sub === 'inspect') return JSON.stringify([inspect[args[1]]]);
  if (sub === 'exec') {
    const id = args.find(a => containers[a]);
    const answer = probes[id];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(args);
    return answer ?? '';
  }
  return '';
};

const container = (name, { mounts = [], image = 'devcontainers/javascript-node:22' } = {}) =>
  ({ Name: '/' + name, Config: { Image: image }, Mounts: mounts.map(([host, inside]) => ({ Type: 'bind', Source: host, Destination: inside })) });

test('a container is only offered when it runs an agent, shares a checkout, has node and has no thinker', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-other-'));
  try {
    const exec = dockerFake({
      containers: { dev: 1, dbonly: 1, already: 1, nonode: 1, unshared: 1, locked: 1 },
      inspect: {
        dev: container('dev', { mounts: [[repo, '/workspaces/repo']] }),
        dbonly: container('dbonly', { image: 'postgres:17-alpine' }),
        already: container('already', { mounts: [[repo, '/w']] }),
        nonode: container('nonode', { mounts: [[repo, '/w']] }),
        unshared: container('unshared', { mounts: [[other, '/w']] }),
        locked: container('locked', { mounts: [[repo, '/w']] }),
      },
      probes: {
        dev: 'agent=claude\nagent=codex\nnode=v22.23.3\nhome=/home/node',
        dbonly: 'home=/root',
        already: 'agent=claude\nthinker=home\nnode=v22.23.3\nhome=/home/node',
        nonode: 'agent=claude\nhome=/home/node',
        unshared: 'agent=claude\nnode=v22.23.3\nhome=/home/node',
        locked: new Error('Error response from daemon: container locked is paused'),
      },
    });
    const { docker, containers } = findAgentContainers({ exec, repos: [repo] });
    assert.equal(docker, true);
    const by = Object.fromEntries(containers.map(c => [c.name, c]));
    // a container with no agent in it is not a container anybody codes in: never listed
    assert.equal(by.dbonly, undefined);
    assert.deepEqual(by.dev.agents, ['claude', 'codex']);
    assert.equal(by.dev.wirable, true);
    assert.equal(by.dev.home, '/home/node');
    assert.equal(by.already.wirable, false, 'thinker is already in there');
    assert.equal(by.nonode.wirable, false, 'nothing to run thinker with');
    assert.equal(by.unshared.wirable, false, 'works in no checkout this machine shares');
    assert.equal(by.locked.wirable, false);
    assert.match(by.locked.why, /paused/);
    assert.match(describeContainer(by.locked), /cannot run a command in it/);
    // the reason is in the line for every case, so a list says why it did nothing
    assert.match(describeContainer(by.already), /thinker already inside/);
    assert.match(describeContainer(by.nonode), /no node inside/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('no docker, or a daemon that does not answer, is quiet and not an error', () => {
  const exec = dockerFake({ version: '' });
  assert.deepEqual(findAgentContainers({ exec }), { docker: false, containers: [] });
  const lines = [];
  return containersCommand({ flags: {}, store: null, out: l => lines.push(l), exec })
    .then(() => assert.match(lines.join('\n'), /no docker on this machine/));
});

test('installing copies this build in, leaves the host\'s native modules out, and wires the agents inside', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-app-'));
  try {
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    const calls = [];
    const exec = (bin, args) => { calls.push(args.join(' ')); return args.includes('version') && args.includes('sh') ? 'thinker 9.9.9' : 'Summary: 1 of 1 selected agents connected.'; };
    const spawn = (bin, args, opts) => {
      calls.push(`${bin} ${args.join(' ')}`);
      return { status: 0, stdout: Buffer.from('tarball'), stderr: Buffer.from('') };
    };
    const r = installInContainer({ id: 'dev', name: 'dev', home: '/home/node', agents: ['claude'] }, { app, exec, spawn });
    assert.equal(r.ok, true);
    assert.equal(r.target, '/home/node/.thinker/app');
    assert.equal(r.wired, 'claude');
    assert.deepEqual(r.steps.map(s => s.ok), [true, true, true, true, true]);
    const tar = calls.find(c => c.startsWith('tar '));
    for (const excluded of COPY_EXCLUDES) assert.ok(tar.includes(`--exclude ${excluded}`), `${excluded} must stay on the host`);
    assert.ok(calls.some(c => c.includes('connect --clients claude')), 'the agents found inside are the ones wired');
    // The route inside the container is left alone. A plain `connect` would write
    // ANTHROPIC_BASE_URL=http://127.0.0.1:<port> into the agent's settings and leave launchd or systemd to
    // keep the proxy up; a container has neither, nothing listens on that port (measured in a devcontainer
    // on 2026-11-05, including after a prompt), and the agent in there would fail every model call.
    assert.ok(calls.some(c => c.includes('connect --clients claude --no-proxy')), 'an install must never point the agent in a container at a proxy that cannot stay up there');
    assert.ok(!calls.some(c => c.includes('npm') || c.includes('npx')), 'no network install: the same build as the host goes in');
  } finally { fs.rmSync(app, { recursive: true, force: true }); }
});

test('a failed step stops the install and is named, and nothing claims success', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-app2-'));
  try {
    const exec = () => { throw new Error('permission denied while trying to connect'); };
    const spawn = () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
    const r = installInContainer({ id: 'dev', home: '/home/node', agents: ['claude'] }, { app, exec, spawn });
    assert.equal(r.ok, false);
    assert.equal(r.steps.length, 1, 'it stops at the first step that failed');
    assert.match(r.steps[0].detail, /permission denied/);
  } finally { fs.rmSync(app, { recursive: true, force: true }); }
});

test('a mounted git worktree is named before an install, since git cannot read it inside', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-main-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-wt-'));
  try {
    fs.mkdirSync(path.join(main, '.git'));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/x\n`);
    const worktrees = worktreeMounts({ shared: [{ host: main, inside: '/w1' }, { host: wt, inside: '/w2' }] });
    assert.deepEqual(worktrees.map(m => m.inside), ['/w2']);
  } finally { for (const d of [main, wt]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('the devcontainer snippet is printed, never written, and installs from the registry', () => {
  const snippet = containerSnippet();
  assert.match(snippet, /postCreateCommand/);
  assert.match(snippet, /npx -y thinkersh --no-build/);
  assert.match(snippet, /target=\/home\/node\/\.thinker/);
  const lines = [];
  return containersCommand({ flags: { devcontainer: true }, store: null, out: l => lines.push(l), exec: () => { throw new Error('docker must not be called for a snippet'); } })
    .then(() => assert.equal(lines.join('\n'), snippet));
});
