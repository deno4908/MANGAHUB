/** Complete API responses within a deadline, respecting caller cancellation. */
export async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'include', ...options, signal: controller.signal });
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
