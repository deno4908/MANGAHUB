import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './http';
import { imageOriginRoute, rememberImageOrigin } from './imageOrigin';
const url = 'https://api.mangahub.art/api/images/img?url=https%3A%2F%2Fuploads.mangadex.org%2Fpage.jpg';
const backup = url.replace('api.mangahub.art', 'standby.mangahub.art');
const image = () => new Response('bytes', { headers: { 'Content-Type': 'image/jpeg' } });
afterEach(() => { rememberImageOrigin(false);vi.unstubAllGlobals();vi.useRealTimers(); });
it('healthy reading uses one original request and preserves image bytes and headers', async () => {
  const send=vi.fn().mockResolvedValue(image());vi.stubGlobal('fetch',send);
  const r=await fetchWithTimeout(url, {headers:{Authorization:'Bearer test'}},1000);
  expect(await r.text()).toBe('bytes');expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toBe(url);
});
it('fails over one image read and shares a bounded preference with the following images', async () => {
  vi.useFakeTimers();
  const send=vi.fn().mockResolvedValueOnce(new Response('down',{status:502})).mockImplementation(async()=>image());vi.stubGlobal('fetch',send);
  expect(await (await fetchWithTimeout(url, {headers:{Authorization:'Bearer test'}})).text()).toBe('bytes');
  expect(send.mock.calls.map(x=>x[0])).toEqual([url,backup]);
  expect(new Headers(send.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer test');
  await fetchWithTimeout(url, {});expect(send.mock.calls[2][0]).toBe(backup);
  await vi.advanceTimersByTimeAsync(60_001);await fetchWithTimeout(url,{});expect(send.mock.calls[3][0]).toBe(url);
});
it('recovers back to the primary when the standby connection fails, with at most one retry', async () => {
  rememberImageOrigin(true);
  const send=vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(image());vi.stubGlobal('fetch',send);
  await fetchWithTimeout(url,{});expect(send.mock.calls.map(x=>x[0])).toEqual([backup,url]);
  expect(imageOriginRoute(url)?.preferBackup).toBe(false);
});
it.each([401,403,404,429])('keeps authorization, missing image and rate limit status %s intact', async status=>{
  const send=vi.fn().mockResolvedValue(new Response('error',{status}));vi.stubGlobal('fetch',send);
  expect((await fetchWithTimeout(url,{})).status).toBe(status);expect(send).toHaveBeenCalledTimes(1);
});
it('leaves QQ source recovery on its original host and never retries writes or external URLs', async()=>{
  const send=vi.fn().mockImplementation(async()=>new Response('blocked',{status:503,headers:{'X-TruyenQQ-Error':'http-403'}}));vi.stubGlobal('fetch',send);
  await fetchWithTimeout(url,{});expect(send).toHaveBeenCalledTimes(1);
  for(const target of ['https://external.example/api/images/img','https://api.mangahub.art/api/manga/homepage','https://api.mangahub.art.evil.example/api/images/img']) expect(imageOriginRoute(target)).toBeNull();
  expect(imageOriginRoute(url,'POST')).toBeNull();expect(imageOriginRoute(url.replace('/api/images/img','/internal/origin-status'))).toBeNull();
});
it('does not retry an aborted request or repeat a failed alternate', async()=>{
  const controller=new AbortController();
  const send=vi.fn().mockImplementation(async()=>{controller.abort();throw new DOMException('Aborted','AbortError');});vi.stubGlobal('fetch',send);
  await expect(fetchWithTimeout(url,{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(send).toHaveBeenCalledTimes(1);
  send.mockReset().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('down',{status:502}));
  expect((await fetchWithTimeout(url,{})).status).toBe(502);expect(send).toHaveBeenCalledTimes(2);
});

it('does not replace an image host failure with a successful HTML challenge', async()=>{
 const send=vi.fn().mockResolvedValueOnce(new Response('down',{status:502})).mockResolvedValueOnce(new Response('<html>challenge</html>',{headers:{'Content-Type':'text/html'}}));
 vi.stubGlobal('fetch',send);
 expect((await fetchWithTimeout(url,{})).status).toBe(502);expect(imageOriginRoute(url)?.preferBackup).toBe(false);
});


it('recovers a stalled image body at the alternate origin within the same total deadline', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementationOnce(async (_url, options) => new Response(new ReadableStream({
    start(stream) { options.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted','AbortError'))); },
  }), { headers: { 'Content-Type':'image/jpeg' } })).mockResolvedValueOnce(image());
  vi.stubGlobal('fetch',send);
  const pending = fetchWithTimeout(url, {}, 25_000);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await(await pending).text()).toBe('bytes');
  expect(send.mock.calls.map(x=>x[0])).toEqual([url,backup]);
  expect(imageOriginRoute(url)?.preferBackup).toBe(true);
});

it('never retries an authorization response whose body stalls', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementation(async (_url, options) => new Response(new ReadableStream({
    start(stream) { options.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted','AbortError'))); },
  }), { status:403 }));
  vi.stubGlobal('fetch',send);
  const pending = expect(fetchWithTimeout(url, {}, 25_000)).rejects.toMatchObject({name:'AbortError'});
  await vi.advanceTimersByTimeAsync(6_000);await pending;
  expect(send).toHaveBeenCalledTimes(1);
});

it('finishes a slow but progressing image without restarting it at another origin', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementation(async (_url, options) => new Response(new ReadableStream({
    start(stream) {
      let chunks = 0;
      const timer = setInterval(() => {
        stream.enqueue(new TextEncoder().encode('part'));
        if (++chunks === 4) { clearInterval(timer);stream.close(); }
      }, 5_000);
      options.signal.addEventListener('abort', () => { clearInterval(timer);stream.error(new DOMException('Aborted','AbortError')); });
    },
  }), { headers: { 'Content-Type':'image/jpeg' } }));
  vi.stubGlobal('fetch',send);
  const pending = fetchWithTimeout(url, {}, 25_000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await(await pending).text()).toBe('partpartpartpart');
  expect(send).toHaveBeenCalledTimes(1);
  expect(imageOriginRoute(url)?.preferBackup).toBe(false);
});

it('keeps the total image deadline even when bytes continue arriving', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementation(async (_url, options) => new Response(new ReadableStream({
    start(stream) {
      const timer = setInterval(() => stream.enqueue(new Uint8Array([1])), 5_000);
      options.signal.addEventListener('abort', () => { clearInterval(timer);stream.error(new DOMException('Aborted','AbortError')); });
    },
  }), { headers: { 'Content-Type':'image/jpeg' } }));
  vi.stubGlobal('fetch',send);
  const pending = expect(fetchWithTimeout(url, {}, 25_000)).rejects.toMatchObject({name:'AbortError'});
  await vi.advanceTimersByTimeAsync(25_000);await pending;
  expect(send).toHaveBeenCalledTimes(1);
});
