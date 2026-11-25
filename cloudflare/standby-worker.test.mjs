import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createStandbyWorker} from './standby-worker.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const env={FAILOVER_ENABLED:'true',BALANCE_ENABLED:'true',BACKUP_ORIGIN:'https://standby.example',STANDBY_ORIGIN_SECRET:'fixture-origin-secret',HEALTH_PROBE_MODE:'operator'};
function request(host='api.mangahub.art',path='/api/manga/homepage',options={}) {
  const r=new Request('https://'+host+path,{...options,headers:{cookie:'mh_route=00000063',...options.headers}});
  Object.defineProperty(r,'cf',{value:{country:'VN',colo:'SIN'}});
  return r;
}
function setup({primary=true,backup=true,capacity=true,handle,latency}={}) {
  const calls=[], jobs=[];
  let clock=1000;
  const send=async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input;
    const u=new URL(r.url);
    if(latency)clock+=u.hostname==='standby.example'?latency.backup:latency.primary;
    const ready = typeof primary === 'function' ? primary() : primary;
    const backupReady = typeof backup === 'function' ? backup() : backup;
    if((u.hostname==='mangahub.art' && u.pathname==='/index.html') ||
       (u.hostname==='standby.example' && u.pathname==='/index.html')) {
      const ok = u.hostname==='mangahub.art' ? ready : backupReady;
      return new Response('<html>fixture</html>',{status:ok?200:503,headers:{'Content-Type':'text/html'}});
    }
    if(u.pathname==='/health'||u.pathname==='/auth/health')return Response.json({status:ready?'ok':'unavailable'},{status:ready?200:503});
    if(u.pathname==='/internal/origin-status') {
      assert.equal(r.headers.get('X-MangaHub-Origin-Secret'),env.STANDBY_ORIGIN_SECRET);
      return Response.json({status:backupReady?'ready':'unavailable',accept_extra:capacity,primary_frontend_ok:ready},{status:backupReady?200:503});
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

test('a measured faster standby raises the eligible share to 25 percent',async()=>{
  // Complete independent probes with controlled elapsed times, as in a real
  // network. Initiation itself must not advance the shared fake clock.
  let clock=1000;const jobs=[];
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input,u=new URL(r.url);
    if(u.pathname==='/index.html' || (u.hostname==='mangahub.art' && u.pathname==='/index.html'))
      return new Response('<html>fixture</html>',{headers:{'Content-Type':'text/html'}});
    if(u.pathname==='/internal/origin-status')return Response.json({status:'ready',accept_extra:true});
    if(u.pathname==='/health'||u.pathname==='/auth/health'){
      await new Promise(resolve=>setImmediate(resolve));clock+=1000;
      return Response.json({status:'ok'});
    }
    return new Response(u.hostname==='standby.example'?'backup':'primary');
  },()=>clock);
  const ctx={waitUntil:p=>jobs.push(p)};
  await worker.fetch(request(),env,ctx);await Promise.all(jobs);
  const r=await worker.fetch(request(undefined,undefined,{headers:{cookie:'mh_route=00000014'}}),env,ctx);
  assert.equal(await r.text(),'backup');
  const upper=await worker.fetch(request(undefined,undefined,{headers:{cookie:'mh_route=0000001e'}}),env,ctx);
  assert.equal(await upper.text(),'primary');
});

test('direct operator measurements recover on the next daily sample',async()=>{
  let ready=false;const f=setup({primary:()=>ready});
  const mutation=()=>request(undefined,undefined,{method:'POST',body:'once'});
  assert.equal(await(await f.worker.fetch(mutation(),env,f.ctx)).text(),'backup');
  ready=true;f.tick(24 * 60 * 60_000 + 1);
  assert.equal(await(await f.worker.fetch(mutation(),env,f.ctx)).text(),'primary');
});

test('an outage takes priority over the proactive capacity threshold',async()=>{
  const f=setup({primary:false,capacity:false});
  assert.equal(await(await f.worker.fetch(request(undefined,undefined,{method:'POST',body:'once'}),env,f.ctx)).text(),'backup');
});

test('a temporary test pin is restricted to its IP and expiry',async()=>{
  const f=setup();const pinned={...env,STANDBY_TEST_IP:'192.0.2.10',STANDBY_TEST_UNTIL:'61000'};
  const client=()=>request(undefined,undefined,{headers:{'CF-Connecting-IP':'192.0.2.10'}});
  assert.equal(await(await f.worker.fetch(client(),pinned,f.ctx)).text(),'backup');
  assert.equal(await(await f.worker.fetch(request(),pinned,f.ctx)).text(),'primary');
  f.tick(61_000);
  assert.equal(await(await f.worker.fetch(client(),pinned,f.ctx)).text(),'primary');await f.done();
});

test('private diagnostics reject anonymous, mutable and caller-selected targets',async()=>{
  const f=setup(),path='/internal/router-probe';
  assert.equal((await f.worker.fetch(request(undefined,path),env,f.ctx)).status,404);
  const headers={'X-MangaHub-Probe-Secret':env.STANDBY_ORIGIN_SECRET};
  assert.equal((await f.worker.fetch(request(undefined,path,{method:'POST',headers}),env,f.ctx)).status,405);
  assert.equal((await f.worker.fetch(request(undefined,path+'?target=https://elsewhere.invalid',{headers}),env,f.ctx)).status,400);
  assert.equal(f.calls.length,0);
});

for(const host of ['api.mangahub.art','auth.mangahub.art'])test(host+' preserves cookies and canonical identity on standby',async()=>{
  const f=setup({primary:false,handle:r=>{
    assert.equal(r.headers.get('X-MangaHub-Public-Host'),host);
    assert.match(r.headers.get('cookie'),/session=fixture/);
    return new Response('ok',{headers:{'Set-Cookie':'session=updated; Secure; HttpOnly'}});
  }});
  const r=await f.worker.fetch(request(host,'/auth/fixture',{method:'POST',body:'once',headers:{cookie:'session=fixture'}}),env,f.ctx);
  assert.match(r.headers.get('Set-Cookie'),/session=updated/);assert.equal(f.calls.length,1);
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

test('failed primary navigation redirects to standby preserving path and query',async()=>{
  const f=setup({handle:r=>new Response('page',{status:new URL(r.url).hostname==='mangahub.art'?503:200})});
  const r=await f.worker.fetch(request('mangahub.art','/chapter/fixture?page=8',{headers:{accept:'text/html'}}),env,f.ctx);
  await f.done();assert.equal(r.status,307);
  assert.equal(r.headers.get('Location'),'https://standby.mangahub.art/chapter/fixture?page=8');
});

test('direct standby navigation serves the VPS with canonical identity during an outage',async()=>{
  const f=setup({primary:false,handle:r=>{
    assert.equal(new URL(r.url).hostname,'standby.example');
    assert.equal(r.headers.get('X-MangaHub-Public-Host'),'mangahub.art');
    return new Response('<html>full site</html>',{headers:{'Content-Type':'text/html'}});
  }});
  const r=await f.worker.fetch(request('standby.mangahub.art','/manga/fixture',{headers:{accept:'text/html'}}),env,f.ctx);
  assert.equal(r.status,200);await f.done();
});

test('direct standby returns to a healthy primary when it offers no latency advantage',async()=>{
  const f=setup();
  const r=await f.worker.fetch(request('standby.mangahub.art','/chapter/fixture?page=5',{headers:{accept:'text/html'}}),env,f.ctx);
  assert.equal(r.status,307);
  assert.equal(r.headers.get('Location'),'https://mangahub.art/chapter/fixture?page=5');await f.done();
});

test('standby OAuth callback returns to the preferred primary with its code intact',async()=>{
  const f=setup();
  const r=await f.worker.fetch(request('standby.mangahub.art','/auth/callback?code=fixture',{headers:{accept:'text/html'}}),env,f.ctx);
  assert.equal(r.status,307);assert.equal(r.headers.get('Location'),'https://mangahub.art/auth/callback?code=fixture');await f.done();
});

test('a direct reader stays on a measured faster standby without needing a spare-share bucket',async()=>{
  const f=setup({latency:{primary:1000,backup:1}});
  const r=await f.worker.fetch(request('standby.mangahub.art','/manga/fixture',{headers:{accept:'text/html',cookie:'mh_route=00000063'}}),env,f.ctx);
  assert.equal(r.status,200);assert.equal(await r.text(),'backup');await f.done();
});

test('a faster but saturated standby returns a direct reader to the healthy primary',async()=>{
  const f=setup({capacity:false,latency:{primary:1000,backup:1}});
  const r=await f.worker.fetch(request('standby.mangahub.art','/manga/fixture',{headers:{accept:'text/html'}}),env,f.ctx);
  assert.equal(r.status,307);assert.equal(r.headers.get('Location'),'https://mangahub.art/manga/fixture');await f.done();
});

test('standby failure redirects navigation back to the healthy primary',async()=>{
  const f=setup({handle:r=>new Response('page',{status:new URL(r.url).hostname==='standby.example'?503:200})});
  const r=await f.worker.fetch(request('standby.mangahub.art','/manga/fixture',{headers:{accept:'text/html'}}),env,f.ctx);
  await f.done();assert.equal(r.status,307);assert.equal(r.headers.get('Location'),'https://mangahub.art/manga/fixture');
});

test('standby frontend retains CSRF and credentialed CORS on canonical API hosts',async()=>{
  const f=setup({handle:r=>{
    assert.equal(r.headers.get('Origin'),'https://mangahub.art');
    assert.equal(r.headers.get('X-MangaHub-CSRF'),'1');
    return new Response('once',{headers:{'Access-Control-Allow-Origin':'https://mangahub.art','Access-Control-Allow-Credentials':'true'}});
  }});
  const r=await f.worker.fetch(request('auth.mangahub.art','/auth/refresh',{method:'POST',body:'once',headers:{Origin:'https://standby.mangahub.art','X-MangaHub-CSRF':'1'}}),env,f.ctx);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://standby.mangahub.art');
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'),'true');assert.match(r.headers.get('Vary'),/Origin/);
  assert.equal(f.calls.length,1);
});

test('untrusted origins never receive the additional frontend trust',async()=>{
  const f=setup({handle:r=>{assert.equal(r.headers.get('Origin'),'https://untrusted.invalid');return new Response('denied',{status:403});}});
  const r=await f.worker.fetch(request('auth.mangahub.art','/auth/refresh',{method:'POST',body:'once',headers:{Origin:'https://untrusted.invalid'}}),env,f.ctx);
  assert.equal(r.status,403);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
});

test('private outage drill uses the standby without poisoning public health state',async()=>{
  const f=setup();
  const r=await f.worker.fetch(request(undefined,'/internal/router-probe?kind=drill',{headers:{'X-MangaHub-Probe-Secret':env.STANDBY_ORIGIN_SECRET}}),env,f.ctx);
  const value=await r.json();
  assert.equal(value.recovered,true);assert.equal(value.results.length,6);
  for (const failed of ['primary','backup']) {
    assert.equal(value.results.filter(r=>r.failed===failed).length,3);
    assert.equal(value.results.find(r=>r.failed===failed && r.service==='frontend').redirected,true);
  }
  assert.equal(await(await f.worker.fetch(request(),env,f.ctx)).text(),'primary');await f.done();
});

test('the retired port redirects before contacting either origin',async()=>{
  const f=setup();
  const r=await f.worker.fetch(request('standby.mangahub.art:8443','/chapter/fixture?page=2'),env,f.ctx);
  assert.equal(r.status,308);assert.equal(r.headers.get('Location'),'https://standby.mangahub.art/chapter/fixture?page=2');
  assert.equal(f.calls.length,0);
});

for(const path of ['/api/images/img?url=fixture','/api/manga/mangadex-cover/fixture','/api/manga/truyenqq/cover/fixture'])
test('healthy image origin retains its warm cache for '+path,async()=>{
  const f=setup();await f.worker.fetch(request(),env,f.ctx);await f.done();f.calls.length=0;
  const r=await f.worker.fetch(request('api.mangahub.art',path,{headers:{Cookie:'mh_route=00000000',Origin:'https://standby.mangahub.art'}}),env,f.ctx);
  assert.equal(await r.text(),'primary');assert.equal(f.calls.length,1);
});

test('image routing still falls back when Vercel fails',async()=>{
  const f=setup({handle:r=>new Response('image',{status:new URL(r.url).hostname==='api.mangahub.art'?503:200})});
  const r=await f.worker.fetch(request('api.mangahub.art','/api/images/img?url=fixture'),env,f.ctx);
  assert.equal(r.status,200);assert.equal(f.calls.length,2);await f.done();
});

for(const path of ['/internal/origin-status','/internal%2Forigin-status','/%69nternal/origin-status','//internal/origin-status'])
test('public standby never receives origin credentials for '+path,async()=>{
  const f=setup();const r=await f.worker.fetch(request('standby.mangahub.art',path),env,f.ctx);
  assert.equal(r.status,404);assert.equal(f.calls.length,0);
});

for(const provider of ['google','discord'])test(provider+' login from standby returns to its exact callback, preserving PKCE and cookies',async()=>{
  const f=setup({handle:()=>Response.json({url:'https://project.supabase.co/auth/v1/authorize?provider='+provider+'&redirect_to=https%3A%2F%2Fmangahub.art%2Fauth%2Fcallback&code_challenge=fixture-challenge&code_challenge_method=s256'},
    {headers:{'Set-Cookie':'mh_oauth_code_verifier=fixture; Secure; HttpOnly; Path=/auth'}})});
  const r=await f.worker.fetch(request('auth.mangahub.art','/auth/'+provider,{method:'POST',body:'{}',headers:{Origin:'https://standby.mangahub.art','X-MangaHub-CSRF':'1'}}),env,f.ctx);
  const link=new URL((await r.json()).url);
  assert.equal(link.origin,'https://project.supabase.co');
  assert.equal(link.searchParams.get('redirect_to'),'https://standby.mangahub.art/auth/callback');
  assert.equal(link.searchParams.get('code_challenge'),'fixture-challenge');
  assert.equal(link.searchParams.get('code_challenge_method'),'s256');
  assert.match(r.headers.get('Set-Cookie'),/mh_oauth_code_verifier=fixture; Secure; HttpOnly; Path=\/auth/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);assert.equal(f.calls.length,1);
});

test('a primary callback stays on its starting frontend even when standby is preferred',async()=>{
  const f=setup();
  const pinned={...env,STANDBY_TEST_IP:'192.0.2.10',STANDBY_TEST_UNTIL:'61000'};
  const r=await f.worker.fetch(request('mangahub.art','/auth/callback?code=fixture',{headers:{accept:'text/html','CF-Connecting-IP':'192.0.2.10'}}),pinned,f.ctx);
  assert.equal(r.status,200);assert.equal(r.headers.get('Location'),null);
});

function redirectCookies(response) {
  return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
}

test('different isolates cannot bounce a reader back after an outage redirect, including old affinity cookies',async()=>{
  const source=setup({primary:false}), destination=setup();
  const first=await source.worker.fetch(request('mangahub.art','/manga/book-123?chapter=4',
    {headers:{accept:'text/html',cookie:'mh_route=00000000'}}),env,source.ctx);
  await source.done();
  // A cold first GET can discover the outage on its actual read instead of a probe.
  const redirect=first.status===307?first:await source.worker.fetch(request('mangahub.art','/manga/book-123?chapter=4',
    {headers:{accept:'text/html',cookie:'mh_route=00000000'}}),env,source.ctx);
  assert.equal(redirect.status,307);
  const cookies='mh_route=00000000; '+redirectCookies(redirect);
  const second=await destination.worker.fetch(request('standby.mangahub.art','/manga/book-123?chapter=4',
    {headers:{accept:'text/html',cookie:cookies}}),env,destination.ctx);
  assert.equal(second.status,200);assert.equal(await second.text(),'backup');
  assert.equal(second.headers.get('Location'),null);await destination.done();
});

test('return to primary is honored by an isolate that still considers standby faster',async()=>{
  const source=setup(), destination=setup({latency:{primary:1000,backup:1}});
  const redirect=await source.worker.fetch(request('standby.mangahub.art','/manga/book-123',
    {headers:{accept:'text/html'}}),env,source.ctx);
  assert.equal(redirect.status,307);
  await destination.worker.fetch(request(),env,destination.ctx);await destination.done();
  const second=await destination.worker.fetch(request('mangahub.art','/manga/book-123',
    {headers:{accept:'text/html',cookie:'mh_route=00000000; '+redirectCookies(redirect)}}),env,destination.ctx);
  assert.equal(second.status,200);assert.equal(await second.text(),'primary');
});

test('a leased primary still fails over on a real read error without replaying writes',async()=>{
  const source=setup();
  const redirect=await source.worker.fetch(request('standby.mangahub.art','/manga/book-123',
    {headers:{accept:'text/html'}}),env,source.ctx);
  const destination=setup({handle:r=>new Response('page',{status:new URL(r.url).hostname==='mangahub.art'?503:200})});
  const second=await destination.worker.fetch(request('mangahub.art','/manga/book-123',
    {headers:{accept:'text/html',cookie:redirectCookies(redirect)}}),env,destination.ctx);
  assert.equal(second.status,307);assert.equal(new URL(second.headers.get('Location')).hostname,'standby.mangahub.art');
  const final=await source.worker.fetch(request('standby.mangahub.art','/manga/book-123',
    {headers:{accept:'text/html',cookie:redirectCookies(second)}}),env,source.ctx);
  assert.equal(final.status,200);await destination.done();await source.done();
});

test('route decisions expire automatically and invalid routing cookies do not grant a lease',async()=>{
  const f=setup({latency:{primary:1000,backup:1}});
  const page=await f.worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html'}}),env,f.ctx);
  const cookie=redirectCookies(page);
  const destination=setup();destination.tick(10_000); // Align the independent fake clock after simulated probes.
  let r=await destination.worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html',cookie}}),env,destination.ctx);
  assert.equal(r.status,200);
  destination.tick(121_000);
  r=await destination.worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html',cookie}}),env,destination.ctx);
  assert.equal(r.status,307);
  r=await destination.worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html',cookie:cookie.replace(/.$/,'z')}}),env,destination.ctx);
  assert.equal(r.status,307);await f.done();await destination.done();
});


test('new isolates share the saved daily result without issuing origin health probes',async()=>{
  const calls=[];
  const snapshot={checkedAt:900,primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:true,milliseconds:9999}])),backup:{ok:true,capacity:true}};
  const shared={...env,DAILY_HEALTH_SHARED:'true'};
  function instance(){
    let clock=1000;const jobs=[];
    const worker=createStandbyWorker(async(input,options={})=>{
      const r=typeof input==='string'?new Request(input,options):input,u=new URL(r.url);calls.push(u.pathname);
      if(u.pathname==='/internal/router-health'){
        assert.equal(r.headers.get('X-MangaHub-Origin-Secret'),env.STANDBY_ORIGIN_SECRET);
        return Response.json(snapshot);
      }
      assert.equal(r.headers.has('X-MangaHub-Origin-Secret'),false);
      assert.equal(u.pathname,'/api/history/');
      return new Response('primary');
    },()=>clock);
    return {worker,ctx:{waitUntil:p=>jobs.push(p)},done:async()=>{await Promise.all(jobs)},tick:ms=>clock+=ms};
  }
  for(let i=0;i<3;i++){
    const f=instance();
    for(let j=0;j<5;j++){
      const r=await f.worker.fetch(request(undefined,'/api/history/'),shared,f.ctx);
      assert.equal(await r.text(),'primary');await f.done();
    }
    f.tick(61000);
    await f.worker.fetch(request(undefined,'/api/history/'),shared,f.ctx);await f.done();
  }
  assert.equal(calls.filter(p=>p==='/internal/router-health').length,6);
  assert.equal(calls.filter(p=>['/health','/auth/health','/internal/origin-status','/index.html'].includes(p)).length,0);
});

test('a real outage overrides the daily snapshot and an unchanged file cannot undo it',async()=>{
  let clock=1000;const jobs=[],calls=[];
  const snapshot={checkedAt:900,primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:true}])),backup:{ok:true,capacity:true}};
  const shared={...env,DAILY_HEALTH_SHARED:'true'};
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input,u=new URL(r.url);
    if(u.pathname==='/internal/router-health')return Response.json(snapshot);
    calls.push(u.hostname);
    return new Response(u.hostname==='standby.example'?'backup':'failed',{status:u.hostname==='standby.example'?200:503});
  },()=>clock);
  const ctx={waitUntil:p=>jobs.push(p)},done=async()=>{await Promise.all(jobs.splice(0))};
  assert.equal(await(await worker.fetch(request(),shared,ctx)).text(),'backup');await done();
  assert.deepEqual(calls,['api.mangahub.art','standby.example']);calls.length=0;
  clock+=61000;
  assert.equal(await(await worker.fetch(request(),shared,ctx)).text(),'backup');await done();
  assert.deepEqual(calls,['standby.example']);
});

test('missing shared metadata does not launch probes or block a healthy read',async()=>{
  const calls=[],jobs=[];
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input,path=new URL(r.url).pathname;calls.push(path);
    return new Response(path==='/internal/router-health'?'missing':'reader',{status:path==='/internal/router-health'?404:200});
  },()=>1000);
  const r=await worker.fetch(request(),{...env,DAILY_HEALTH_SHARED:'true'},{waitUntil:p=>jobs.push(p)});
  assert.equal(await r.text(),'reader');await Promise.all(jobs);
  assert.deepEqual(calls.sort(),['/api/manga/homepage','/internal/router-health'].sort());
});

test('a cold source access check uses the saved standby decision before its single policy read',async()=>{
  const calls=[];
  const snapshot={checkedAt:900,primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:false}])),backup:{ok:true,capacity:true}};
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input,u=new URL(r.url);
    calls.push(u.pathname);
    if(u.pathname==='/internal/router-health'){
      await new Promise(resolve=>setImmediate(resolve));
      return Response.json(snapshot);
    }
    assert.equal(u.hostname,'standby.example');
    assert.equal(u.pathname,'/internal/source-access');
    assert.equal(r.headers.get('Authorization'),'AccessTicket fixture');
    assert.equal(r.headers.get('X-MangaHub-Origin-Secret'),env.STANDBY_ORIGIN_SECRET);
    return Response.json({enabled:true,allowed:true,authenticated:true});
  },()=>1000);
  // Service-binding requests do not carry a browser's country metadata.
  const result=await worker.fetch(new Request('https://api.mangahub.art/api/site-access',{headers:{Authorization:'AccessTicket fixture'}}),
    {...env,DAILY_HEALTH_SHARED:'true'},{waitUntil:()=>{}});
  assert.equal(result.status,200);
  assert.deepEqual(calls,['/internal/router-health','/internal/source-access']);
});

test('Vercel deployment-disabled 402 fails over a read and remembers the outage',async()=>{
  const f=setup({handle:r=>new URL(r.url).hostname==='standby.example' ? new Response('backup') :
    new Response('paused',{status:402,headers:{'X-Vercel-Error':'DEPLOYMENT_DISABLED'}})});
  assert.equal(await(await f.worker.fetch(request(),env,f.ctx)).text(),'backup');await f.done();
  assert.equal(f.calls.length,2);
  f.calls.length=0;
  assert.equal(await(await f.worker.fetch(request(),env,f.ctx)).text(),'backup');
  assert.equal(f.calls.length,1);
  assert.equal(new URL(f.calls[0].url).hostname,'standby.example');
});

test('an ordinary application 402 passes through without a standby retry',async()=>{
  const f=setup({handle:()=>new Response('payment required by app',{status:402})});
  assert.equal((await f.worker.fetch(request(),env,f.ctx)).status,402);await f.done();
  assert.equal(f.calls.length,1);
});

test('a submitted write is not replayed after Vercel pauses, and the next write uses standby',async()=>{
  const f=setup({handle:r=>new URL(r.url).hostname==='standby.example' ? new Response('written once') :
    new Response('paused',{status:402,headers:{'X-Vercel-Error':'DEPLOYMENT_DISABLED'}})});
  const write=()=>request(undefined,'/api/bookmarks/',{method:'POST',body:'one-write'});
  assert.equal((await f.worker.fetch(write(),env,f.ctx)).status,402);
  assert.equal(f.calls.length,1);
  assert.equal(await(await f.worker.fetch(write(),env,f.ctx)).text(),'written once');
  assert.equal(f.calls.length,2);
  assert.equal(new URL(f.calls[1].url).hostname,'standby.example');
});

test('an observed primary outage overrides an existing signed primary navigation lease',async()=>{
  const source=setup();
  const redirect=await source.worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html'}}),env,source.ctx);
  const cookie=redirectCookies(redirect);
  const snapshot={checkedAt:900,primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:false}])),backup:{ok:true,capacity:true}};
  const jobs=[];
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input;
    if(new URL(r.url).pathname==='/internal/router-health')return Response.json(snapshot);
    assert.equal(new URL(r.url).hostname,'standby.example');
    return new Response('<html>backup</html>',{headers:{'Content-Type':'text/html'}});
  },()=>1000);
  const result=await worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html',cookie}}),
    {...env,DAILY_HEALTH_SHARED:'true'},{waitUntil:p=>jobs.push(p)});
  assert.equal(result.status,200);
  assert.equal(result.headers.get('Location'),null);
  await Promise.all(jobs);await source.done();
});

test('a cold connection can read the saved daily decision without performing health probes',async()=>{
  const calls=[];
  const snapshot={checkedAt:900,primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:false}])),backup:{ok:true,capacity:true}};
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input;
    calls.push(new URL(r.url).pathname);
    if(new URL(r.url).pathname==='/internal/router-health') {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,650);
        const signal=options.signal||r.signal;
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});
      });
      return Response.json(snapshot);
    }
    assert.equal(new URL(r.url).hostname,'standby.example');
    return new Response('<html>backup</html>',{headers:{'Content-Type':'text/html'}});
  },()=>1000);
  const result=await worker.fetch(request('standby.mangahub.art','/',{headers:{accept:'text/html'}}),
    {...env,DAILY_HEALTH_SHARED:'true'},{waitUntil:()=>{}});
  assert.equal(result.status,200);
  assert.equal(result.headers.get('Location'),null);
  assert.deepEqual(calls,['/internal/router-health','/']);
});

test('returns standby navigation to Vercel when the next saved daily decision confirms recovery',async()=>{
  let clock=1000,healthy=false;
  const calls=[];
  const worker=createStandbyWorker(async(input,options={})=>{
    const r=typeof input==='string'?new Request(input,options):input;
    const path=new URL(r.url).pathname;calls.push(path);
    if(path==='/internal/router-health')return Response.json({checkedAt:clock-100,
      primary:Object.fromEntries(['mangahub.art','api.mangahub.art','auth.mangahub.art'].map(h=>[h,{ok:healthy}])),backup:{ok:true,capacity:true}});
    return new Response('<html>backup</html>',{headers:{'Content-Type':'text/html'}});
  },()=>clock);
  const shared={...env,DAILY_HEALTH_SHARED:'true'};
  const navigation=()=>request('standby.mangahub.art','/chapter/qq--book-1--2',{headers:{accept:'text/html'}});
  assert.equal((await worker.fetch(navigation(),shared,{waitUntil:()=>{}})).status,200);
  healthy=true;clock+=24*60*60*1000;
  const recovery=await worker.fetch(navigation(),shared,{waitUntil:()=>{}});
  assert.equal(recovery.status,307);
  assert.equal(recovery.headers.get('Location'),'https://mangahub.art/chapter/qq--book-1--2');
  assert.deepEqual(calls,['/internal/router-health','/chapter/qq--book-1--2','/internal/router-health']);
});
