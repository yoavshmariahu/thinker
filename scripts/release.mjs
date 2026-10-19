#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ASSETS = ['thinker.tgz', 'version.json', 'install.sh'];
const compare = (a, b) => {
  const x = a.replace(/^v/, '').split('.').map(Number), y = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const execute = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const ask = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question(question); } finally { rl.close(); }
};

const USAGE = 'Usage: bash scripts/release.sh [X.Y.Z] [--no-wait] [--hold] | X.Y.Z --promote';
export function parseArgs(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.some(a => a.startsWith('--') && !['--no-wait', '--hold', '--promote'].includes(a)) || positional.length > 1) throw new Error(USAGE);
  const version = positional[0]?.replace(/^v/, '');
  if (version && !VERSION.test(version)) throw new Error('Specify a stable version, for example 0.1.44 (not a commit or patch/minor alias).');
  const hold = args.includes('--hold'), promote = args.includes('--promote');
  if (promote && (hold || args.includes('--no-wait'))) throw new Error(`--promote takes no other option. ${USAGE}`);
  if (promote && !version) throw new Error('Name the held version to promote, for example: bash scripts/release.sh 0.1.44 --promote');
  return promote ? { version, promote } : { version, noWait: args.includes('--no-wait'), hold };
}

// A held release (--hold) is public under its tag but never `latest`: a GitHub pre-release, which
// releases/latest skips, and npm's `next` tag. Installs and updates that follow latest (the default,
// and the daily background update) do not move; `thinker update vX.Y.Z` and the installer's `--ref`
// install it by name. --promote makes it latest on both.
export async function release({ version, noWait = false, hold = false, promote = false } = {}, {
  repo = ROOT, run = execute, out = console.log, interactive = !!process.stdin.isTTY,
  confirm = ask, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), env = process.env,
} = {}) {
  // Includes installs, tests and all their children: no production telemetry or learning from release validation.
  const childEnv = { ...env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off' };
  const invoke = (cmd, args, opts = {}) => run(cmd, args, { cwd: repo, env: childEnv, ...opts });
  const command = (cmd, args, opts = {}) => {
    const r = invoke(cmd, args, opts);
    if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed${r.status == null ? '' : ` (exit ${r.status})`}: ${r.error?.message || r.stderr || 'see output above'}`);
    return String(r.stdout || '').trim();
  };
  const git = (...args) => command('git', args);
  const optional = (cmd, args, absent) => {
    const r = invoke(cmd, args);
    if (r.status === 0) return String(r.stdout || '').trim();
    if (absent.test(String(r.stderr || '') + String(r.stdout || ''))) return null;
    throw new Error(`${cmd} lookup failed: ${r.error?.message || r.stderr || r.stdout || r.status}`);
  };
  command('gh', ['auth', 'status']);
  const ghrepo = env.THINKER_GH_REPO || command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const gh = (...args) => command('gh', [...args, '--repo', ghrepo]);
  git('fetch', 'origin', 'main', '--tags');
  const versionAt = ref => JSON.parse(git('show', `${ref}:package.json`)).version;
  const mainVersion = versionAt('origin/main');
  version ||= mainVersion;
  if (!VERSION.test(version)) throw new Error('Only stable X.Y.Z releases are supported.');
  const tag = `v${version}`, branch = `release/${tag}`;
  let retry = `bash scripts/release.sh ${version}${hold ? ' --hold' : ''}${promote ? ' --promote' : ''}`;
  const tagCommit = () => {
    const r = invoke('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
    if (r.status === 0) return String(r.stdout).trim();
    if (r.status === 1) return null;
    throw new Error(`Cannot read tag ${tag}: ${r.stderr || r.error?.message}`);
  };
  const prFields = 'url,state,mergeCommit,headRefOid,baseRefName';
  const prs = () => JSON.parse(gh('pr', 'list', '--head', branch, '--base', 'main', '--state', 'all', '--json', prFields));
  const releaseInfo = () => {
    const s = optional('gh', ['release', 'view', tag, '--repo', ghrepo, '--json', 'isDraft,isPrerelease,assets,url'], /release not found|HTTP 404/i);
    return s === null ? null : JSON.parse(s);
  };
  const npmVersion = spec => {
    const s = optional('npm', ['view', spec, 'version', '--json'], /\bE404\b/);
    return s === null ? null : JSON.parse(s);
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-release-'));
  const checkout = path.join(temp, 'src'), dist = path.join(temp, 'dist');
  let worktree = false, testedTree = null;
  const cleanup = () => {
    if (worktree) {
      const r = invoke('git', ['worktree', 'remove', '--force', checkout]);
      if (r.status !== 0) { out(`Could not clean up ${checkout}; remove it with git worktree remove --force.`); return; }
      worktree = false;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  const interrupted = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const at = (cmd, args, opts = {}) => command(cmd, args, { cwd: checkout, ...opts });
  const checkoutAt = ref => {
    if (!worktree) { git('worktree', 'add', '--detach', checkout, ref); worktree = true; }
    else at('git', ['checkout', '--detach', ref]);
  };
  const test = () => {
    const tree = at('git', ['rev-parse', 'HEAD^{tree}']);
    if (tree === testedTree) return;
    out('Installing dependencies and running the full test suite (THINKER_TEST=1)...');
    at('npm', ['ci'], { stdio: 'inherit' });
    at('npm', ['test'], { stdio: 'inherit' });
    testedTree = tree;
  };
  const manifestAt = url => {
    const r = invoke('curl', ['-fsSL', '--max-time', '20', url]);
    try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
  };
  // npx and `thinker update` install the latest stable release. Verify that public URL too, not just GitHub's API.
  const verifyLatestManifest = async (commit, unless) => {
    let m;
    for (let i = 0; i < 15; i++) {
      m = manifestAt(`https://github.com/${ghrepo}/releases/latest/download/version.json`);
      if (m && VERSION.test(m.version) && compare(m.version, version) >= 0) break;
      await sleep(2000);
    }
    if (!m || !VERSION.test(m.version) || compare(m.version, version) < 0 || (m.version === version && m.commit !== commit)) {
      throw new Error(`The public latest-release manifest does not yet point to this release or a newer one. ${unless}`);
    }
  };
  // a held release: its own download URL, the one `thinker update vX.Y.Z` reads
  const verifyTagManifest = async commit => {
    let m;
    for (let i = 0; i < 15; i++) {
      m = manifestAt(`https://github.com/${ghrepo}/releases/download/${tag}/version.json`);
      if (m?.version === version) break;
      await sleep(2000);
    }
    if (m?.version !== version || m.commit !== commit) throw new Error(`The public manifest of ${tag} does not match this release. npm has not been published.`);
  };
  const promoteHeld = async () => {
    const commit = tagCommit();
    const info = releaseInfo();
    if (!commit || !info) throw new Error(`${tag} has no release to promote. Cut it first: bash scripts/release.sh ${version} --hold`);
    if (info.isDraft) throw new Error(`${tag} is still a draft. Finish it first: bash scripts/release.sh ${version} --hold`);
    const npmpkg = JSON.parse(git('show', `${tag}:npm/package.json`)).name;
    if (env.THINKER_NPM_PUBLISH !== '0' && npmVersion(`${npmpkg}@${version}`) !== version) {
      throw new Error(`${npmpkg}@${version} is not on npm yet. Finish the held release first: bash scripts/release.sh ${version} --hold`);
    }
    const latest = optional('gh', ['api', `repos/${ghrepo}/releases/latest`], /HTTP 404/i);
    const latestTag = latest && JSON.parse(latest).tag_name;
    if (latestTag && latestTag !== tag && VERSION.test(latestTag.replace(/^v/, '')) && compare(latestTag, version) > 0) {
      throw new Error(`${latestTag} is newer and already the latest release; promoting ${tag} would move everyone back.`);
    }
    if (info.isPrerelease || latestTag !== tag) {
      out(`Promoting ${tag} to the latest release...`);
      gh('release', 'edit', tag, '--prerelease=false', '--latest', '--verify-tag');
    }
    await verifyLatestManifest(commit, 'npm latest has not been moved.');
    out(`GitHub release is latest: https://github.com/${ghrepo}/releases/tag/${tag}`);
    if (env.THINKER_NPM_PUBLISH === '0') { out('npm skipped as requested by THINKER_NPM_PUBLISH=0.'); return { version, promoted: true, npm: false }; }
    if (npmVersion(npmpkg) !== version) {
      if (invoke('npm', ['whoami']).status !== 0) {
        if (!interactive) throw new Error(`npm login is required. Run npm login --auth-type=web, then ${retry}`);
        command('npm', ['login', '--auth-type=web'], { stdio: 'inherit' });
        command('npm', ['whoami']);
      }
      command('npm', ['dist-tag', 'add', `${npmpkg}@${version}`, 'latest'], { stdio: 'inherit' });
      let now;
      for (let i = 0; i < 15; i++) { now = npmVersion(npmpkg); if (now === version) break; await sleep(2000); }
      if (now !== version) throw new Error(`npm dist-tag returned, but ${npmpkg} latest is not ${version}. Rerun ${retry} to verify.`);
    }
    out(`Promoted: ${tag} is the latest release on GitHub and ${npmpkg}@${version} is latest on npm. Installs and updates move to it now.`);
    return { version, promoted: true, npm: true, commit };
  };
  try {
    if (promote) return await promoteHeld();
    let commit = tagCommit();
    if (!commit) {
      let pr = prs()[0];
      if (!pr && version !== mainVersion) {
        if (compare(version, mainVersion) < 0) throw new Error(`${version} is older than main (${mainVersion}) and has no release tag or release PR.`);
        const remote = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
        if (remote) {
          git('fetch', 'origin', `refs/heads/${branch}`);
          checkoutAt('FETCH_HEAD');
          const files = at('git', ['diff', '--name-only', 'origin/main...HEAD']).split('\n').filter(Boolean);
          if (readJson(path.join(checkout, 'package.json')).version !== version || files.some(f => !['package.json', 'package-lock.json'].includes(f))) {
            throw new Error(`Existing branch ${branch} is not a version-only bump; inspect it manually.`);
          }
        } else {
          checkoutAt('origin/main');
          at('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: 'inherit' });
          at('git', ['add', 'package.json', 'package-lock.json']);
          at('git', ['commit', '-m', `Release ${version}`], { stdio: 'inherit' });
        }
        test(); // Required before pushing a release PR; do not rely on disabled GitHub test workflows.
        at('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' });
        const bodyFile = path.join(temp, 'pr.md');
        fs.writeFileSync(bodyFile, `Bump package.json and package-lock.json to ${version}.\n\nValidation: npm ci and the full npm test suite passed with THINKER_TEST=1.\n\nReview and merge this PR to continue the manual release. No automatic merge.\n`);
        gh('pr', 'create', '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body-file', bodyFile);
        pr = prs()[0];
        if (!pr) throw new Error(`Could not find the release PR. Rerun: ${retry}`);
      }
      if (pr) {
        out(`Release PR: ${pr.url}`);
        while (pr.state !== 'MERGED') {
          if (pr.state === 'CLOSED') throw new Error('The release PR was closed without merging. No release was published.');
          if (noWait || !interactive) {
            out(`Review and merge the PR, then rerun: ${retry}`);
            return { pending: true, pr: pr.url, version };
          }
          await confirm('Review and merge the PR in GitHub, then press Enter to continue (Ctrl-C to resume later): ');
          pr = JSON.parse(gh('pr', 'view', pr.url, '--json', prFields));
        }
        git('fetch', 'origin', 'main', '--tags');
        commit = pr.mergeCommit?.oid;
        if (!commit) throw new Error('Merged PR has no merge commit. Rerun once GitHub reports it.');
      } else commit = git('rev-parse', 'origin/main');
    }
    git('merge-base', '--is-ancestor', commit, 'origin/main');
    if (versionAt(commit) !== version) throw new Error(`Release commit ${commit} does not contain version ${version}.`);
    checkoutAt(commit);
    const npmpkg = readJson(path.join(checkout, 'npm/package.json')).name;
    let published = npmVersion(`${npmpkg}@${version}`);
    let info = releaseInfo();
    if (published && !info) throw new Error('npm has this version but its GitHub release is missing; inspect the release before proceeding.');
    if (hold && info && !info.isDraft && !info.isPrerelease) throw new Error(`${tag} is already released to everyone; it cannot be held.`);
    if (!hold && info?.isPrerelease) {
      // a held release resumes held: only --promote makes it latest
      hold = true; retry += ' --hold';
      out(`${tag} is held; finishing it held. To make it the latest release: bash scripts/release.sh ${version} --promote`);
    }
    if (!published || !info || info.isDraft) test();
    out(`Building ${tag} from ${commit}...`);
    at('bash', ['scripts/pack.sh'], { stdio: 'inherit', env: { ...childEnv, THINKER_DIST_DIR: dist } });
    const verify = dir => {
      const m = readJson(path.join(dir, 'version.json'));
      if (m.version !== version || m.commit !== commit || m.sha256 !== sha256(path.join(dir, 'thinker.tgz'))) throw new Error('Release manifest version, commit or archive checksum does not match.');
      const listing = command('tar', ['-tzf', path.join(dir, 'thinker.tgz')]).split('\n');
      if (!listing.includes('src/cli.js') || listing.some(f => f.startsWith('src/server') || f.endsWith('.test.js'))) throw new Error('Release archive has missing CLI or private/test files.');
      const pkg = JSON.parse(command('tar', ['-xOf', path.join(dir, 'thinker.tgz'), 'package.json']));
      if (pkg.version !== version || pkg.bin?.['thinker-server']) throw new Error('Archive package metadata is wrong.');
    };
    verify(dist);
    if (readJson(path.join(dist, 'npm/package.json')).version !== version) throw new Error('npm package has the wrong version.');
    // Renew login before publishing anything. npm login/publish inherit the terminal for browser/2FA approval.
    if (!published && env.THINKER_NPM_PUBLISH !== '0') {
      if (invoke('npm', ['whoami']).status !== 0) {
        if (!interactive) throw new Error(`npm login is required. Run npm login --auth-type=web, then ${retry}`);
        command('npm', ['login', '--auth-type=web'], { stdio: 'inherit' });
        command('npm', ['whoami']);
      }
    }
    // Never replace a tag or overwrite the assets of a public release.
    const existingTag = tagCommit();
    if (existingTag && existingTag !== commit) throw new Error(`${tag} points to a different commit.`);
    if (!existingTag) git('tag', '-a', tag, commit, '-m', `thinker ${version}`);
    git('push', 'origin', `refs/tags/${tag}`);
    if (!info) {
      const args = ['release', 'create', tag, '--verify-tag', '--draft', ...(hold ? ['--prerelease'] : []), '--title', `thinker ${version}`, '--generate-notes'];
      const previous = invoke('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${commit}^`]);
      if (previous.status === 0) args.push('--notes-start-tag', String(previous.stdout).trim());
      gh(...args);
      info = releaseInfo();
      if (!info) throw new Error('GitHub did not return the newly created draft release.');
    }
    if (info.isDraft) {
      gh('release', 'upload', tag, ...ASSETS.map(f => path.join(dist, f)), '--clobber');
      // Preserve a newer release's latest status when resuming an older incomplete release.
      const latest = optional('gh', ['api', `repos/${ghrepo}/releases/latest`], /HTTP 404/i);
      const latestTag = latest && JSON.parse(latest).tag_name;
      const newer = latestTag && VERSION.test(latestTag.replace(/^v/, '')) && compare(latestTag, version) > 0;
      if (hold) gh('release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false', '--verify-tag');
      else gh('release', 'edit', tag, '--draft=false', `--latest=${!newer}`, '--verify-tag');
    }
    const live = path.join(temp, 'published'); fs.mkdirSync(live);
    gh('release', 'download', tag, '--dir', live, ...ASSETS.flatMap(f => ['--pattern', f]));
    verify(live);
    if (!fs.readFileSync(path.join(live, 'install.sh')).equals(fs.readFileSync(path.join(dist, 'install.sh')))) throw new Error('Published installer differs from the tagged source.');
    if (hold) await verifyTagManifest(commit);
    else await verifyLatestManifest(commit, 'npm has not been published.');
    out(`GitHub release verified${hold ? ' (held: not latest)' : ''}: https://github.com/${ghrepo}/releases/tag/${tag}`);
    if (env.THINKER_NPM_PUBLISH === '0') { out('npm skipped as requested by THINKER_NPM_PUBLISH=0.'); return { version, github: true, npm: false }; }
    if (!published) {
      const packed = JSON.parse(command('npm', ['pack', path.join(dist, 'npm'), '--json', '--ignore-scripts', '--pack-destination', dist]));
      if (packed.length !== 1 || packed[0].name !== npmpkg || packed[0].version !== version || path.basename(packed[0].filename) !== packed[0].filename) throw new Error('npm pack produced unexpected metadata.');
      const latest = npmVersion(npmpkg);
      const npmTag = hold ? 'next' : latest && VERSION.test(latest) && compare(latest, version) > 0 ? `release-${version}` : 'latest';
      command('npm', ['publish', path.join(dist, packed[0].filename), '--access', 'public', '--tag', npmTag], { stdio: 'inherit' });
      for (let i = 0; i < 15; i++) {
        published = npmVersion(`${npmpkg}@${version}`);
        if (published === version) break;
        await sleep(2000);
      }
      if (published !== version) throw new Error(`npm publish returned, but ${npmpkg}@${version} is not visible. Rerun ${retry} to verify.`);
    }
    if (hold) {
      out(`Held release complete: ${tag} on GitHub (pre-release) and ${npmpkg}@${version} on npm (tag next). Nothing updates to it by itself.`);
      out(`Install it by name: thinker update ${tag}. Release it to everyone: bash scripts/release.sh ${version} --promote`);
      return { version, github: true, npm: true, commit, held: true };
    }
    out(`Release complete: ${tag} on GitHub and ${npmpkg}@${version} on npm.`);
    return { version, github: true, npm: true, commit };
  } catch (error) {
    throw new Error(`${error.message}\nResume safely with: ${retry}`, { cause: error });
  } finally {
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(`${USAGE}\nCreates a version PR, waits for your merge, then tags and publishes GitHub + npm.\nRerun the same version to resume. No version resumes origin/main’s current version.\n--no-wait stops after opening a PR. Browser/2FA approvals remain interactive.\n--hold publishes it without making it latest: nothing updates to it until X.Y.Z --promote.`);
    else { const result = await release(options); if (result.pending) process.exitCode = 2; }
  } catch (error) { console.error(`release: ${error.message}`); process.exitCode = 1; }
}
