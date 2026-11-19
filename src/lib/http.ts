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
    let canRetryFailure = true;
    const send = async (target: string) => {
      canRetryFailure = true;
      const leg = route ? new AbortController() : controller;
      const stopLeg = () => leg.abort(controller.signal.reason);
      if (route) {
        if (controller.signal.aborted) stopLeg();
        else controller.signal.addEventListener('abort', stopLeg, { once: true });
      }
      // Switch origins only when an image stops making progress. A fixed leg
      // deadline restarted large but healthy downloads on slower connections.
      let legTimer: ReturnType<typeof setTimeout> | undefined;
      const progress = () => {
        if (!route) return;
        clearTimeout(legTimer);
        legTimer = setTimeout(() => leg.abort(), Math.min(6_000, timeoutMs));
      };
      progress();
      try {
        const response = await fetch(target, { credentials: 'include', ...options, signal: leg.signal });
        canRetryFailure = response.ok && !!response.headers.get('Content-Type')?.startsWith('image/') || failedImageHost(response);
        let bytes: BodyInit | null = null;
        if (route && response.body) {
          progress();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.byteLength) { chunks.push(value);size += value.byteLength;progress(); }
            }
            const joined = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset);offset += chunk.byteLength; }
            bytes = joined.buffer;
          } finally { reader.releaseLock(); }
        } else bytes = response.body ? await response.arrayBuffer() : null;
        const result = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperty(result, 'url', { value: response.url });
        return result;
      } finally {
        if (legTimer !== undefined) clearTimeout(legTimer);
        if (route) controller.signal.removeEventListener('abort', stopLeg);
      }
    };
    let response: Response;
    let retried = false;
    try {
      response = await send(first);
    } catch (error) {
      if (!route || controller.signal.aborted || !canRetryFailure) throw error;
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
    return response;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
