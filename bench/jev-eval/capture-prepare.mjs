// Freeze public-project benchmark inputs before running any selection or writing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { parseTranscript } from '../../src/transcripts.js';
if (process.env.THINKER_TEST !== '1') throw new Error('THINKER_TEST=1 required');
const root = path.resolve(process.argv[2] || '.'), out = 'research/jev-capture-experiments';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const sanitize = value => JSON.parse(JSON.stringify(value).replace(/\/Users\/[^/"\s]+\/src\/thinker\/bench\/worktrees\/[^/"\s]+\//g, '').replace(/\/Users\/[^/"\s]+/g, '/benchmark-user'));
const sessions = [];
for (const number of [105793,106466,106522,106579,106917,107042]) {
  const source = `bench/runs/posthog-codex-gpt6-sol-trace/events/PR${number}-hard-nocache-0.jsonl`;
  const events = parseTranscript(path.join(root, source)).events;
  const task = read('bench/tasks/posthog-hard.json').tasks.find(t => t.id === `PR${number}-hard`);
  if (!events.some(e => e.t === 'prompt')) events.unshift({ t:'prompt', text:task.prompt });
  sessions.push({ id:`posthog-${number}`, cohort:'recorded', source, events:sanitize(events) });
}
const say = text => ({t:'say',text}), prompt = text => ({t:'prompt',text});
const tool = (name, file_path, result) => ({t:'tool',name,input:{file_path},result});
const noise = () => Array.from({length:70}, (_,i) => tool('Read','src/display.js', `Read ${i}: ` + 'const spacing = 12; // ordinary display spacing\n'.repeat(30)));
const discovery = tool('Read','src/snapshots.js','function refresh(next) { current = Object.freeze(next); }\nfunction openReader() { const snapshot = current; return () => snapshot; }\nExisting readers retain the captured snapshot after refresh; new readers capture the new snapshot.');
const edges = [
 {id:'short-discovery', events:[prompt('Determine whether refresh changes existing readers.'),discovery,say('Existing readers capture their snapshot; refresh only affects readers opened later.')], expected:['existing readers retain the old snapshot; new readers see the refreshed snapshot']},
 {id:'buried-discovery', events:[prompt('Trace snapshot lifetime.'),...noise().slice(0,35),discovery,...noise().slice(35),say('Investigation complete.')],expected:['existing readers retain the old snapshot; new readers see the refreshed snapshot']},
 {id:'late-correction',events:[prompt('Find the retry limit.'),tool('Read','src/retry.js','Old comment: all requests retry three times.'),say('All requests retry three times.'),...noise(),tool('Read','src/retry.js','function retry(req) { if (req.method !== "GET") return send(req); return retryAtMost(3, req); }'),say('Correction: only GET requests retry up to three times. Other methods are sent once.')],expected:['GET alone retries up to three times; other methods are sent once']},
 {id:'routine-work',events:[prompt('Change a button label from Submit to Send.'),tool('Edit','src/button.js','Changed text from Submit to Send.'),say('Updated the label.')],expected:[]},
 {id:'machine-failure',events:[prompt('Run the existing tests.'),tool('Bash','', 'Error: node: command not found on this terminal.'),say('Node is missing on this machine. No repository behavior was established.')],expected:[]},
 {id:'unsupported-guess',events:[prompt('How are cache updates serialized?'),...noise().slice(0,10),say('I did not find the implementation. Perhaps it uses a distributed lock; that is only a guess.')],expected:[]},
];
sessions.push(...edges.map(x=>({...x,cohort:'constructed',source:'hand-authored stress case'})));
const prs=[];
for(const repo of ['mitmproxy','posthog','grafana']) {
 const metadata=read(`bench/data/${repo==='mitmproxy'?'mitmproxy-prs':repo==='posthog'?'posthog-merged-prs':'grafana-candidates'}.json`);
 const entries=Array.isArray(metadata)?metadata:metadata.candidates;
 const files=fs.readdirSync(path.join(root,`bench/data/${repo}-diffs`)).filter(f=>f.endsWith('.diff')).sort((a,b)=>parseInt(a)-parseInt(b)).slice(0,6);
 for(const f of files){const number=parseInt(f), p=entries.find(x=>x.number===number);if(!p)throw Error(`metadata missing ${repo}/${number}`);
 prs.push({id:`${repo}-${number}`,cohort:'recorded',repo,number,title:p.title,body:p.body||'',mergedAt:p.mergedAt||null,files:p.files||p.src||[],diff:fs.readFileSync(path.join(root,`bench/data/${repo}-diffs/${f}`),'utf8')});}
}
const corpus={sessions,prs};
const bytes=Buffer.from(JSON.stringify(corpus));
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(`${out}/corpus.json.gz`,zlib.gzipSync(bytes));
fs.writeFileSync(`${out}/protocol.json`,JSON.stringify({date:'2026-10-06',author:'Codex',base:'ad85060',corpusSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
 models:{selector:'jev-1.13.0',writer:'claude-sonnet-5',judge:'claude-sonnet-5',effort:'medium',thinkingTokens:0,provider:'claude CLI, no tools, empty cwd, no fallback'},
 design:{sessions:'six fixed nocache sessions from one PostHog coding cohort; paired inputs, no new exploration',passages:['condense (70k character cap)','deterministic evidencePacket (12k)','production refineLearningPlan (12k, 96 candidates, floor .7)'],
 sessionGate:'independent Noul on chronological source batches; max batch probability; compare threshold .5 and conservative .2 to local learningPlan auditRate=0',
 prs:'first six numeric IDs with saved diffs per project; rank at equal quota nine using existing pickPrs versus semantic probability',
 repeats:'two independent Jev runs; first-run selected evidence used for writing; one writer draw per arm initially',
 grading:'derive up to three source-grounded reusable facts before writing; blind arm names; separate support, fact coverage and reusable note count; constructed expected facts fixed by author',
 scope:'empty starting cache; no novelty/reconciliation/assessment, no production note writes; selection experiment only',
 limitations:['PR pool was originally benchmark-selected, not representative intake','recorded sessions share one project and coding model','LLM grading is a proxy, not downstream task correctness','full baseline uses production condensation and is not all raw source text'],
 acceptance:'retain useful knowledge and unsupported-note rate before treating reduced writer input as a saving; total tokens include selector; no tuning on held-out results'},
 sessions:sessions.map(({events,...x})=>({...x,eventCount:events.length})),prs:prs.map(({diff,body,...x})=>({...x,diffChars:diff.length,bodyChars:body.length}))},null,2)+'\n');
console.log({sessions:sessions.length,prs:prs.length,bytes:bytes.length});
