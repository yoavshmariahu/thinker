#!/usr/bin/env python3
"""Pair two arms' proxy logs and price them. Usage: analyse.py <clearing.jsonl> <control.jsonl> [label]"""
import json, sys
# list prices per million, Opus 5.5; a 1h cache write is 2x input, a read 2.5% of it
IN, OUT_, READ, W1H, W5M = 4.0, 20.0, 0.2, 8.0, 5.0
def isrw(r):
    w, rd, i = r.get('write', 0), r.get('read', 0), r.get('input', 0)
    return w > 0.5 * (w + rd + i) and (w + rd) > 20000
def arm(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    pr = [r for r in rows if r.get('op') == 'proxy']
    t = lambda k: sum(r.get(k, 0) for r in pr)
    cost = lambda wr: (t('input') * IN + t('read') * READ + t('write') * wr + t('out') * OUT_) / 1e6
    return dict(calls=len(pr), input=t('input'), read=t('read'), write=t('write'), out=t('out'),
                cleared=t('cleared'), clears=sum(1 for r in pr if r.get('cleared')),
                rewrites=sum(1 for r in pr if r.get('cleared') and isrw(r)),
                cost1h=cost(W1H), cost5m=cost(W5M),
                # the policy's own events (op names of #600 on; the old deep-* names are gone)
                moved=sum(1 for r in rows if r.get('op') == 'proxy-clear-moved'),
                unmet=sum(1 for r in rows if r.get('op') == 'proxy-clear-unmet'),
                stopped=sum(1 for r in rows if r.get('op') == 'proxy-clearing-stopped'),
                # the decisions at turn boundaries: asks the price took, and asks it refused (`held`, #604)
                boundaries=sum(1 for r in pr if r.get('turn') is not None),
                deepened=sum(1 for r in pr if r.get('clear')),
                refused=sum(1 for r in pr if r.get('held')),
                asks=len({r.get('asked') for r in pr if r.get('asked')}))
a, b = arm(sys.argv[1]), arm(sys.argv[2])
print(f"{sys.argv[3] if len(sys.argv) > 3 else 'paired'}: clearing vs control")
for k in a: print(f"  {k:9} {a[k]:>14,.2f} {b[k]:>14,.2f}")
for ttl, k in (('1h', 'cost1h'), ('5m', 'cost5m')):
    print(f"  {ttl} writes: ${a[k]:.2f} vs ${b[k]:.2f} -> {(a[k]-b[k])/b[k]*100:+.1f}%")
print(f"  reads avoided ${(b['read']-a['read'])*READ/1e6:.2f} | extra writes ${(a['write']-b['write'])*W1H/1e6:.2f} (1h)")

for path in sys.argv[1:3]:
    held = [json.loads(l) for l in open(path) if '"held"' in l]
    if not held: continue
    print(f"  refusals in {path.split('/')[-1]}: {len(held)}")
    for r in held[:6]:
        h = r['held']
        print(f"    turn {r.get('turn')}: drop {h['dropped']//1000}k, rewrite {h['recache']//1000}k, cost {h['cost']//1000}k vs saving {h['saving']//1000}k over {h['have']} calls (needed {h['need']} reads)")
