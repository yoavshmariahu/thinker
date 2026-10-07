"""Audit native tool inputs and frozen records; flags require human/model inspection."""
import hashlib,json,pathlib,re
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'bench/runs/cache-effectiveness';RAW=OUT/'raw';DEST=pathlib.Path(__file__).resolve().parent
execution=json.loads((OUT/'execution.json').read_text())
original_root=next(pathlib.Path(name).parents[2] for name in execution['sourceHashes'] if name.endswith('/research/performance-canary/run.py'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
hash_checks={name:(RAW/'frozen-source'/pathlib.Path(name).relative_to(original_root)).exists() and sha(RAW/'frozen-source'/pathlib.Path(name).relative_to(original_root))==value for name,value in execution['sourceHashes'].items()}
hash_checks['tasks']=sha(OUT/'tasks.json')==execution['tasksSha256'];hash_checks['prs']=sha(OUT/'prs.json')==execution['prsSha256']
calls=[];flags=[];invocations=[];note_checks=[]
for file in sorted(RAW.glob('*-invocation.json')):
    invocation=json.loads(file.read_text());name=file.name.removesuffix('-invocation.json');model=name.split('-')[-2]
    invocations.append({'id':name,'pinValid':invocation['model']==execution['models'][model] and invocation['effort']=='high','revisionValid':invocation['thinkerCommit']==execution['thinkerCommit']})
    events=RAW/(name+('.transcript.jsonl' if model=='gemini' else '.events.jsonl'))
    if not events.exists():flags.append({'id':name,'reason':'missing native events'});continue
    for line in events.read_text().splitlines():
        try:e=json.loads(line)
        except ValueError:continue
        extracted=[]
        if model=='gemini':extracted=[{'tool':t.get('name'),'input':t.get('args')} for t in e.get('tool_calls',[])]
        elif model=='opus' and e.get('type')=='assistant':extracted=[{'tool':b.get('name'),'input':b.get('input')} for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use']
        elif model=='sol' and e.get('type')=='item.completed':
            item=e['item']
            if item.get('type')=='command_execution':extracted=[{'tool':'command_execution','input':item.get('command')}]
            elif item.get('type')=='file_change':extracted=[{'tool':'file_change','input':item.get('changes')}]
        for call in extracted:
            row={'id':name,**call};calls.append(row);text=json.dumps(call['input'])
            if re.search(r'git\s+(?:log|show|fetch|pull|clone|remote)|\b(?:curl|wget|pip\s+install|spawn_agent)\b|(?:^|\s)\.\./|thinker_lookup|https?://|/raw/|verify-gold|(?:unset|export).*PYTEST|addopts|\bstress\b',text):flags.append(row)
for file in sorted(RAW.glob('*-pr-note-hashes.json')):
    name=file.name.removesuffix('-pr-note-hashes.json');expected=json.loads(file.read_text());source=RAW/(name+'-pr-notes');target=OUT/'state'/(name+'-thinker')/'.thinker/local/notes'
    note_checks.append({'id':name,'count':len(expected),'sourceUnchanged':{p.name:sha(p) for p in source.glob('*.json')}==expected,
                        'targetUnchanged':{p.name:sha(p) for p in target.glob('*.json')}==expected,'baselineClean':not(OUT/'state'/(name+'-baseline')/'.thinker').exists()})
report={'hashChecks':hash_checks,'invocations':invocations,'noteChecks':note_checks,'toolCalls':len(calls),'reviewCandidates':flags,
        'scope':'Source hashes checked against the preserved execution-time snapshot; copied local-note bytes inspected before any coding. Recorded native inputs only; flags are review candidates, not automatic contamination findings. No OS-level hermeticity claim.'}
(DEST/'audit.json').write_text(json.dumps(report,indent=2)+'\n');(RAW/'tool-inputs.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in calls))
print(json.dumps({'hashesValid':all(hash_checks.values()),'invocations':len(invocations),'toolCalls':len(calls),'reviewCandidates':len(flags),'notes':note_checks},indent=2))
