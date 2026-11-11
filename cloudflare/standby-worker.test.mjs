import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createStandbyWorker} from './standby-worker.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const env={FAILOVER_ENABLED:'true',BALANCE_ENABLED:'true',BACKUP_ORIGIN:'https://standby.example',STANDBY_ORIGIN_SECRET:'fixture-origin-secret'};
function request(host='api.mangahub.art',path='/api/manga/homepage',options={}) {
  const r=new Request('https://'+host+path,{...options,headers:{cookie:'mh_route=00000063',...options.headers}});
  Object.defineProperty(r,'cf',{value:{country:'VN',colo:'SIN'}});
  return r;
}
function setup({primary=true,backup=true,capacity=true,handle}={}) {
  const calls=[], jobs=[];
  let clock=1000;
  const send=async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input;
    const u=new URL(r.url);
    if(u.pathname==='/health'||u.pathname==='/auth/health')return Response.json({status:primary?'ok':'unavailable'},{status:primary?200:503});
    if(u.pathname==='/internal/origin-status') {
      assert.equal(r.headers.get('X-MangaHub-Origin-Secret'),env.STANDBY_ORIGIN_SECRET);
      return Response.json({status:backup?'ready':'unavailable',accept_extra:capacity,primary_frontend_ok:primary},{status:backup?200:503});
    }
    calls.push(r);
    return handle?handle(r):new Response(u.hostname==='standby.example'?'backup':'primary');
  };
  const worker=createStandbyWorker(send,()=>clock);
  const ctx={waitUntil:p=>jobs.push(p)};
  return {worker,calls,ctx,done:async()=>{while(jobs.length)await Promise.all(jobs.splice(0));},tick:ms=>{clock+=ms;}};
}
test('healthy default stays on Vercel and strips provider markers',async()=>{
  const f=setup({handle:()=>new Response('ok',{headers:{'X-MangaHub-Origin':'vps'}})});
  const r=await f.worker.fetch(request(),env,f.ctx);await f.done();
  assert.equal(await r.text(),'ok');assert.equal(r.headers.get('X-MangaHub-Origin'),null);
  assert.equal(new URL(f.calls[0].url).hostname,'api.mangahub.art');
});
test('eligible affinity gets bounded spare VPS capacity',async()=>{
  const f=setup();await f.worker.fetch(request(),env,f.ctx);await f.done();f.calls.length=0;
  const r=await f.worker.fetch(request(undefined,undefined,{headers:{cookie:'mh_route=00000000'}}),env,f.ctx);
  assert.equal(await r.text(),'backup');assert.equal(f.calls.length,1);
});
test('a busy VPS receives no proactive spillover',async()=>{
  const f=setup({capacity:false});await f.worker.fetch(request(),env,f.ctx);await f.done();f.calls.length=0;
  const r=await f.worker.fetch(request(undefined,undefined,{headers:{cookie:'mh_route=00000000'}}),env,f.ctx);
  assert.equal(await r.text(),'primary');
});
test('cold mutation probes first and submits once to healthy standby',async()=>{
  const f=setup({primary:false,handle:async r=>new Response(await r.text())});
  const r=await f.worker.fetch(request('auth.mangahub.art','/auth/login',{method:'POST',body:'one-login'}),env,f.ctx);
  assert.equal(await r.text(),'one-login');assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0].url).hostname,'standby.example');
});
for(const method of ['POST','PUT','PATCH','DELETE'])test(method+' is never replayed after uncertain completion',async()=>{
  const f=setup({handle:()=>new Response('may have committed',{status:503})});
  assert.equal((await f.worker.fetch(request(undefined,undefined,{method,body:'one-write'}),env,f.ctx)).status,503);
  assert.equal(f.calls.length,1);
});
test('safe primary network failure retries exactly once at standby',async()=>{
  const f=setup({handle:r=>{if(new URL(r.url).hostname!=='standby.example')throw new Error('primary down');return new Response('recovered');}});
  assert.equal(await (await f.worker.fetch(request(),env,f.ctx)).text(),'recovered');await f.done();assert.equal(f.calls.length,2);
});
test('VPS failure returns a safe request to healthy Vercel',async()=>{
  const f=setup({handle:r=>{if(new URL(r.url).hostname==='standby.example')throw new Error('backup down');return new Response('primary');}});
  await f.worker.fetch(request(),env,f.ctx);await f.done();f.calls.length=0;
  assert.equal(await(await f.worker.fetch(request(undefined,undefined,{headers:{cookie:'mh_route=00000000'}}),env,f.ctx)).text(),'primary');assert.equal(f.calls.length,2);
});
test('QQ source recovery hints are preserved without changing host',async()=>{
  const f=setup({handle:()=>Response.json({detail:'source unavailable'},{status:503,headers:{'X-TruyenQQ-Error':'http-403','X-TruyenQQ-Source-Path':'/doc-truyen'}})});
  const r=await f.worker.fetch(request(),env,f.ctx);await f.done();
  assert.equal(r.status,503);assert.equal(r.headers.get('X-TruyenQQ-Source-Path'),'/doc-truyen');assert.equal(f.calls.length,1);
});
for(const status of [401,403,404,429])test('application '+status+' is not hidden by failover',async()=>{
  const f=setup({handle:()=>new Response('policy',{status})});
  assert.equal((await f.worker.fetch(request(),env,f.ctx)).status,status);await f.done();assert.equal(f.calls.length,1);
});
test('backup receives canonical host and verified client IP without spoofed forwarding fields',async()=>{
  const f=setup({primary:false});
  await f.worker.fetch(request(undefined,undefined,{method:'POST',body:'fixture',headers:{'CF-Connecting-IP':'192.0.2.15','X-Forwarded-For':'forged','X-MangaHub-Origin-Secret':'forged'}}),env,f.ctx);
  assert.equal(f.calls.length,1);const h=f.calls[0].headers;
  assert.equal(h.get('X-MangaHub-Origin-Secret'),env.STANDBY_ORIGIN_SECRET);
  assert.equal(h.get('X-MangaHub-Public-Host'),'api.mangahub.art');assert.equal(h.get('X-MangaHub-Client-IP'),'192.0.2.15');assert.equal(h.get('X-Forwarded-For'),null);
});
test('country gate remains before either frontend origin',async()=>{
  const f=setup(),r=new Request('https://mangahub.art/',{headers:{accept:'text/html'}});
  Object.defineProperty(r,'cf',{value:{country:'AU'}});
  assert.equal((await f.worker.fetch(r,env,f.ctx)).status,403);assert.equal(f.calls.length,0);
});
test('both providers failing returns bounded JSON and canonical CORS',async()=>{
  const f=setup({handle:()=>{throw new Error('down');}});
  const r=await f.worker.fetch(request(undefined,undefined,{headers:{Origin:'https://mangahub.art'}}),env,f.ctx);await f.done();
  assert.equal(r.status,503);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://mangahub.art');assert.equal(r.headers.get('X-MangaHub-Origin'),null);
});
