#!/usr/bin/env python3
"""Generate the deterministic read workload: N files of ~equal size, seeded, with a SUMMARY: line each."""
import os, random, sys
out = sys.argv[1] if len(sys.argv) > 1 else "work"
n = int(sys.argv[2]) if len(sys.argv) > 2 else 18
chars = int(sys.argv[3]) if len(sys.argv) > 3 else 34000
os.makedirs(out, exist_ok=True)
words = [f"tok{i:04d}" for i in range(400)]
for i in range(n):
    r = random.Random(1000 + i)
    body = []
    while sum(len(x) for x in body) < chars:
        body.append(" ".join(r.choice(words) for _ in range(12)))
    open(f"{out}/part-{i:02d}.txt", "w").write(
        f"FILE part-{i:02d}\nSUMMARY: section {i} covers {r.choice(words)} and {r.choice(words)}\n" + "\n".join(body))
print(f"{n} files in {out}/, {sum(os.path.getsize(f'{out}/{f}') for f in os.listdir(out))} chars")
