"""Validate the new clean control with exact extracted public source, no model calls."""
import json
import os
from pathlib import Path
import subprocess

assert os.environ.get('THINKER_TEST') == '1'
HERE = Path(__file__).resolve().parent
old = (HERE.parent / 'review-loop-pilot/fixtures/A-10349.fixed.go.txt').read_text()
new = (HERE / 'fixtures/aws-renamed.go.txt').read_text()
assert new.replace('parsedName', 'name') == old, 'Control changes more than the local identifier'
start = new.index('func AwsRefFromProviderId')
function = new[start:new.index('\n}', start)+2]
regex = next(line for line in new.splitlines() if line.startswith('var validAwsRefIdRegex'))
program = '''package main
import("fmt";"regexp";"encoding/json";"os")
const placeholderInstanceNamePrefix="i-placeholder-"
type AwsInstanceRef struct{ProviderID,Name string}
''' + regex + '\n' + function + '''
func main(){
 id:="aws:///us-east-1a/i-placeholder-some/arbitrary/cluster/local"
 p,e:=AwsRefFromProviderId(id)
 _,bad:=AwsRefFromProviderId("junkaws:///us-east-1a/i-placeholder-some")
 ordinary,oe:=AwsRefFromProviderId("aws:///us-east-1a/i-12345")
 checks:=map[string]bool{"slashPreserved":e==nil&&p.Name=="i-placeholder-some/arbitrary/cluster/local","originalIDPreserved":e==nil&&p.ProviderID==id,"malformedRejected":bad!=nil,"ordinaryIDAccepted":oe==nil&&ordinary.Name=="i-12345"}
 json.NewEncoder(os.Stdout).Encode(checks)
}
'''
out = HERE / 'results/probes'
out.mkdir(parents=True, exist_ok=True)
file = out / 'clean-control.go'
file.write_text(program)
env = dict(os.environ, GOCACHE=str(HERE.parents[1]/'.round2-go-cache'), GOPROXY='off', GOTOOLCHAIN='local')
r = subprocess.run(['go','run',str(file)], cwd=HERE, env=env, capture_output=True, text=True, timeout=90)
assert r.returncode == 0, r.stderr
checks = json.loads(r.stdout)
assert all(checks.values()), checks
result = {'identifierOnlyChange': True, 'checks': checks, 'scope':'Extracted parser with stdlib wrappers; not an upstream integration test. Conflicting contracts have no executable oracle for human intent.'}
(out/'results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
