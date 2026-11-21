// Where a Claude Code context starts again. One function, in a module of its own because the two readers of it
// are the prompt hook (profile.js: the block goes in again after a compaction) and the PreToolUse hook
// (delegate.js: a compaction takes every earlier tool result out of the context, so nothing may be pointed at
// a copy from before one), and neither may pull the other's module graph into its startup.
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Compaction boundaries written to a Claude Code transcript since `offset` bytes, and the file's size now.
export function compactionsSince(file, offset = 0) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { count: 0, offset: size };
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); return { count: (buf.toString('utf8').match(/"subtype":"compact_boundary"/g) || []).length, offset: size }; }
    finally { fs.closeSync(fd); }
  } catch { return { count: 0, offset }; }
}
