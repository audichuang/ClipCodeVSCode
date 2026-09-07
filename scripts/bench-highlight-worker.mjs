import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
// Research probe only: no browser DOM, no Git mutations, no product integration.
const base=fileURLToPath(new URL('../',import.meta.url));
const req=createRequire(base+'/graph/webview-ui/package.json');
const imp=name=>import(pathToFileURL(req.resolve(name)).href);
async function highlighter(){
 const {createHighlighterCore}=await imp('shiki/core'); const {createOnigurumaEngine}=await imp('shiki/engine/oniguruma');
 return createHighlighterCore({themes:[imp('shiki/themes/dark-plus.mjs')],langs:[imp('shiki/langs/typescript.mjs')],engine:createOnigurumaEngine(imp('shiki/wasm'))});
}
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function render(h,lines){return lines.map(line=>h.codeToTokens(line,{lang:'typescript',theme:'dark-plus'}).tokens[0].map(t=>t.color?`<span style="color:${t.color}">${escape(t.content)}</span>`:escape(t.content)).join(''));}
if(!isMainThread){
 const h=await highlighter(); render(h,workerData); parentPort.postMessage({ready:true});
 parentPort.on('message',lines=>{ for(let i=0;i<lines.length;){const end=Math.min(lines.length,i+(i?200:60));parentPort.postMessage({chunk:render(h,lines.slice(i,end)),done:end===lines.length});i=end;} });
}else{
 const lines=readFileSync(base+'/graph/src/git/git-service.ts','utf8').split('\n').slice(0,3000);
 const h=await highlighter();render(h,lines);
 const startup=performance.now();const w=new Worker(new URL(import.meta.url),{workerData:lines});
 await new Promise((r,j)=>{w.once('message',r);w.once('error',j)});const startupMs=performance.now()-startup;
 const runWorker=()=>new Promise((resolve,reject)=>{const html=[];const receive=r=>{html.push(...r.chunk);if(r.done){w.off('message',receive);w.off('error',reject);resolve(html)}};w.on('message',receive);w.once('error',reject);w.postMessage(lines)});
 const runChunked=async()=>{const html=[];for(let i=0;i<lines.length;){const end=Math.min(lines.length,i+(i?200:60));html.push(...render(h,lines.slice(i,end)));i=end;if(i<lines.length)await new Promise(r=>setTimeout(r,0));}return html;};
 async function measure(work){let last=performance.now(),lag=0;const timer=setInterval(()=>{const now=performance.now();lag=Math.max(lag,now-last-4);last=now},4);const start=performance.now();const html=await work();const total=performance.now()-start;await new Promise(r=>setTimeout(r,12));clearInterval(timer);return{totalMs:total,maxTimerLagMs:lag,bytes:Buffer.byteLength(html.join(''))};}
 const samples=[[],[],[]];const modes=[()=>render(h,lines),runChunked,runWorker];for(let trial=0;trial<5;trial++)for(const i of trial%2?[2,1,0]:[0,1,2])samples[i].push(await measure(modes[i]));
 const baseline=render(h,lines);const workerResult=await runWorker();if(JSON.stringify(baseline)!==JSON.stringify(workerResult))throw new Error('Worker output mismatch');
 const med=(a,k)=>a.map(x=>x[k]).sort((a,b)=>a-b)[2];
 const result={scope:'Node prototype: blocking control, current-size chunked main, streaming worker; warm 3000-line TS HTML, no browser DOM',modes:['blocking','chunked-main','streaming-worker'],startupIncludingWarmupMs:startupMs,samples,medians:samples.map(s=>({totalMs:med(s,'totalMs'),maxTimerLagMs:med(s,'maxTimerLagMs')}))};
 writeFileSync(process.argv[2] ?? '/tmp/snipcode-worker-probe.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await w.terminate();h.dispose();
}
