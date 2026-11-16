// Temporary aggregate-only read. Never output raw events, query strings,
// headers, cookies, addresses, tokens or resource/account identifiers.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/`;
const duration = 90_000;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(path, method, body) {
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000) });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(`API ${response.status}`);
  return value.result;
}
function pathGroup(path) {
  for (const prefix of ['/api/manga/truyenqq/image/', '/api/manga/truyenqq/cover/', '/api/manga/mangadex-cover/',
    '/assets/', '/api/users/', '/manga/', '/chapter/']) {
    if (path.startsWith(prefix)) return prefix + '*';
  }
  if (path.startsWith('/api/truyenqq-edge/truyen-tranh/')) return '/api/truyenqq-edge/truyen-tranh/*';
  if (path.startsWith('/api/mangadex-edge/chapter/')) return '/api/mangadex-edge/chapter/*';
  return path.replace(/\/[0-9a-f]{8}(?:-[0-9a-f-]+)?(?=\/|$)/gi, '/:id');
}
async function observe(script) {
  const counts = new Map(), addresses = new Set();
  let tail, socket, total = 0, unclassified = 0;
  try {
    tail = await api(`${script}/tails`, 'POST', { filters: [] });
    const started = Date.now();
    await new Promise(resolve => {
      socket = new WebSocket(tail.url, 'trace-v1');
      socket.binaryType = 'arraybuffer';
      const timer = setTimeout(resolve, duration);
      socket.addEventListener('message', message => {
        try {
          const raw = typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data);
          const value = JSON.parse(raw);
          const request = value.event?.request;
          total++;
          if (!request?.url) { unclassified++; return; }
          const url = new URL(request.url), h = new Headers(request.headers || {});
          const address = h.get('CF-Connecting-IP');
          if (address) addresses.add(address);
          const row = { host: url.hostname, path: pathGroup(url.pathname), method: request.method,
            status: value.event?.response?.status ?? null,
            ownedOrigin: ['https://mangahub.art','https://standby.mangahub.art'].includes(h.get('Origin')),
            workerHop: Boolean(h.get('CF-Worker')) };
          const key = JSON.stringify(row);
          counts.set(key, (counts.get(key) || 0) + 1);
        } catch { unclassified++; }
      });
      const finish = () => { clearTimeout(timer); resolve(); };
      socket.addEventListener('error', finish);
      socket.addEventListener('close', finish);
    });
    console.log(JSON.stringify({ script, observedSeconds: Math.round((Date.now() - started) / 1000),
      total, unclassified, distinctConnectingAddresses: addresses.size,
      top: [...counts].sort((a,b) => b[1]-a[1]).slice(0,40).map(([key,requests]) => ({...JSON.parse(key),requests})) }));
  } catch (error) {
    console.log(JSON.stringify({ script, diagnostic: error.message.startsWith('API ') ? error.message : 'tail-unavailable' }));
  } finally {
    socket?.close();
    if (tail?.id) await api(`${script}/tails/${tail.id}`, 'DELETE').catch(() => {});
  }
}
await Promise.all(['mangahub-standby-router', 'mangahub-mangadex-edge'].map(observe));
// The server can keep a closing tail socket alive after returning its final
// summary. All tail deletion calls above have completed; no work remains.
process.exit(0);
