import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const [phase, session, checkout] = process.argv.slice(2);
if (!['before','after'].includes(phase) || !session || !checkout || !/^[\w.-]+$/.test(session)) throw Error('Expected before|after session checkout');
const deps = process.env.BROADCAST_DEPS_ROOT;
const capture = process.env.BROADCAST_CAPTURE_ADAPTER;
if (!deps || !capture || !fs.existsSync(path.join(deps,'frontend/node_modules'))) throw Error('Prepared test dependencies and capture adapter required');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions', session);
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, THINKER_TEST:'1', THINKER_TELEMETRY:'off', CI:'1' };
const runTests = label => {
  const resultFile = path.join(dir, label+'.json');
  const p = spawnSync('pnpm', ['--filter','@posthog/frontend','jest','--runInBand',
    '--testPathPattern=products/workflows/frontend/Broadcasts','--json','--outputFile',resultFile],
    { cwd:checkout, env, encoding:'utf8', timeout:300000, maxBuffer:8*1024*1024 });
  fs.writeFileSync(path.join(dir,label+'.log'),(p.stdout||'')+(p.stderr||''));
  let result; try { result=JSON.parse(fs.readFileSync(resultFile,'utf8')); } catch {}
  return { passed:p.status===0 && result?.success===true && result.numTotalTests>0,
    tests:result?.numTotalTests ?? null, failed:result?.numFailedTests ?? null,
    suites:result?.numTotalTestSuites ?? null, exitCode:p.status, error:p.error?.message ?? null, resultFile };
};
if (phase==='before') {
  // Share frozen dependency installations, but resolve the code under test in this
  // session's own checkout. Never link or copy another agent's modified sources.
  function link(relative='') {
    const source=path.join(deps,relative), target=path.join(checkout,relative);
    if (!fs.existsSync(target)) return;
    for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
      if (!entry.isDirectory() || entry.name==='.git') continue;
      if (entry.name==='node_modules') {
        const destination=path.join(target,entry.name);
        if (fs.existsSync(destination)) throw Error('Unexpected existing dependency directory: '+destination);
        fs.symlinkSync(path.join(source,entry.name),destination,'dir');
      } else link(path.join(relative,entry.name));
    }
  }
  link();
  const baseline=runTests('before-tests');
  fs.writeFileSync(path.join(dir,'baseline.json'),JSON.stringify(baseline));
  if (!baseline.passed) throw Error('Broadcast tests fail before coding: '+JSON.stringify(baseline));
  const ready=execFileSync(process.execPath,[capture,'before',session,checkout],{cwd:checkout,env,encoding:'utf8',maxBuffer:16*1024*1024});
  process.stdout.write(ready);
} else {
  const report=JSON.parse(execFileSync(process.execPath,[capture,'after',session,checkout],{cwd:checkout,env,encoding:'utf8',maxBuffer:16*1024*1024}));
  const result=runTests('after-tests');
  const baseline=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json'),'utf8'));
  report.functionalValidation={...result,baselineTests:baseline.tests,
    additionalCases:result.tests==null?null:result.tests-baseline.tests,
    scope:'Focused frontend Broadcasts Jest tests, including agent-authored regressions. Backend integration not provisioned.',
    complete:result.passed && result.tests>baseline.tests};
  console.log(JSON.stringify(report));
}
