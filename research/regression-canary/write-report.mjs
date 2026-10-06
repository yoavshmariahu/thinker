import fs from 'node:fs';
const root=new URL('./',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,root)));
const sum=read('summary.json'),cases=read('cases.json'),scores=read('scores.json'),rows=read('results/results.json');
const pct=(a,b)=>`${a}/${b} (${Math.round(100*a/b)}%)`;
const resultRow=(name,t)=>`| ${name} | ${pct(t.baseline.hits,t.baseline.cases)} | ${pct(t.cached.hits,t.cached.cases)} | ${t.baseline.tokens.toLocaleString('en-US')} | ${t.cached.tokens.toLocaleString('en-US')} |`;
const lines=[
 '# Mitmproxy regression recall canary', '', 'Codex · 2026-10-06', '',
 `On 15 historical mitmproxy fixes reversed at a fixed base, GPT-6.1 Sol high caught ${sum.canary.baseline.hits} bugs without Thinker and ${sum.canary.cached.hits} with Thinker. There were ${sum.wins} Thinker-only catches and ${sum.losses} baseline-only catches. All 15 pairs completed without model errors. This is recall of known fixes learned into the cache, not prospective detection of unseen bugs.`, '',
 '| Cohort | No Thinker | Thinker | No Thinker review tokens | Thinker review tokens |','|---|---:|---:|---:|---:|',
 resultRow('Mitmproxy canary',sum.canary),resultRow('Existing Autoscaler Sol cohort',sum.historical),resultRow('Descriptive aggregate',sum.aggregate),'',
 'The aggregate retains the prior ten cases without rerunning or replacing them. Model and reasoning setting match; the Thinker source revisions differ, so the aggregate is a cross-run historical summary rather than one controlled 25-case experiment. Other model cohorts are excluded.','',
 `The canary mined ${sum.notesSaved} notes from the 15 fixes using ${sum.miningTokens.toLocaleString('en-US')} reported tokens, separately from review usage. Review calls took ${(sum.canary.baseline.elapsedMs/1000).toFixed(1)} seconds without Thinker and ${(sum.canary.cached.elapsedMs/1000).toFixed(1)} seconds with it. These are summed call timings, not total end-to-end wall time or a controlled latency benchmark. The two-sided exact paired McNemar p-value is ${sum.exactMcNemarP.toFixed(4)}; the small selected sample does not establish population performance.`, '',
 'The canary passes the predeclared expansion gate: 15 valid pairs, seven additional catches, zero losses, and all target notes retrieved. Each cached review produced one top-level finding matching its target (the UI overflow explanation is in a secondary location). No other repositories have been started in this canary run. This gate applies only to expansion of historical-fix recall.', '',
 '## Per-case evidence','',
 '| Historical fix | No Thinker | Thinker | Executable reproduction |','|---|---|---|---|',
 ...cases.cases.map(c=>{const s=scores.find(s=>s.id===c.id),repro=read('reproductions/results.json').find(r=>r.id===c.id);return `| [#${c.pr}](https://github.com/mitmproxy/mitmproxy/pull/${c.pr}) ${c.subject.replace(/\s*\(#\d+\)\s*$/,'').replace(/\|/g,'/')} | ${s.baselineHit?'Hit':'Miss'} | ${s.cachedHit?'Hit':'Miss'} | ${repro.status==='reproduced'?'Fixed passes; reversed fails':'Source/PR validation only'} |`;}),'',
 'Seven cases had changed upstream Python test files. All seven pass on the fixed base and fail with the production-only reversal while keeping current tests. Across these files the fixed runs passed 141 tests and skipped one. The other eight were validated from their historical fix and PR evidence; executable reproduction is not claimed. The paired review inputs use full reverse patches, including deleted tests and changelog entries, matching the prior Autoscaler protocol.','',
 '## Validity and limitations','',
 'Cases were selected and frozen before successful model outputs. Each full reverse patch applies cleanly at commit `d482bbaa20af168f8307a504f1de8927144f7f99`. Documentation, type-only changes, examples and a Python warning cleanup were excluded before review. `cases.json` records exact commits, targets and exclusions. Selection favors compact, long-lived reversible fixes and is not representative of arbitrary PRs.','',
 'Note generation and both review arms use `gpt-6.1-sol`, high reasoning, Codex strict configuration, and disabled provider fallback. Each valid review reports exactly one model call. Model/effort pins are established by explicit invocation; this adapter records the requested model and does not independently attest the backend model or reasoning effort. The paired calls alternate arm order. The cache arm uses holistic review with related retrieval; baseline uses nocache. Prompt scaffolding and selected code context differ, so this is a product-pipeline comparison.','',
 'A hit requires a production error/warning within six lines of the reversed fix and an explanation matching the historical failure. Mere proximity, test-only findings, and stale-note warnings do not count. `scores.json` records manual semantic grading; raw findings remain in `results/results.json`. There is no separate model judge. No clean controls were run, so false-positive rate is unknown. One sample per arm means model variance is unmeasured.','',
 '## Artifacts and reproduction','',
 '- `PROTOCOL.md`: frozen protocol and expansion gate.',
 '- `execution.json`: source revision, model settings, manifest and note hashes.',
 '- `cases.json`, `metadata/`: selected cases and public upstream evidence.',
 '- `notes.json`, `noteset/`, `mining-usage.jsonl`: note output and mining usage; the initial sandbox startup failures consumed no reported tokens and are excluded from successful-call counts.',
 '- `results/results.json`, `scores.json`, `summary.json`: paired raw reports, grading and aggregate.',
 '- `reproductions/`, `reproduce.py`, `python-packages.txt`: executable validation and dependency versions.',
 '- `run.sh`, `build-notes.mjs`, `run-pairs.mjs`: model execution; `summarize.mjs` and `write-report.mjs`: reporting.',
 '',
 'Run inside isolated Thinker and mitmproxy worktrees with `THINKER_TEST=1`. `run.sh` applies the experiment-only effort patch and resumes persisted outputs; use a fresh output directory and fresh note store for an independent rerun. To replay reviews against the original frozen notes, apply `model-effort.patch`, export the environment pins from `run.sh`, and pass `research/regression-canary/noteset` to `run-pairs.mjs` with a new results directory. The source patch is not a product change.','',
 'Thinker validation: 486 tests passed, five skipped, zero failures. Initial sandbox runs could not open local test servers or initialize the Codex app-server; reruns with the required access succeeded. All tests, dependency setup and evaluation processes used `THINKER_TEST=1`, with local usage accounting and no production telemetry.',''
];
fs.writeFileSync(new URL('README.md',root),lines.join('\n'));
