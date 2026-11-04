#!/usr/bin/env python3
"""Turn one paired clearing run into the two data files site/clearing.html reads.

A run is two Claude Code sessions over the same prompts, one through thinker's cut (`cut`) and one held
out (`control`), each behind its own proxy. For each arm this reads:
  - the session's own Claude Code transcript (~/.claude/projects/<cwd key>/<session id>.jsonl): every
    model call's usage as the API reported it, every tool call, every result, every answer;
  - the arm's proxy log: the cuts taken (`proxy-cut` rows) and refused (`held`), which the transcript
    cannot see;
and for the cut arm the proxy's request dump (THINKER_PROXY_DUMP), which says at which call each result
first went up as a placeholder.

Writes <out>/clearing-<id>.json (small: per-call tokens, cuts, results, notes; inlined into the page) and
<out>/clearing-<id>-session.json (every turn's contents, fetched when the Session tab opens).

  site-data.py --id real --out site --log-cut B/log-thinker.jsonl --log-control B/log-control.jsonl \
    --cwd-cut B/click-thinker --cwd-control B/click-control --dump B/dump-thinker --strip B/click-thinker/ \
    --strip B/click-control/ [--sid-cut ID --sid-control ID]
"""
import argparse, glob, hashlib, json, os, re, sys
ap = argparse.ArgumentParser()
ap.add_argument('--id', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--log-cut', required=True); ap.add_argument('--log-control', required=True)
ap.add_argument('--cwd-cut', required=True); ap.add_argument('--cwd-control', required=True)
ap.add_argument('--sid-cut'); ap.add_argument('--sid-control'); ap.add_argument('--dump', required=True)
ap.add_argument('--strip', action='append', default=[], help='path prefix to remove from everything shown')
ap.add_argument('--cold', type=int, default=0, help='cache-write tokens the control skipped by sharing a cache')
A = ap.parse_args()
PRICE = dict(input=4.0, out=20.0, read=0.2, w1h=8.0, w5m=5.0)   # Claude Opus 5.5 at list, $/M (prices.js)
PH = re.compile(r'^\[tool result (?:cleared|removed) by thinker')
HOME = os.path.expanduser('~')
def scrub(s):
    for p in A.strip: s = s.replace(p.rstrip('/') + '/', '').replace(p.rstrip('/'), '.')
    return s.replace(HOME, '~')
def tkey(cwd): return os.path.join(HOME, '.claude', 'projects', re.sub(r'[/.]', '-', os.path.realpath(cwd)))
def rows(path): return [json.loads(l) for l in open(path) if l.strip()]
def text_of(cont): return cont if isinstance(cont, str) else '\n'.join(x.get('text', '') for x in (cont or []) if isinstance(x, dict))
blobs = {}
def keep(text):
    h = hashlib.sha1(text.encode()).hexdigest()[:12]; blobs[h] = text; return h

# ---- the proxy log: calls with cuts and refusals attached ----
def proxy_calls(path):
    out = []
    for r in rows(path):
        # a `proxy-cut` row is written after the row of the call whose request carried the cut (the dump's
        # placeholders first appear in that call), so it belongs to the call before it
        if r.get('op') == 'proxy-cut':
            if out: out[-1]['cut'] = {k: r.get(k) for k in ('tokens', 'recache', 'cost', 'saving', 'results', 'uses')}
            continue
        if r.get('op') != 'proxy': continue
        c = dict(read=r.get('read') or 0, write=r.get('write1h') or 0, write5m=r.get('write5m') or 0, input=r.get('input') or 0, out=r.get('out') or 0)
        if r.get('held'): c['held'] = r['held']
        if r.get('native-compaction') or r.get('compacted'): c['compacted'] = True
        out.append(c)
    return out

# ---- the dump: at which call each result first went up as a placeholder ----
cutAt, ph = {}, {}
sess_dirs = [d for d in glob.glob(A.dump + '/*') if os.path.isdir(d)]
k = 0
for f in sorted(glob.glob(sess_dirs[0] + '/*.json')) if sess_dirs else []:
    b = json.load(open(f))
    if not b.get('usage'): continue
    k += 1
    for m in b['sent'].get('messages', []):
        if isinstance(m.get('content'), str): continue
        for p in m['content']:
            if p.get('type') == 'tool_result':
                s = text_of(p.get('content'))
                if PH.match(s) and p['tool_use_id'] not in cutAt: cutAt[p['tool_use_id']] = k; ph[p['tool_use_id']] = s

# ---- the transcripts ----
def transcript(arm, cwd, sid):
    d = tkey(cwd)
    if not sid:
        fs = sorted(glob.glob(d + '/*.jsonl'), key=os.path.getmtime)
        if not fs: sys.exit(f'no transcript under {d}')
        sid = os.path.basename(fs[-1])[:-6]
    turns, calls, seen, results, pendingRes = [], [], {}, [], []
    for rec in rows(f'{d}/{sid}.jsonl'):
        t = rec.get('type')
        if t == 'user':
            c = rec['message']['content']
            if isinstance(c, str):
                turns.append(dict(n=len(turns) + 1, prompt=scrub(c), steps=[], calls=[], tools={})); continue
            for p in c:
                if p.get('type') == 'tool_result':
                    s = scrub(text_of(p.get('content'))); tid = p['tool_use_id']
                    step = dict(kind='result', id=tid, chars=len(s), lines=s.count('\n') + 1, blob=keep(s), error=bool(p.get('is_error')))
                    if arm == 'cut' and tid in cutAt: step['cutAt'] = cutAt[tid]; step['placeholder'] = ph[tid]
                    turns[-1]['steps'].append(step); pendingRes.append(step)
                elif p.get('type') == 'text' and not p.get('text', '').startswith('<system-reminder>'):
                    turns[-1]['steps'].append(dict(kind='user', text=scrub(p['text'])))
        elif t == 'assistant':
            m = rec['message']; rid = rec.get('requestId')
            if rid not in seen:
                u = m.get('usage', {})
                call = dict(k=len(calls) + 1, t=len(turns), read=u.get('cache_read_input_tokens', 0), write=u.get('cache_creation_input_tokens', 0), input=u.get('input_tokens', 0), out=u.get('output_tokens', 0))
                calls.append(call); seen[rid] = call; turns[-1]['calls'].append(call['k']); turns[-1]['steps'].append(dict(kind='call', k=call['k']))
                for st in pendingRes: results.append(dict(c=st['chars'], at=call['k'], t=len(turns), cut=st.get('cutAt'), id=st['id']))
                pendingRes = []
            for p in m['content']:
                if p['type'] == 'thinking': turns[-1]['steps'].append(dict(kind='thinking', chars=len(p.get('thinking', ''))))
                elif p['type'] == 'text': turns[-1]['steps'].append(dict(kind='say', text=scrub(p['text'])))
                elif p['type'] == 'tool_use':
                    inp = json.loads(scrub(json.dumps(p['input'])))
                    turns[-1]['steps'].append(dict(kind='tool', id=p['id'], name=p['name'], input=inp))
                    turns[-1]['tools'][p['name']] = turns[-1]['tools'].get(p['name'], 0) + 1
    return sid, turns, calls, results

out_small, out_session = dict(id=A.id, price=PRICE, cold=A.cold), dict(id=A.id, price=PRICE, cold=A.cold)
for arm, cwd, sid, log in (('cut', A.cwd_cut, A.sid_cut, A.log_cut), ('control', A.cwd_control, A.sid_control, A.log_control)):
    sid, turns, calls, results = transcript(arm, cwd, sid)
    pc = proxy_calls(log)
    if len(pc) != len(calls): print(f'WARNING {arm}: proxy log has {len(pc)} calls, transcript {len(calls)}', file=sys.stderr)
    for c, p in zip(calls, pc):
        if c['read'] != p['read']: print(f'WARNING {arm} call {c["k"]}: read {c["read"]} vs proxy {p["read"]}', file=sys.stderr)
        for key in ('cut', 'held', 'compacted'):
            if key in p: c[key] = p[key]
    # re-reads: a Read (or cat) of a file whose earlier result was cut before this call
    notes = []
    if arm == 'cut':
        cutFiles = {}   # file -> call at which its result was cut
        for t in turns:
            lastTool = None
            for st in t['steps']:
                if st['kind'] == 'tool': lastTool = st
                elif st['kind'] == 'result' and lastTool and lastTool['name'] == 'Read' and st.get('cutAt'):
                    cutFiles.setdefault(lastTool['input'].get('file_path'), st['cutAt'])
        for t in turns:
            k_now = t['calls'][0] if t['calls'] else 0
            for st in t['steps']:
                if st['kind'] == 'call': k_now = st['k']
                if st['kind'] == 'tool' and st['name'] == 'Read':
                    f = st['input'].get('file_path')
                    if f in cutFiles and cutFiles[f] <= k_now:
                        notes.append(dict(kind='reread', k=k_now, turn=t['n'], file=f, cutAt=cutFiles[f]))
    # small file: per call, results, notes
    out_small[arm] = dict(sid=sid, calls=[{**{x: c[x] for x in ('k', 't', 'read', 'write', 'input', 'out')}, **({'cut': c['cut']} if 'cut' in c else {}), **({'held': c['held']} if 'held' in c else {}), **({'compacted': True} if c.get('compacted') else {})} for c in calls],
                          results=[{x: r[x] for x in ('c', 'at', 't', 'cut')} for r in results], notes=notes,
                          turns=[dict(n=t['n'], tools=t['tools'], calls=t['calls']) for t in turns])
    out_session[arm] = dict(sid=sid, turns=turns, calls=calls)
    print(f'{arm}: {len(turns)} turns, {len(calls)} calls, {len(results)} results, cuts {sum(1 for c in calls if "cut" in c)}, refused {sum(1 for c in calls if "held" in c)}, re-reads {len(notes)}, compacted {sum(1 for c in calls if c.get("compacted"))}', file=sys.stderr)
    if arm == 'cut': print(f'  results cut: {sum(1 for r in results if r["cut"])} of {len(results)}', file=sys.stderr)
out_session['blobs'] = blobs
os.makedirs(A.out, exist_ok=True)
small = scrub(json.dumps(out_small, separators=(',', ':'), ensure_ascii=False))
big = scrub(json.dumps(out_session, separators=(',', ':'), ensure_ascii=False))
open(f'{A.out}/clearing-{A.id}.json', 'w').write(small); open(f'{A.out}/clearing-{A.id}-session.json', 'w').write(big)
print(f'wrote clearing-{A.id}.json ({len(small.encode()):,} bytes) and clearing-{A.id}-session.json ({len(big.encode()):,} bytes)', file=sys.stderr)
