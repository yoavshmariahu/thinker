#!/usr/bin/env python3
"""Export the verified Artemis MLflow pairs into the existing session explorer.

Reads archived API records, request dumps and the reconciled Artemis cost report.
No model calls, judging or new benchmark measurements. Local paths and reasoning
payloads are excluded from the public artifact; original tool outputs are retained.
"""
import argparse
import hashlib
import json
import pathlib
import re

p = argparse.ArgumentParser()
p.add_argument('--records', required=True)
p.add_argument('--reconciliation', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
records, out = pathlib.Path(a.records), pathlib.Path(a.out)
tasks = json.loads((records / 'tasks.json').read_text())['tasks']
reconciliation = json.loads(pathlib.Path(a.reconciliation).read_text())
assert not reconciliation['excluded']


def text(x):
    if isinstance(x, str):
        return x
    if isinstance(x, list):
        return '\n'.join(text(i) for i in x)
    return x.get('text', '') if isinstance(x, dict) else ''


def scrub(s):
    s = re.sub(r'/private/var/folders/[^\s<>"\']+/T/artemis-worktrees/[^/\s<>"\']+', '<checkout>', s)
    s = re.sub(r'/Users/[^/\s]+', '~', s)
    s = re.sub(r'gAAAAAB[A-Za-z0-9_=\-]*', '[encrypted value omitted]', s)
    s = re.sub(r'sk-[A-Za-z0-9_\-]{20,}', '[credential-like value omitted]', s)
    s = re.sub(r'/private/var/folders/[^\s<>\"\']*', '<temporary path>', s)
    return s.replace('/Users/', '~/')


def matchable(s):
    return re.sub(r'\S*(?:bench-venv|mlflow-venv)/bin/python', '<python>', scrub(s)).strip()


for pr, ident in [('26291', 'mlflow-registry'), ('26300', 'mlflow-gateway')]:
    task = next(t for t in tasks if t['id'] == f'PR{pr}-hard')
    prompts = [task['prompt']] + task['turns']
    pair = next(p for p in reconciliation['pairs'] if p['task'] == task['id'])
    metadata = dict(id=ident, price=dict(input=10, read=1, w1h=12.5, w5m=12.5, out=50), cold=0,
                    model='GPT-6 Astra · medium', protocol='responses', recordedWrites=True,
                    combined=True, task=task['id'], source=f'Artemis · MLflow PR{pr} · nine prompts',
                    savings=dict(minPercent=pair['savedPercent']['min'], maxPercent=pair['savedPercent']['max'],
                                 minDollars=pair['saved']['min'], maxDollars=pair['saved']['max']))
    small, full, blobs = dict(metadata), dict(metadata), {}

    def keep(body):
        key = hashlib.sha256(body.encode()).hexdigest()[:16]
        blobs[key] = body
        return key

    for arm, side in [('control', 'off'), ('cut', 'on')]:
        rec = json.loads((records / f'{pr}-{side}.json').read_text())
        report = rec['raw']['armReport']
        assert rec['raw']['model'] == 'gpt-6-astra' and rec['raw']['turns'] == 9
        assert rec['row']['pass'] and not rec['row']['invalid'] and rec['raw']['grade']['tests'] == 'pass'
        dumps = sorted((json.loads(f.read_text()) for f in pathlib.Path(report['validation']['dump']).rglob('*.json')), key=lambda d: d['at'])
        assert len(dumps) == len(report['apiRequests'])
        turns = [dict(n=i+1, prompt=scrub(t), steps=[], calls=[], tools={}) for i, t in enumerate(prompts)]
        seen, seen_prompts, results, calls = set(), set(), {}, []
        current, knowledge_seen = 1, False
        for k, d in enumerate(dumps, 1):
            u, sent = d['usage'], d['sent']
            assert sent['model'] == 'gpt-6-astra' and u['serviceTier'] == 'default'
            assert u['apiUsage']['input_tokens_details']['cache_write_tokens'] == u['write'] == 0
            assert 0 <= u['read'] <= u['input'] <= 272000
            assert u['freshInput'] == u['input'] - u['read']
            assert isinstance(sent['input'], list)
            previous, new_cuts = current, []
            for item in sent['input']:
                typ = item.get('type')
                if item.get('role') == 'user':
                    body = text(item.get('content'))
                    note = re.search(r'<thinker-cache>([\s\S]*?)</thinker-cache>', body)
                    if note and not knowledge_seen:
                        turns[0]['steps'].append(dict(kind='knowledge', text=scrub(note[1].strip())))
                        knowledge_seen = True
                    matches = [i+1 for i, prompt in enumerate(prompts) if matchable(prompt) in matchable(body)]
                    if matches:
                        current = matches[-1]
                        seen_prompts.add(current)
                    continue
                # Do not publish system/developer content or encrypted reasoning.
                if item.get('role') in ['developer', 'system'] or typ in ['reasoning', 'compaction']:
                    continue
                result = typ in ['function_call_output', 'custom_tool_call_output']
                tool = typ in ['function_call', 'custom_tool_call']
                tid = item.get('call_id')
                if result:
                    body = text(item.get('output'))
                    if body.startswith('[tool result removed by thinker after use:'):
                        prior = results.get(tid)
                        assert prior, 'Cannot annotate a cut without its original result'
                        if not prior['cut']:
                            prior['cut'] = k
                            prior['step']['cutAt'] = k
                            new_cuts.append(prior)
                        continue
                identity = (typ, tid) if result or tool else (typ, item.get('id'))
                if not identity[1] or identity in seen:
                    continue
                seen.add(identity)
                turn = turns[current-1]
                if tool:
                    name = item.get('name', 'tool')
                    inp = scrub(text(item.get('input', item.get('arguments', ''))))
                    turn['steps'].append(dict(kind='tool', id=tid, name=name, input=dict(command=inp)))
                    turn['tools'][name] = turn['tools'].get(name, 0) + 1
                elif result:
                    body = scrub(text(item.get('output')))
                    step = dict(kind='result', id=tid, chars=len(body), lines=body.count('\n')+1, blob=keep(body), error=False)
                    turn['steps'].append(step)
                    results[tid] = dict(c=len(body), at=k, t=current, cut=None, step=step)
                elif item.get('role') == 'assistant':
                    body = scrub(text(item.get('content')))
                    if body:
                        turn['steps'].append(dict(kind='say', text=body))
            if any(i.get('type') == 'compaction' for i in sent['input']):
                present = {i.get('call_id') for i in sent['input'] if i.get('type') in ['function_call_output', 'custom_tool_call_output']}
                for tid, result in results.items():
                    if tid not in present and 'until' not in result:
                        result['until'] = k
            current = max(previous, current)
            call = dict(k=k, t=current, read=u['read'], write=u['write'], input=u['freshInput'], out=u['out'])
            api = next(r for r in report['apiRequests'] if r.get('responseId') == u.get('responseId'))
            if api.get('reason') == 'native-compaction':
                call['compacted'] = True
            if new_cuts:
                call['cut'] = dict(observed=True, tokens=round(sum(r['c'] for r in new_cuts)/4), results=len(new_cuts))
            calls.append(call)
            turns[current-1]['calls'].append(k)
            turns[current-1]['steps'].append(dict(kind='call', k=k))
        assert seen_prompts == set(range(1, 10)), seen_prompts
        last = next((s for s in reversed(rec['transcript']['steps']) if s['kind'] == 'assistant'), None)
        if last:
            turns[-1]['steps'].append(dict(kind='say', text=scrub(last['text'])))
        expected = pair['cost']['control' if arm == 'control' else 'compression']
        assert expected['exact']
        cost = sum((c['input']*10+c['read']+c['out']*50)/1e6 for c in calls)
        assert abs(cost-expected['min']) < 1e-8, 'Export must reconcile to the verified Artemis report'
        armdata = dict(calls=calls, outcome='PR tests passed', testEvidence=scrub(rec['raw']['grade']['testTail']),
                       elapsedMs=rec['row']['wall_ms'])
        small[arm] = dict(**armdata, results=[{k:v for k,v in r.items() if k != 'step'} for r in results.values()],
                          notes=[], turns=[{k:t[k] for k in ['n', 'tools', 'calls']} for t in turns])
        full[arm] = dict(**armdata, turns=turns)
    full['blobs'] = blobs
    for suffix, data in [('', small), ('-session', full)]:
        dest = out / f'clearing-{ident}{suffix}.json'
        contents = json.dumps(data, separators=(',', ':'), ensure_ascii=False)+'\n'
        assert not re.search(r'/Users/|/private/var/folders/|gAAAAAB', contents)
        dest.write_text(contents)
        print(dest)
