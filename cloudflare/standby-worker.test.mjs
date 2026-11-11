import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStandbyWorker } from './standby-worker.js';
const env = { FAILOVER_ENABLED:'true', BACKUP_ORIGIN:'https://standby.mangahub.art', STANDBY_ORIGIN_SECRET:'test-secret' };
const hosts = ['mangahub.art','api.mangahub.art','auth.mangahub.art'];
const state = modes => new Response(JSON.stringify({modes,updated_at:Date.now()/1000}), {headers:{'content-type':'application/json'}});
const request = (path='https://api.mangahub.art/api/history/', init={}) => {
 const r=new Request(path,init);Object.defineProperty(r,'cf',{value:{country:'VN'},configurable:true});return r;
};
function context(){const pending=[];return {waitUntil:p=>pending.push(p),done:()=>Promise.all(pending)}}
function fixture(callback, modes=Object.fromEntries(hosts.map(h=>[h,'primary']))) {
 const calls=[],ctx=context();
 const worker=createStandbyWorker(async (r,init) => {
  const url=typeof r==='string'?r:r.url;
  if(url.endsWith('/internal/standby-control')&&(!init?.method||init.method==='GET')) return state(modes);
  calls.push({r,init,url});return callback(r,init);
 });
 return {worker,calls,ctx};
}
test('healthy Vercel requests never wait for a routing-control fetch', async()=>{
 const ctx=context();let release;
 const w=createStandbyWorker(async r=>typeof r==='string'?new Promise(resolve=>{release=resolve}):new Response('primary'));
 const response=await w.fetch(request(),env,ctx);
 assert.equal(await response.text(),'primary');assert.equal(response.headers.get('x-mangahub-origin'),'vercel');
 release(state(Object.fromEntries(hosts.map(h=>[h,'primary']))));await ctx.done();
});
test('safe reads fail over on gateway failure and retain auth, query, cookies and public hostname',async()=>{
 const {worker,calls,ctx}=fixture(async r=>new URL(r.url).hostname.startsWith('standby')?new Response('backup',{headers:{'Set-Cookie':'__Host-mh_access_v2=fixture; Secure; Path=/'}}):new Response('down',{status:502}));
 const response=await worker.fetch(request('https://api.mangahub.art/api/manga?page=70',{headers:{Authorization:'Bearer fixture',Cookie:'session=fixture','CF-Connecting-IP':'203.0.113.2','X-Forwarded-For':'forged'}}),env,ctx);
 assert.equal(await response.text(),'backup');assert.equal(calls.length,2);
 const backup=calls[1].r;assert.equal(backup.url,'https://standby.mangahub.art/api/manga?page=70');
 assert.equal(backup.headers.get('authorization'),'Bearer fixture');assert.equal(backup.headers.get('cookie'),'session=fixture');
 assert.equal(backup.headers.get('x-mangahub-public-host'),'api.mangahub.art');assert.equal(backup.headers.get('x-forwarded-for'),null);
 assert.equal(backup.headers.get('x-mangahub-client-ip'),'203.0.113.2');assert.equal(backup.redirect,'manual');
 assert.match(response.headers.get('set-cookie'),/__Host-mh_access/);await ctx.done();
});
for(const status of [401,403,404,429]) test('does not hide application response '+status,async()=>{
 const {worker,calls,ctx}=fixture(async()=>new Response('policy',{status}));
 assert.equal((await worker.fetch(request(),env,ctx)).status,status);assert.equal(calls.length,1);await ctx.done();
});
for(const method of ['POST','PUT','PATCH','DELETE']) test('never replays '+method+' after a 5xx',async()=>{
 const {worker,calls,ctx}=fixture(async()=>new Response('may have committed',{status:503}));
 const response=await worker.fetch(request(undefined,{method,body:'fixture'}),env,ctx);
 assert.equal(response.status,503);assert.equal(calls.length,1);await ctx.done();
});
test('routes new mutations straight to the selected backup without touching Vercel',async()=>{
 const {worker,calls,ctx}=fixture(async r=>new Response(await r.text()),Object.fromEntries(hosts.map(h=>[h,'backup'])));
 await worker.fetch(request(),env,ctx);await ctx.done();calls.length=0;
 const response=await worker.fetch(request('https://auth.mangahub.art/auth/login',{method:'POST',body:'one-login',headers:{'x-mangahub-csrf':'1'}}),env,ctx);
 assert.equal(await response.text(),'one-login');assert.equal(calls.length,1);assert.match(calls[0].url,/standby/);
 assert.equal(calls[0].r.headers.get('x-mangahub-csrf'),'1');
});
test('country restriction keeps the existing blocked frontend page',async()=>{
 const {worker,calls,ctx}=fixture(async()=>new Response('unexpected'));
 const r=request('https://mangahub.art/',{headers:{Accept:'text/html'}});Object.defineProperty(r,'cf',{value:{country:'AU'}});
 const response=await worker.fetch(r,env,ctx);assert.equal(response.status,403);assert.match(await response.text(),/MangaHub/);assert.equal(calls.length,0);
});
test('probes each original hostname and updates private routing control only after backup readiness',async()=>{
 const calls=[];
 const worker=createStandbyWorker(async(r,init)=>{calls.push({url:r,init});if(r.endsWith('standby-health'))return new Response('{"status":"ready"}');if(init?.method==='POST')return new Response('{}');return new Response('ok',{headers:{'content-type':'text/html'}})});
 await worker.scheduled({},env,context());
 assert.equal(calls.length,5);assert.equal(calls[4].init.method,'POST');
 assert.deepEqual(JSON.parse(calls[4].init.body).health,Object.fromEntries(hosts.map(h=>[h,true])));
 assert.equal(calls[4].init.headers['X-MangaHub-Origin-Secret'],'test-secret');
});
test('does not switch traffic to an unready backup',async()=>{
 let count=0;const worker=createStandbyWorker(async()=>{count++;return new Response('not ready',{status:503})});
 await worker.scheduled({},env,context());assert.equal(count,1);
});

test('keeps routing unchanged until activation is explicitly enabled',async()=>{
 const {worker,calls,ctx}=fixture(async()=>new Response('vercel'));
 assert.equal(await (await worker.fetch(request(),{...env,FAILOVER_ENABLED:'false'},ctx)).text(),'vercel');
 assert.equal(calls.length,1);
 await worker.scheduled({},{...env,FAILOVER_ENABLED:'false'},ctx);assert.equal(calls.length,1);
});
