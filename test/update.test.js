import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectInstall,
  checkPendingNotice,
  maybeCheckDailyUpdateInBackground,
  isScheduled,
  scheduleDaily,
  unscheduleDaily,
  applyUpdate,
  DAY_MS,
} from '../src/update.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

test('detectInstall detects git repo vs archive', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-detect-'));
  try {
    // 1. Git repo
    const gitDir = path.join(tmp, 'git-repo');
    fs.mkdirSync(gitDir);
    execFileSync('git', ['init', '-q'], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.2.0' }));
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
    execFileSync('git', ['add', '.'], { cwd: gitDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir });

    const gitInstall = detectInstall(gitDir, tmp);
    assert.equal(gitInstall.type, 'git');
    assert.equal(gitInstall.version, '0.2.0');
    assert.ok(gitInstall.commit.length >= 7);

    // 2. Archive install
    const archiveDir = path.join(tmp, 'archive-repo');
    fs.mkdirSync(archiveDir);
    fs.writeFileSync(path.join(archiveDir, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.1.5' }));
    fs.writeFileSync(path.join(tmp, 'install.json'), JSON.stringify({
      source: 'archive',
      ghrepo: 'yoavshmariahu/thinker',
      ref: 'main',
      commit: 'abc1234567890',
    }));

    const archiveInstall = detectInstall(archiveDir, tmp);
    assert.equal(archiveInstall.type, 'archive');
    assert.equal(archiveInstall.version, '0.1.5');
    assert.equal(archiveInstall.commit, 'abc1234567890');
    assert.equal(archiveInstall.ghrepo, 'yoavshmariahu/thinker');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkPendingNotice reads and removes notice file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-notice-'));
  try {
    assert.equal(checkPendingNotice(tmp), null);

    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const noticeFile = path.join(stateDir, 'update-notice.json');
    fs.writeFileSync(noticeFile, JSON.stringify({
      from: '111111111111',
      to: '222222222222',
      version: '0.3.0',
    }));

    const notice = checkPendingNotice(tmp);
    assert.ok(notice);
    assert.ok(notice.includes('auto-updated to 2222222'));
    assert.ok(notice.includes('v0.3.0'));

    // File should have been removed
    assert.ok(!fs.existsSync(noticeFile));
    assert.equal(checkPendingNotice(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('maybeCheckDailyUpdateInBackground honors 24h rate limit and flags', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-bg-'));
  try {
    const stampFile = path.join(tmp, 'state', 'update.last');

    // 1. Should write timestamp on first run
    maybeCheckDailyUpdateInBackground({ home: tmp, cliPath: CLI });
    assert.ok(fs.existsSync(stampFile));

    const firstTime = fs.statSync(stampFile).mtimeMs;

    // 2. Immediate second call should be a no-op (skipped due to <24h)
    maybeCheckDailyUpdateInBackground({ home: tmp, cliPath: CLI });
    const secondTime = fs.statSync(stampFile).mtimeMs;
    assert.equal(firstTime, secondTime);

    // 3. If THINKER_NO_AUTO_UPDATE=1, should do nothing
    const oldEnv = process.env.THINKER_NO_AUTO_UPDATE;
    process.env.THINKER_NO_AUTO_UPDATE = '1';
    try {
      // Artificially age the timestamp by 2 days
      const oldDate = new Date(Date.now() - 2 * DAY_MS);
      fs.utimesSync(stampFile, oldDate, oldDate);
      maybeCheckDailyUpdateInBackground({ home: tmp, cliPath: CLI });
      assert.equal(fs.statSync(stampFile).mtimeMs, oldDate.getTime());
    } finally {
      if (oldEnv === undefined) delete process.env.THINKER_NO_AUTO_UPDATE;
      else process.env.THINKER_NO_AUTO_UPDATE = oldEnv;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpdate updates git installation when clean', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-git-update-'));
  try {
    const bareDir = path.join(tmp, 'remote.git');
    const localDir = path.join(tmp, 'local');
    execFileSync('git', ['init', '--bare', '-q', bareDir]);

    // Setup working checkout to push initial commit
    const seedDir = path.join(tmp, 'seed');
    execFileSync('git', ['clone', '-q', bareDir, seedDir]);
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.1.0' }));
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedDir });
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: seedDir });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seedDir });

    // Clone into local
    execFileSync('git', ['clone', '-q', '-b', 'main', bareDir, localDir]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: localDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: localDir });

    const install = detectInstall(localDir, tmp);
    assert.equal(install.type, 'git');

    // Push new commit from seed
    fs.writeFileSync(path.join(seedDir, 'file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'v2'], { cwd: seedDir });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seedDir });

    // Apply update on local
    const res = await applyUpdate({ home: tmp, rootDir: localDir, install, quiet: true });
    assert.equal(res.type, 'git');
    assert.equal(res.updated, true);
    assert.ok(fs.existsSync(path.join(localDir, 'file.txt')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli update --status and --check run cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-cli-'));
  try {
    const out = execFileSync('node', [CLI, 'update', '--status'], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmp },
    });
    assert.ok(out.includes('Thinker installation:'));
    assert.ok(out.includes('Auto-updates:'));

    const checkOut = execFileSync('node', [CLI, 'update', '--check'], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmp },
    });
    assert.ok(checkOut.includes('thinker is already up to date') || checkOut.includes('Update available'));

    // upgrade alias
    const upgradeOut = execFileSync('node', [CLI, 'upgrade', '--status'], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmp },
    });
    assert.ok(upgradeOut.includes('Thinker installation:'));

    // branch command
    const branchOut = execFileSync('node', [CLI, 'branch'], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmp },
    });
    assert.ok(branchOut.includes('On branch') || branchOut.includes('On ref'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpdate can switch between git branches', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-branch-'));
  try {
    const bareDir = path.join(tmp, 'remote.git');
    const localDir = path.join(tmp, 'local');
    execFileSync('git', ['init', '--bare', '-q', bareDir]);

    // Setup working checkout to push initial commit to main
    const seedDir = path.join(tmp, 'seed');
    execFileSync('git', ['clone', '-q', bareDir, seedDir]);
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.1.0' }));
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedDir });
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: seedDir });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seedDir });

    // Push a feature branch
    execFileSync('git', ['checkout', '-b', 'feature-exp'], { cwd: seedDir });
    fs.writeFileSync(path.join(seedDir, 'exp.txt'), 'experimental feature');
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'add exp'], { cwd: seedDir });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:feature-exp'], { cwd: seedDir });

    // Clone main into local
    execFileSync('git', ['clone', '-q', '-b', 'main', bareDir, localDir]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: localDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: localDir });

    const install = detectInstall(localDir, tmp);
    assert.equal(install.branch, 'main');
    assert.ok(!fs.existsSync(path.join(localDir, 'exp.txt')));

    // Switch to feature-exp via applyUpdate
    const res = await applyUpdate({ home: tmp, rootDir: localDir, install, ref: 'feature-exp', quiet: true });
    assert.equal(res.updated, true);
    assert.equal(res.branch, 'feature-exp');
    assert.ok(fs.existsSync(path.join(localDir, 'exp.txt')));

    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: localDir, encoding: 'utf8' }).trim();
    assert.equal(currentBranch, 'feature-exp');

    // Switch back to main via applyUpdate
    const installExp = detectInstall(localDir, tmp);
    const resMain = await applyUpdate({ home: tmp, rootDir: localDir, install: installExp, ref: 'main', quiet: true });
    assert.equal(resMain.updated, true);
    assert.equal(resMain.branch, 'main');
    assert.ok(!fs.existsSync(path.join(localDir, 'exp.txt')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scheduleDaily and unscheduleDaily manage plist file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-sched-'));
  try {
    const plistPath = path.join(tmp, 'test.plist');
    const binPath = path.join(tmp, 'bin', 'thinker');

    assert.equal(isScheduled(tmp, { plistPath }), false);

    const sched = scheduleDaily({ home: tmp, binPath, plistPath, skipLaunchctl: true });
    assert.ok(fs.existsSync(plistPath));
    const content = fs.readFileSync(plistPath, 'utf8');
    assert.ok(content.includes('com.thinker.update'));
    assert.ok(content.includes(binPath));

    const unsched = unscheduleDaily({ home: tmp, plistPath, skipLaunchctl: true });
    assert.equal(unsched.unscheduled, true);
    assert.ok(!fs.existsSync(plistPath));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpdate unpacks tarball archive for standalone install', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-archive-'));
  try {
    // 1. Prepare dummy package tarball
    const pkgSrc = path.join(tmp, 'pkg-src');
    fs.mkdirSync(path.join(pkgSrc, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgSrc, 'src', 'cli.js'), '#!/usr/bin/env node\nconsole.log("v2");');
    fs.writeFileSync(path.join(pkgSrc, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.2.0' }));
    const tarball = path.join(tmp, 'dist.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', tmp, 'pkg-src']);

    // 2. Set up initial install in tmp
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'src', 'cli.js'), '#!/usr/bin/env node\nconsole.log("v1");');
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.1.0' }));
    fs.writeFileSync(path.join(tmp, 'install.json'), JSON.stringify({
      source: 'archive',
      ghrepo: 'yoavshmariahu/thinker',
      ref: 'main',
      commit: 'old-commit',
      version: '0.1.0',
    }));

    const install = detectInstall(appDir, tmp);
    assert.equal(install.type, 'archive');

    // 3. Update using dist tarball
    const res = await applyUpdate({
      home: tmp,
      rootDir: appDir,
      install,
      dist: `file://${tarball}`,
      quiet: true,
    });

    assert.equal(res.type, 'archive');
    assert.equal(res.updated, true);
    assert.equal(res.version, '0.2.0');

    // Confirm app content and receipt were updated
    const updatedPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'app', 'package.json'), 'utf8'));
    assert.equal(updatedPkg.version, '0.2.0');

    const updatedInstall = JSON.parse(fs.readFileSync(path.join(tmp, 'install.json'), 'utf8'));
    assert.equal(updatedInstall.version, '0.2.0');

    const shim = fs.readFileSync(path.join(tmp, 'bin', 'thinker'), 'utf8');
    assert.ok(shim.includes('app/src/cli.js'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
