// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './http';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps the timeout active after headers while the body is stalled', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  }))));
  const request = fetchWithTimeout('https://api.example/data', {}, 1000);
  const failed = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
});

it('propagates caller abort and preserves status and headers', async () => {
  const controller = new AbortController();
  let outgoing: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    outgoing = options.signal;
    return new Response('{"ok":true}', { status: 201, headers: { 'X-Test': 'yes' } });
  }));
  const response = await fetchWithTimeout('https://api.example/data', { signal: controller.signal });
  expect(response.status).toBe(201);
  expect(response.headers.get('X-Test')).toBe('yes');
  expect(await response.json()).toEqual({ ok: true });
  controller.abort();
  expect(outgoing!.aborted).toBe(false); // listener cleaned up after completion
  const cancelled = new AbortController();
  cancelled.abort();
  await fetchWithTimeout('https://api.example/data', { signal: cancelled.signal });
  expect(outgoing!.aborted).toBe(true);
});
