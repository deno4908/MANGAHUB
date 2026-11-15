import { failedImageHost, imageOriginRoute, rememberImageOrigin } from './imageOrigin';

/** Complete API responses within a deadline, respecting caller cancellation. */
export async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const route = imageOriginRoute(url, options.method);
    const first = route?.preferBackup ? route.backup : url;
    const send = (target: string) => fetch(target, { credentials: 'include', ...options, signal: controller.signal });
    let response: Response;
    let retried = false;
    try {
      response = await send(first);
    } catch (error) {
      if (!route || controller.signal.aborted) throw error;
      // Only fixed, application-owned image GET/HEAD endpoints can be retried.
      retried = true;
      response = await send(route.preferBackup ? route.primary : route.backup);
      if (response.ok && response.headers.get('Content-Type')?.startsWith('image/')) rememberImageOrigin(!route.preferBackup);
    }
    if (route && !retried && failedImageHost(response) && !controller.signal.aborted) {
      const original = response;
      try {
        const alternative = await send(route.preferBackup ? route.primary : route.backup);
        if (alternative.ok && alternative.headers.get('Content-Type')?.startsWith('image/')) {
          await original.body?.cancel();response = alternative;
          rememberImageOrigin(!route.preferBackup);
        } else await alternative.body?.cancel();
      } catch { /* Preserve the original response and its diagnostics. */ }
    }
    // fetch() resolves at headers. Keep the deadline until the API body has
    // arrived too, so a stalled JSON body cannot leave a query pending forever.
    const bytes = response.body ? await response.arrayBuffer() : null;
    const result = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(result, 'url', { value: response.url });
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
