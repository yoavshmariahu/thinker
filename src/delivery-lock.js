import fs from 'node:fs';
import path from 'node:path';

// Recover only a dead owner's lock. A live run is never evicted because GitHub is slow.
export async function withCommentLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const before = fs.statSync(file), pid = Number(fs.readFileSync(file, 'utf8'));
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
    } else dead = Date.now() - before.mtimeMs > 5 * 60_000;
    if (!dead) return { skipped: 'locked' };
    // Another contender may already have replaced the stale lock.
    if (fs.statSync(file).ino !== before.ino) return { skipped: 'locked' };
    fs.unlinkSync(file);
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') return { skipped: 'locked' }; throw err; }
  }
  try { fs.writeFileSync(fd, String(process.pid)); return await fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}

