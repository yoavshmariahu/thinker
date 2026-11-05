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
    const exec = (bin, args) => {
      calls.push(args.join(' '));
      const line = args.join(' ');
      if (line.includes('serviceArgs')) return 'proxy --port 44327 --holdout 0.15 --codex';
      if (line.includes('ANTHROPIC_BASE_URL')) return 'the proxy answers on 44327';
      if (line.includes('version')) return 'thinker 9.9.9';
      return 'Summary: 1 of 1 selected agents connected.';
    };
    const spawn = (bin, args, opts) => {
      calls.push(`${bin} ${args.join(' ')}`);
      return { status: 0, stdout: Buffer.from('tarball'), stderr: Buffer.from('') };
    };
    const r = installInContainer({ id: 'dev', name: 'dev', home: '/home/node', agents: ['claude'] }, { app, exec, spawn });
    assert.equal(r.ok, true);
    assert.equal(r.target, '/home/node/.thinker/app');
    assert.equal(r.wired, 'claude');
    assert.deepEqual(r.steps.map(s => s.ok), [true, true, true, true, true, true, true], 'make, copy, chown, connect, version, start the proxy, verify the route');
    assert.ok(calls.some(c => c.includes('ANTHROPIC_BASE_URL')), 'the route written inside is checked, not assumed');
    // started as a detached exec's own process: a child of a foreground exec does not survive it
    assert.ok(calls.some(c => c.startsWith('exec -d ') && c.includes('cli.js proxy')), 'the proxy is started in the form that stays up in a container');
    const tar = calls.find(c => c.startsWith('tar '));
    for (const excluded of COPY_EXCLUDES) assert.ok(tar.includes(`--exclude ${excluded}`), `${excluded} must stay on the host`);
    assert.ok(calls.some(c => c.includes('connect --clients claude')), 'the agents found inside are the ones wired');
    // The route inside the container is left alone. A plain `connect` would write
    // ANTHROPIC_BASE_URL=http://127.0.0.1:<port> into the agent's settings and leave launchd or systemd to
    // keep the proxy up; a container has neither, nothing listens on that port (measured in a devcontainer
    // on 2026-11-05, including after a prompt), and the agent in there would fail every model call.
    assert.ok(calls.some(c => c.includes('connect --clients claude')) && !calls.some(c => c.includes('--no-proxy')), 'a container gets the full install, the proxy included');
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

// --- the offer ------------------------------------------------------------------------------------------
// The question is put by the agent and answered through thinker's own tool or the command; a yes installs.
// Every docker call is injected here too, and the state is a temporary home: the suite must not look at
// this machine's containers or write its real state.
import { scheduleContainersOffer, containersOffer, containersOfferDue, containersOfferPending, answerContainersOffer, offerState, QUESTION, OPTIONS, AGAIN_DAYS, CANDIDATE_HOURS } from '../src/containers-offer.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-home-'));
const oneWirable = (repo, { thinker = false } = {}) => dockerFake({
  containers: { dev: 1 },
  inspect: { dev: container('dev', { mounts: [[repo, '/workspaces/app']] }) },
  probes: { dev: `agent=claude\nnode=v22.23.3\nhome=/home/node${thinker ? '\nthinker=home' : ''}` },
});

test('the question is asked once, carries the owner\'s wording, and is only asked where there is a container to install into', () => {
  const home = tempHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-repo-'));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    // nothing recorded yet: the hook says nothing and never shells out to docker
    assert.equal(containersOffer(null, { client: 'claude', home }), '');
    // maintenance records the candidate
    const found = scheduleContainersOffer(null, { home, exec: oneWirable(repo) });
    assert.equal(found.name, 'dev');
    assert.equal(containersOfferDue({ home }).name, 'dev');
    const block = containersOffer(null, { client: 'claude', home });
    assert.match(block, /^<thinker-container-offer>/);
    assert.ok(block.includes(`"${QUESTION}"`), 'the question is put exactly as written');
    assert.ok(block.includes(OPTIONS), 'yes, no and never are the options');
    assert.match(block, /AskUserQuestion/);
    assert.match(block, /header "thinker"/);
    assert.match(block, /thinker's `containers` tool/);
    // asked once: a second prompt in the same session, or any later one, says nothing
    assert.equal(containersOffer(null, { client: 'claude', home }), '');
    assert.equal(containersOfferPending(home), true, 'the answer tool is offered while one is awaited');
    // an agent with no way to ask is never handed the question
    const other = tempHome();
    try {
      scheduleContainersOffer(null, { home: other, exec: oneWirable(repo) });
      assert.equal(containersOffer(null, { client: 'goose', home: other }), '');
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally { for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('a container with thinker already in it is never asked about, and a stale candidate is not asked about either', () => {
  const home = tempHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-repo2-'));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    assert.equal(scheduleContainersOffer(null, { home, exec: oneWirable(repo, { thinker: true }) }), null);
    assert.equal(containersOfferDue({ home }), null);
    // a candidate recorded two days ago may be a container that is long gone. The machine is looked at at
    // most daily, so this second look is a day on from the one above.
    const now = Date.now() + 25 * 3600_000;
    scheduleContainersOffer(null, { home, exec: oneWirable(repo), now });
    assert.ok(containersOfferDue({ home, now }));
    assert.equal(containersOfferDue({ home, now: now + (CANDIDATE_HOURS + 1) * 3600_000 }), null);
  } finally { for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('yes installs at once; no waits and never closes it', async () => {
  const home = tempHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-repo3-'));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    const exec = oneWirable(repo);
    const now = Date.now();
    scheduleContainersOffer(null, { home, exec, now });
    containersOffer(null, { client: 'claude', home, now });
    let installed = null;
    const said = await answerContainersOffer('yes', { home, exec, now, client: 'claude', installFn: async c => { installed = c; return { ok: true, target: '/home/node/.thinker/app', wired: 'claude', steps: [] }; } });
    assert.equal(installed.name, 'dev', 'the container the question was asked about is the one wired');
    assert.match(said, /thinker is now in dev/);
    assert.match(said, /postCreateCommand/, 'and says how to keep it across a rebuild');
    assert.equal(offerState(home).choice, 'yes');
    assert.equal(offerState(home).installed, true);

    // no: recorded, nothing installed, and the machine is left alone for AGAIN_DAYS
    const h2 = tempHome();
    scheduleContainersOffer(null, { home: h2, exec, now });
    containersOffer(null, { client: 'claude', home: h2, now });
    const no = await answerContainersOffer('no', { home: h2, exec, now, installFn: () => { throw new Error('a no must install nothing'); } });
    assert.match(no, new RegExp(`not ask again for ${AGAIN_DAYS} days`));
    assert.equal(containersOfferDue({ home: h2, now: now + 29 * 86400_000 }), null);
    assert.equal(scheduleContainersOffer(null, { home: h2, exec, now: now + 29 * 86400_000 }), null, 'and does not even look while it waits');
    assert.ok(scheduleContainersOffer(null, { home: h2, exec, now: now + (AGAIN_DAYS + 1) * 86400_000 }), 'after the wait it looks again');

    // never: closed for good, whatever is found later
    const h3 = tempHome();
    scheduleContainersOffer(null, { home: h3, exec, now });
    containersOffer(null, { client: 'claude', home: h3, now });
    await answerContainersOffer('never ask again', { home: h3, exec, now, installFn: () => { throw new Error('never must install nothing'); } });
    assert.equal(scheduleContainersOffer(null, { home: h3, exec, now: now + 400 * 86400_000 }), null);
    assert.equal(containersOffer(null, { client: 'claude', home: h3, now: now + 400 * 86400_000 }), '');
    for (const d of [h2, h3]) fs.rmSync(d, { recursive: true, force: true });
  } finally { for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('a yes for a container that has gone, or a failed install, says so and claims nothing', async () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'containers-offer.json'), JSON.stringify({ asked: new Date().toISOString(), askedFor: 'dev', candidate: { id: 'dev', foundAt: new Date().toISOString() } }));
    const gone = dockerFake({ containers: {}, inspect: {}, probes: {} });
    assert.match(await answerContainersOffer('yes', { home, exec: gone }), /no longer running, so thinker installed nothing/);
    assert.equal(offerState(home).installed, false);

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-repo4-'));
    fs.mkdirSync(path.join(repo, '.git'));
    const h2 = tempHome();
    const exec = oneWirable(repo);
    scheduleContainersOffer(null, { home: h2, exec });
    containersOffer(null, { client: 'claude', home: h2 });
    const said = await answerContainersOffer('yes', { home: h2, exec, installFn: async () => ({ ok: false, target: '/x', steps: [{ what: 'copy thinker in', ok: false, detail: 'no space left on device' }] }) });
    assert.match(said, /could not finish installing/);
    assert.match(said, /no space left on device/);
    assert.equal(offerState(h2).installed, false);
    for (const d of [repo, h2]) fs.rmSync(d, { recursive: true, force: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an install that leaves a dead proxy route takes it back out rather than break the agent', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctr-dead-'));
  try {
    const calls = [];
    // the proxy wrote its URL into the settings inside and nothing answers on the port
    const exec = (bin, args) => {
      calls.push(args.join(' '));
      if (args.includes('-e')) return 'DEAD:44749';
      if (args.join(' ').includes('version')) return 'thinker 9.9.9';
      return 'Summary: 1 of 1 selected agents connected.';
    };
    const spawn = () => ({ status: 0, stdout: Buffer.from('tar'), stderr: Buffer.from('') });
    const r = installInContainer({ id: 'dev', name: 'dev', home: '/home/node', agents: ['claude'] }, { app, exec, spawn });
    assert.equal(r.ok, false, 'an install that would break the agent is not a success');
    const route = r.steps.find(s => s.what === 'verify the route');
    assert.equal(route.ok, false);
    assert.match(route.detail, /taken back out/);
    assert.ok(calls.some(c => c.includes('proxy off')), 'the route is removed from every agent file inside');
  } finally { fs.rmSync(app, { recursive: true, force: true }); }
});
