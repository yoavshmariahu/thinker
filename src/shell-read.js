// What a shell line reads, when its work is to print a file. One reading, shared by the delegation trigger
// (delegate.js), the re-read measure (rereads.js) and the keep rule (keep.js); it lives apart from all three
// because it needs nothing of theirs, and the keep rule is read by the proxy that delegate.js itself imports.
const SHRINKS = /\|\s*(grep|rg|head|tail|wc|awk|cut|sort|uniq|jq|python|node)\b/;
const READ_CMD = /^\s*(?:cat|less|more|sed\s+-n\s+('[^']*'|"[^"]*"|\S+)|head\s+-n?\s*(\d+)|head\s+-c\s*\d+)\s+(.+?)\s*$/;
// The lines a `sed -n` script prints, or 0 where that cannot be read off it (an open range, a pattern, several ranges).
function sedLines(script) {
  const a = String(script || '').replace(/^["']|["']$/g, '');
  let m = a.match(/^(\d+),(\d+)p$/); if (m) return Math.max(1, Number(m[2]) - Number(m[1]) + 1);
  m = a.match(/^(\d+)p$/); if (m) return 1;
  m = a.match(/^(\d+),\+(\d+)p$/); if (m) return Number(m[2]) + 1;
  return 0;
}
function splitArgs(s) { return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^["']|["']$/g, '')); }
// A shell line whose work is to print a file: the files it names (as written) and the line count a `head -n` caps it at,
// or null. The one reading of a shell read, shared with the re-read measure (rereads.js), which replays it over a
// transcript where the files no longer need to exist.
export function shellRead(command) {
  const cmd = String(command || '');
  if (SHRINKS.test(cmd) || /[;&]|\|\|/.test(cmd.replace(/\|\|/g, ';'))) return null;
  const m = cmd.match(READ_CMD);
  if (!m) return null;
  const files = splitArgs(m[3]).filter(a => !a.startsWith('-'));
  return files.length ? { files, lines: m[2] ? Number(m[2]) : sedLines(m[1]) } : null;
}
