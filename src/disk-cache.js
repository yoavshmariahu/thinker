// Small results kept on this machine between processes, by a key that names everything the result
// depends on. Every hook and command is a new process, and what it works out about a file's text or
// a commit's content (a file's definitions, a symbol's hash at a commit) is the same next time: an
// entry is one JSON file under ~/.thinker/cache/<name>/v<version>/, written whole and renamed into
// place, so concurrent sessions never read half of one. Nothing here is the record of anything: a
// missing, unreadable or pruned entry is worked out again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_AGE_MS = 45 * 24 * 3600_000;
let override; // undefined: the default place

// A directory for every cache, or null for none (tests name their own).
export function setDiskCache(dir) { override = dir; }
function root() {
  if (override !== undefined) return override;
  // the suite must not write under the developer's home unless it names a THINKER_HOME of its own
  if (process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME) return null;
  return path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'cache');
}

export const cacheKey = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);

// name: what is cached; version: bumped when the shape or meaning of its values changes.
export function diskCache(name, version) {
  const dir = () => { const r = root(); return r && path.join(r, name, `v${version}`); };
  const file = (d, key) => path.join(d, key.slice(0, 2), `${key}.json`);
  return {
    get(key) {
      const d = dir(); if (!d) return undefined;
      try { return JSON.parse(fs.readFileSync(file(d, key), 'utf8')); } catch { return undefined; }
    },
    set(key, value) {
      const d = dir(); if (!d) return;
      try {
        const f = file(d, key); fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, f);
        if (Math.random() < 0.01) this.prune();
      } catch {}
    },
    // Entries nothing has written for a while, and those of earlier versions.
    prune(now = Date.now()) {
      const r = root(); let removed = 0; if (!r) return removed;
      try {
        for (const v of fs.readdirSync(path.join(r, name))) {
          const vd = path.join(r, name, v);
          if (v !== `v${version}`) { fs.rmSync(vd, { recursive: true, force: true }); removed++; continue; }
          for (const shard of fs.readdirSync(vd)) for (const f of fs.readdirSync(path.join(vd, shard))) {
            const p = path.join(vd, shard, f);
            try { if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) { fs.rmSync(p, { force: true }); removed++; } } catch {}
          }
        }
      } catch {}
      return removed;
    },
  };
}
