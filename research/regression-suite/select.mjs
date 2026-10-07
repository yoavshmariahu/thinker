import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
const [repo,out,slug='pallets/click']=process.argv.slice(2);
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:32*1024*1024});
const base=git(['rev-parse','HEAD']).trim();
const cases=[];
for(const line of git(['log','--first-parent','--format=%H%x09%s',base]).trim().split('\n')){
 const [sha,subject]=line.split('\t');
 const pr=Number(subject.match(/\(#(\d+)\)\s*$/)?.[1]);
 if(!pr||! /fix|bug|regress|crash|race|overflow|leak|prevent|avoid|wrong|missing|ensure|handle|restore|do not|don't|preserve|strip|escape|correct/i.test(subject)||/^(Merge|Revert)/.test(subject))continue;
 const parent=git(['rev-parse',`${sha}^1`]).trim();
 const stats=git(['diff','--numstat',parent,sha]).trim().split('\n').map(s=>s.split('\t'));
 const prod=stats.filter(([a,d,p])=>a!=='-'&&/\.(py|go|ts|tsx|js|rs)$/.test(p)&&!/(^|\/)(test|tests|testing|__tests__|fixtures|docs|examples|benchmarks)(\/|$)|\.(test|spec)\.|_test\.|test_|\.d\.ts$/.test(p));
 const codeLines=prod.reduce((n,[a,d])=>n+Number(a)+Number(d),0),totalLines=stats.reduce((n,[a,d])=>n+(Number(a)||0)+(Number(d)||0),0);
 if(!codeLines||codeLines>120||totalLines>250||stats.length>10)continue;
 const patch=git(['diff','--binary',parent,sha]);
 if(spawnSync('git',['apply','--reverse','--check','-'],{cwd:repo,input:patch}).status)continue;
 cases.push({id:`${slug.split('/')[1]}-${pr}`,pr,sha,parent,subject,codeLines,totalLines,files:stats.map(x=>x[2]),production:prod.map(x=>x[2])});
 if(cases.length>=75)break;
}
fs.writeFileSync(out,JSON.stringify({repo:slug,base,rule:'Newest first-parent fix-like commits with 1–120 production code lines, <=250 total lines, <=10 files, clean full reverse application at fixed base. Manually validate bug semantics before freezing 15; exclude feature/typing-only changes.',cases},null,2)+'\n');
console.log(cases.map(c=>`${c.id} ${c.codeLines}/${c.totalLines} ${c.subject}`).join('\n'));
