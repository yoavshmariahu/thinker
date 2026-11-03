#!/usr/bin/env python3
"""A realistic multi-turn workload: real source files, read over enough turns that the SHIPPED
trigger (140k) binds on its own.

Why not synthetic files: `gen-work.py` writes random "tok0123" words, which tokenize at about 2
chars a token against 3.5-4 for code, so every token figure in the run is off by nearly 2x and the
trigger is reached by half the text it would take in a real session.

Why not a lower trigger: a smaller trigger measures a policy nobody runs. To reach 140k of results
the workload has to carry ~500k chars of reads before the first clear, which is what this sizes.

Usage: gen-real.py <dir> <repo> [turns] [chars per turn]
"""
import os, subprocess, sys
out, repo = sys.argv[1], os.path.abspath(sys.argv[2])
turns = int(sys.argv[3]) if len(sys.argv) > 3 else 14
per_turn = int(sys.argv[4]) if len(sys.argv) > 4 else 100000
os.makedirs(out, exist_ok=True)
# the repository's own files, biggest first, deterministic: real code, real sizes, nothing generated
names = subprocess.run(['git', '-C', repo, 'ls-files', 'src', 'test'], capture_output=True, text=True).stdout.split()
files = sorted(((os.path.getsize(os.path.join(repo, n)), n) for n in names
                if n.endswith(('.js', '.html')) and os.path.isfile(os.path.join(repo, n))), reverse=True)
picked, used, i = [], 0, 0
for t in range(turns):
    group, size = [], 0
    while size < per_turn and i < len(files):
        s, n = files[i]; i += 1
        if s < 4000: continue
        group.append((s, n)); size += s
    if not group: break
    picked.append(group); used += size
for t, group in enumerate(picked):
    lines = [f"Turn {t + 1} of {len(picked)}. Do exactly these steps, in order, and nothing else. Do not explore.", ""]
    for _, n in group:
        lines.append(f"- Read {os.path.join(repo, n)} with the Read tool, the whole file, no range or limit. "
                     f"Report its last line number.")
    lines.append(f"- Run: grep -c 'export' {os.path.join(repo, group[0][1])}")
    for e in range(2):
        lines.append(f"- Run: echo turn{t + 1}-step{e + 1}")
    lines.append("")
    lines.append("Then reply with one line only: the line counts you found, comma separated. "
                 "Do not read, search or open anything that is not listed above.")
    open(f"{out}/turn-{t:02d}.txt", "w").write("\n".join(lines))
print(f"{len(picked)} turns, {sum(len(g) for g in picked)} real files, {used:,} chars of reads "
      f"(~{used // 4:,} tokens at 4 chars/token; the 140k trigger should bind around turn "
      f"{next((t + 1 for t in range(len(picked)) if sum(s for g in picked[:t + 1] for s, _ in g) // 4 > 140000), '?')})")
