#!/usr/bin/env python3
"""Generate a multi-turn read workload: N turns, each reading `per` files and running `echoes` shell calls.

The deep path of the clearing policy can only be reached over several turns: `clearable` counts what sits
before the current turn, so a one-prompt session has nothing there and the ask never grows (README).

Usage: gen-turns.py <dir> [turns] [files per turn] [chars per file] [echoes per turn]
"""
import os, random, sys
out = sys.argv[1] if len(sys.argv) > 1 else "turns"
turns = int(sys.argv[2]) if len(sys.argv) > 2 else 9
per = int(sys.argv[3]) if len(sys.argv) > 3 else 2
chars = int(sys.argv[4]) if len(sys.argv) > 4 else 34000
echoes = int(sys.argv[5]) if len(sys.argv) > 5 else 3
work = os.path.join(out, "work")
os.makedirs(work, exist_ok=True)
words = [f"tok{i:04d}" for i in range(400)]
n = turns * per
for i in range(n):
    r = random.Random(1000 + i)
    body = []
    while sum(len(x) for x in body) < chars:
        body.append(" ".join(r.choice(words) for _ in range(12)))
    open(f"{work}/part-{i:02d}.txt", "w").write(
        f"FILE part-{i:02d}\nSUMMARY: section {i} covers {r.choice(words)} and {r.choice(words)}\n" + "\n".join(body))
for t in range(turns):
    files = [os.path.abspath(f"{work}/part-{t * per + j:02d}.txt") for j in range(per)]
    lines = [f"Turn {t + 1} of {turns}. Do exactly this, in order, and nothing else.", ""]
    for f in files:
        lines.append(f"1. Read the file {f} with the Read tool (the whole file, no range) and quote its SUMMARY line.")
    for e in range(echoes):
        lines.append(f"2. Run the Bash command: echo turn{t + 1}-step{e + 1}")
    lines.append("")
    lines.append("Then reply with one line: the SUMMARY lines you quoted. Do not read any other file.")
    open(f"{out}/turn-{t:02d}.txt", "w").write("\n".join(lines))
size = sum(os.path.getsize(f"{work}/{f}") for f in os.listdir(work))
print(f"{turns} turns x ({per} reads + {echoes} echoes), {n} files, {size} chars in {work}/")
