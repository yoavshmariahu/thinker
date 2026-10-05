function hunks(diff) {
  const out = []; let file = null;
  for (const l of diff.split('\n')) {
    const f = l.match(/^\+\+\+ b\/(.+)$/); if (f) { file = f[1]; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/); if (h && file) out.push({ file, start: Number(h[1]), len: Number(h[2] ?? 1) });
  }
  return out;
}
function contextFrom(read, diff, pad = 80, cap = 80000) {
  const by = {}; for (const h of hunks(diff)) (by[h.file] ||= []).push([Math.max(1, h.start - pad), h.start + h.len + pad]);
  let text = '';
  for (const [file, ranges] of Object.entries(by)) {
    const src = read(file); if (src == null) continue;
    const lines = src.split('\n');
    if (lines.length <= 300) {
      text += `\n--- ${file} (full file, ${lines.length} lines after patch) ---\n${src}\n`;
      if (text.length > cap) return text.slice(0, cap);
      continue;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = []; for (const r of ranges) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 5) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
    for (const [a, b] of merged) { text += `\n--- ${file} lines ${a}-${Math.min(b, lines.length)} (after patch) ---\n${lines.slice(a - 1, b).join('\n')}\n`; if (text.length > cap) return text.slice(0, cap); }
  }
  return text;
}

export { contextFrom };
