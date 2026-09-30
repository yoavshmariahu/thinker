// Self-update and daily automatic updates for thinker CLI.
// Supports both archive installations (~/.thinker/app) and git checkouts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DAY_MS = 24 * 60 * 60 * 1000;

export function thinkerHome() {
  return process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
}

export function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (out) return out;
  } catch {}
  return '';
}

let _tarSupportsWarning = null;
let _tarSupportsNoXattrs = null;

export function tarSupportsFlag(flag) {
  if (flag === '--warning') {
    if (_tarSupportsWarning !== null) return _tarSupportsWarning;
    try {
      execFileSync('tar', ['--warning=no-unknown-keyword', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
      _tarSupportsWarning = true;
    } catch {
      _tarSupportsWarning = false;
    }
    return _tarSupportsWarning;
  }
  if (flag === '--no-xattrs') {
    if (_tarSupportsNoXattrs !== null) return _tarSupportsNoXattrs;
    try {
      execFileSync('tar', ['--no-xattrs', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
      _tarSupportsNoXattrs = true;
    } catch {
      _tarSupportsNoXattrs = false;
    }
    return _tarSupportsNoXattrs;
  }
  return false;
}

export function tarExtractArgs() {
  return tarSupportsFlag('--warning') ? ['--warning=no-unknown-keyword', '-xzf'] : ['-xzf'];
}

export function tarListArgs() {
  return tarSupportsFlag('--warning') ? ['--warning=no-unknown-keyword', '-tzf'] : ['-tzf'];
}

export function tarPackArgs() {
  return tarSupportsFlag('--no-xattrs') ? ['--no-xattrs', '-czf'] : ['-czf'];
}

export function detectInstall(rootDir = path.resolve(HERE, '..'), home = thinkerHome()) {
  const isGit = fs.existsSync(path.join(rootDir, '.git'));
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {}

  const installJsonPath = path.join(home, 'install.json');
  let installJson = {};
  try {
    installJson = JSON.parse(fs.readFileSync(installJsonPath, 'utf8'));
  } catch {}

  const binPath = path.join(home, 'bin', 'thinker');
  let currentCommit = installJson.commit || '';

  if (isGit) {
    try {
      currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
    } catch {}
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
    } catch {}
    return {
      type: 'git',
      path: rootDir,
      binPath,
      version,
      commit: currentCommit,
      branch,
      installJson,
    };
  }

  return {
    type: 'archive',
    path: rootDir,
    binPath,
    version,
    commit: currentCommit,
    ghrepo: installJson.ghrepo || process.env.THINKER_GH_REPO || 'yoavshmariahu/thinker',
    ref: installJson.ref || process.env.THINKER_REF || 'main',
    dist: installJson.dist || process.env.THINKER_DIST_URL || '',
    installJson,
  };
}

export async function fetchLatestCommit({ ghrepo = 'yoavshmariahu/thinker', ref = 'main', token } = {}) {
  token = token || getToken();
  const url = `https://api.github.com/repos/${ghrepo}/commits/${ref}`;
  const headers = {
    'User-Agent': 'thinker-cli',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      if (!token) {
        throw new Error(`GitHub API request failed (${res.status}): repository may be private. Export GITHUB_TOKEN or login with \`gh auth login\`.`);
      }
    }
    throw new Error(`GitHub API request failed with HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  return {
    sha: data.sha,
    message: data.commit?.message ? data.commit.message.split('\n')[0] : '',
    date: data.commit?.committer?.date || data.commit?.author?.date || '',
  };
}

export async function fetchDistributionRelease(dist) {
  const url = new URL('version.json', dist);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Distribution update check failed: HTTP ${res.status}`);
  const release = await res.json();
  if (typeof release.version !== 'string' || !release.version ||
      typeof release.commit !== 'string' || !release.commit ||
      (release.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(release.sha256))) {
    throw new Error('Invalid distribution version.json');
  }
  return release;
}

export async function checkUpdate(opts = {}) {
  const home = opts.home || thinkerHome();
  const install = opts.install || detectInstall(opts.rootDir || path.resolve(HERE, '..'), home);

  if (install.type === 'git') {
    const rootDir = install.path;
    let isDirty = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: rootDir, encoding: 'utf8' }).trim();
      isDirty = status.length > 0;
    } catch {}

    const targetBranch = opts.ref || opts.branch || install.branch || 'main';
    const switchingBranch = targetBranch !== install.branch;
    try {
      execFileSync('git', ['fetch', '--quiet', 'origin', targetBranch], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    } catch {
      try {
        execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
      } catch (e) {
        return {
          type: 'git',
          error: `Failed to fetch remote git changes: ${e.message}`,
          currentCommit: install.commit,
          version: install.version,
          branch: targetBranch,
          isDirty,
        };
      }
    }

    let remoteCommit = '';
    if (opts.ref || opts.branch) {
      try {
        remoteCommit = execFileSync('git', ['rev-parse', `origin/${targetBranch}`], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        try {
          remoteCommit = execFileSync('git', ['rev-parse', targetBranch], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {}
      }
    } else {
      try {
        remoteCommit = execFileSync('git', ['rev-parse', '@{u}'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        try {
          remoteCommit = execFileSync('git', ['rev-parse', `origin/${targetBranch}`], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          try {
            remoteCommit = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          } catch {}
        }
      }
    }

    const available = switchingBranch || !!(remoteCommit && remoteCommit !== install.commit);
    return {
      type: 'git',
      available,
      switchingBranch,
      currentBranch: install.branch,
      targetBranch,
      currentCommit: install.commit,
      latestCommit: remoteCommit || install.commit,
      version: install.version,
      branch: targetBranch,
      isDirty,
    };
  }

  // Archive install
  const ghrepo = opts.ghrepo || install.ghrepo || 'yoavshmariahu/thinker';
  const ref = opts.ref || opts.branch || install.ref || 'main';
  const switchingRef = ref !== (install.ref || 'main');
  const dist = opts.dist || install.dist;
  if (dist) {
    const latest = await fetchDistributionRelease(dist);
    return {
      type: 'archive', available: install.version !== latest.version || install.commit !== latest.commit,
      currentCommit: install.commit, latestCommit: latest.commit,
      version: install.version, latestVersion: latest.version, ghrepo, ref,
      currentRef: install.ref || 'main', targetRef: ref, switchingRef,
    };
  }
  const token = opts.token || getToken();

  const latest = await fetchLatestCommit({ ghrepo, ref, token });
  const available = switchingRef || !install.commit || (latest.sha && latest.sha !== install.commit);

  return {
    type: 'archive',
    available,
    switchingRef,
    currentRef: install.ref || 'main',
    targetRef: ref,
    currentCommit: install.commit,
    latestCommit: latest.sha,
    commitMessage: latest.message,
    version: install.version,
    ghrepo,
    ref,
  };
}

export async function applyUpdate(opts = {}) {
  const home = opts.home || thinkerHome();
  const rootDir = opts.rootDir || path.resolve(HERE, '..');
  const install = opts.install || detectInstall(rootDir, home);
  const quiet = !!opts.quiet;
  const force = !!opts.force;
  const ghrepo = opts.ghrepo || install.ghrepo || 'yoavshmariahu/thinker';
  const ref = opts.ref || opts.branch || install.ref || 'main';
  const dist = opts.dist || install.dist || '';
  const token = opts.token || (dist ? '' : getToken());

  if (install.type === 'git') {
    const gitDir = install.path;
    const status = execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: gitDir, encoding: 'utf8' }).trim();
    if (status && !force) {
      throw new Error(`Git working tree at ${gitDir} has uncommitted changes. Stash or commit them before updating, or pass --force.`);
    }

    const targetBranch = opts.ref || opts.branch || install.branch || 'main';
    const switchingBranch = targetBranch !== install.branch;

    try {
      execFileSync('git', ['fetch', 'origin', targetBranch], { cwd: gitDir, encoding: 'utf8', timeout: 30_000 });
    } catch {
      try {
        execFileSync('git', ['fetch', 'origin'], { cwd: gitDir, encoding: 'utf8', timeout: 30_000 });
      } catch {}
    }

    const oldCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitDir, encoding: 'utf8' }).trim();

    if (switchingBranch) {
      const localExists = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${targetBranch}`], { cwd: gitDir }).status === 0;
      if (localExists) {
        execFileSync('git', ['checkout', targetBranch], { cwd: gitDir, encoding: 'utf8' });
        try {
          execFileSync('git', ['pull', '--ff-only', 'origin', targetBranch], { cwd: gitDir, encoding: 'utf8' });
        } catch {}
      } else {
        try {
          execFileSync('git', ['checkout', '-b', targetBranch, '--track', `origin/${targetBranch}`], { cwd: gitDir, encoding: 'utf8' });
        } catch {
          execFileSync('git', ['checkout', '-b', targetBranch], { cwd: gitDir, encoding: 'utf8' });
        }
      }
    } else {
      if (force && status) {
        execFileSync('git', ['reset', '--hard', `origin/${targetBranch}`], { cwd: gitDir, encoding: 'utf8' });
      } else {
        execFileSync('git', ['pull', '--ff-only', 'origin', targetBranch], { cwd: gitDir, encoding: 'utf8' });
      }
    }

    const newCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitDir, encoding: 'utf8' }).trim();

    // Check package.json dependencies update
    try {
      execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: gitDir, encoding: 'utf8', timeout: 60_000 });
    } catch {}

    return {
      type: 'git',
      updated: oldCommit !== newCommit || switchingBranch || force,
      from: oldCommit,
      to: newCommit,
      version: install.version,
      branch: targetBranch,
    };
  }

  // Archive / production install (~/.thinker/app)
  const appDir = path.join(home, 'app');
  const binDir = path.join(home, 'bin');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-update-'));
  const tmpTar = path.join(tmpBase, 'thinker.tgz');
  const tmpApp = path.join(tmpBase, 'app');

  try {
    let latestCommit = '';
    const release = /^https?:\/\//.test(dist) ? await fetchDistributionRelease(dist) : null;
    if (release) latestCommit = release.commit;
    if (!dist) {
      try {
        const info = await fetchLatestCommit({ ghrepo, ref, token });
        latestCommit = info.sha;
      } catch {}
    }

    // Download archive
    if (dist) {
      if (dist.startsWith('file://')) {
        const filePath = fileURLToPath(dist);
        fs.copyFileSync(filePath, tmpTar);
      } else if (fs.existsSync(dist)) {
        fs.copyFileSync(dist, tmpTar);
      } else {
        const res = await fetch(dist, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`Failed to download distribution from ${dist}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(tmpTar, buf);
      }
    } else {
      const url = `https://api.github.com/repos/${ghrepo}/tarball/${ref}`;
      const headers = { 'User-Agent': 'thinker-cli', 'Accept': 'application/vnd.github.raw' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Failed to download tarball from GitHub: HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpTar, buf);
    }

    if (release?.sha256 && createHash('sha256').update(fs.readFileSync(tmpTar)).digest('hex') !== release.sha256) {
      throw new Error('Distribution checksum mismatch; update was not installed. Try again after the release finishes publishing.');
    }
    fs.mkdirSync(tmpApp, { recursive: true });
    try {
      execFileSync('tar', [...tarExtractArgs(), tmpTar, '-C', tmpApp], {
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' },
      });
    } catch (err) {
      const errDetail = err.stderr ? err.stderr.toString().trim() : '';
      throw new Error(`Failed to extract archive: ${errDetail || err.message}`);
    }

    let sourceDir = tmpApp;
    if (!fs.existsSync(path.join(sourceDir, 'src', 'cli.js'))) {
      const entries = fs.readdirSync(tmpApp).map(f => path.join(tmpApp, f)).filter(p => fs.statSync(p).isDirectory());
      if (entries.length && fs.existsSync(path.join(entries[0], 'src', 'cli.js'))) {
        sourceDir = entries[0];
      } else {
        throw new Error('Downloaded archive does not have valid thinker structure');
      }
    }

    // Strip unneeded runtime folders
    for (const d of ['bench', 'test', 'caches']) {
      try { fs.rmSync(path.join(sourceDir, d), { recursive: true, force: true }); } catch {}
    }

    // Install production dependencies
    try {
      execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: sourceDir, encoding: 'utf8', timeout: 60_000 });
    } catch {}

    let newVersion = install.version;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
      if (pkg.version) newVersion = pkg.version;
    } catch {}

    if (release && newVersion !== release.version) {
      throw new Error('Distribution version does not match version.json; update was not installed');
    }
    // Atomic directory replacement
    const appOld = path.join(home, 'app.old');
    const appNew = path.join(home, 'app.new');
    try { fs.rmSync(appOld, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(appNew, { recursive: true, force: true }); } catch {}

    fs.renameSync(sourceDir, appNew);
    if (fs.existsSync(appDir)) {
      fs.renameSync(appDir, appOld);
    }
    fs.renameSync(appNew, appDir);
    try { fs.rmSync(appOld, { recursive: true, force: true }); } catch {}

    // Ensure executable shim
    fs.mkdirSync(binDir, { recursive: true });
    const shimPath = path.join(binDir, 'thinker');
    const shimContent = `#!/bin/sh\nexec node "${path.join(appDir, 'src', 'cli.js')}" "$@"\n`;
    fs.writeFileSync(shimPath, shimContent);
    fs.chmodSync(shimPath, 0o755);

    // Save install receipt
    const fromCommit = install.commit || 'unknown';
    const toCommit = latestCommit || 'latest';
    const installJson = {
      ...install.installJson,
      source: 'archive',
      ghrepo,
      ref,
      dist,
      commit: toCommit,
      version: newVersion,
      updatedAt: new Date().toISOString(),
      installedAt: install.installJson?.installedAt || new Date().toISOString(),
    };
    fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify(installJson, null, 2) + '\n');

    return {
      type: 'archive',
      updated: true,
      from: fromCommit,
      to: toCommit,
      version: newVersion,
    };
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }
}

// OS background auto-update scheduler (LaunchAgent on macOS, cron on Linux)
export function getLaunchAgentPath(customPath) {
  return customPath || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.thinker.update.plist');
}

export function isScheduled(home = thinkerHome(), opts = {}) {
  if (process.platform === 'darwin') {
    const plist = opts.plistPath || getLaunchAgentPath();
    if (!fs.existsSync(plist)) return false;
    try {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.includes('com.thinker.update');
    } catch {
      return fs.existsSync(plist);
    }
  } else if (process.platform === 'linux') {
    try {
      const crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return crontab.includes('thinker') && crontab.includes('update');
    } catch {
      return false;
    }
  }
  return false;
}

export function scheduleDaily(opts = {}) {
  const home = opts.home || thinkerHome();
  const binPath = opts.binPath || path.join(home, 'bin', 'thinker');
  const nodeBinDir = path.dirname(process.execPath);

  if (process.platform === 'darwin') {
    const plistPath = opts.plistPath || getLaunchAgentPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });

    if (!opts.skipLaunchctl) {
      try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
    }

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thinker.update</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>PATH="${nodeBinDir}:$PATH:/usr/local/bin:/opt/homebrew/bin" exec "${binPath}" update --quiet</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardErrorPath</key>
    <string>${path.join(home, 'update.err')}</string>
    <key>StandardOutPath</key>
    <string>${path.join(home, 'update.out')}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent);

    if (!opts.skipLaunchctl) {
      try {
        const uid = process.getuid ? process.getuid() : 501;
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
      } catch {
        try {
          execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
        } catch (e) {
          throw new Error(`Failed to register LaunchAgent: ${e.message}`);
        }
      }
    }
    return { type: 'launchd', path: plistPath };
  } else if (process.platform === 'linux') {
    let crontab = '';
    try {
      crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}

    const line = `0 3 * * * PATH="${nodeBinDir}:$PATH:/usr/local/bin" "${binPath}" update --quiet`;
    if (!crontab.includes(line)) {
      const newCrontab = (crontab.trim() ? crontab.trim() + '\n' : '') + line + '\n';
      execFileSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    }
    return { type: 'cron', line };
  }

  throw new Error(`OS scheduler not supported on platform: ${process.platform}`);
}

export function unscheduleDaily(opts = {}) {
  const home = opts.home || thinkerHome();

  if (process.platform === 'darwin') {
    const plistPath = opts.plistPath || getLaunchAgentPath();
    if (fs.existsSync(plistPath)) {
      if (!opts.skipLaunchctl) {
        try {
          const uid = process.getuid ? process.getuid() : 501;
          execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        } catch {
          try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
        }
      }
      try { fs.rmSync(plistPath, { force: true }); } catch {}
      return { unscheduled: true, type: 'launchd' };
    }
    return { unscheduled: false, type: 'launchd' };
  } else if (process.platform === 'linux') {
    try {
      const crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const filtered = crontab.split('\n').filter(l => !(l.includes('thinker') && l.includes('update'))).join('\n').trim();
      if (filtered) {
        execFileSync('crontab', ['-'], { input: filtered + '\n', encoding: 'utf8' });
      } else {
        execFileSync('crontab', ['-r'], { stdio: 'ignore' });
      }
      return { unscheduled: true, type: 'cron' };
    } catch {
      return { unscheduled: false, type: 'cron' };
    }
  }

  return { unscheduled: false };
}

// Invocations check daily update in background (non-blocking)
export function maybeCheckDailyUpdateInBackground({ home = thinkerHome(), cliPath = path.join(HERE, 'cli.js'), force = false } = {}) {
  if (!force) {
    if (process.env.THINKER_NO_AUTO_UPDATE === '1' || process.env.THINKER_NO_UPDATE === '1') return;
    if (process.env.THINKER_IN_LLM) return;
    if (process.env.THINKER_BACKGROUND_UPDATE) return;
  }

  const stateDir = path.join(home, 'state');
  const stampFile = path.join(stateDir, 'update.last');

  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      if (Date.now() - st.mtimeMs < DAY_MS) return;
    } catch {}
  }

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stampFile, new Date().toISOString());
  } catch {
    return;
  }

  try {
    const child = spawn(process.execPath, [cliPath, 'update', '--background', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, THINKER_BACKGROUND_UPDATE: '1' },
    });
    child.unref();
  } catch {}
}

export function checkPendingNotice(home = thinkerHome()) {
  const noticeFile = path.join(home, 'state', 'update-notice.json');
  try {
    if (fs.existsSync(noticeFile)) {
      const data = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
      fs.rmSync(noticeFile, { force: true });
      if (data.to) {
        return `auto-updated to ${data.to.slice(0, 7)}${data.version ? ` (v${data.version})` : ''}`;
      }
    }
  } catch {}
  return null;
}
