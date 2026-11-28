// Operator-only, temporary diagnostic. Never attach this module to website routes.
import { fetchQQOrigin } from './mangadex-edge-worker.js';

const CASES = Object.freeze({
  latest: '/truyen-moi-cap-nhat',
  detail: '/truyen-tranh/xin-loi-vi-toi-khong-the-roi-mat-khoi-ve-ngoai-cua-ngai-17629',
});

export function createSourceDiagnostic(read = fetchQQOrigin) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url), name = url.searchParams.get('case');
      if (!env.OPERATOR_PROBE_SECRET || request.headers.get('X-MangaHub-Source-Probe') !== env.OPERATOR_PROBE_SECRET)
        return new Response('Not found', { status: 404 });
      if (request.method !== 'GET' || url.pathname !== '/' || [...url.searchParams].length !== 1 ||
          !Object.hasOwn(CASES, name)) return new Response('Not found', { status: 404 });
      const started = Date.now();
      try {
        // Only two fixed public source pages are reachable. No caller-selected
        // URL, cookie, application token or diagnostic credential crosses here.
        const result = await read(CASES[name], '');
        const headers = new Headers(result.headers);
        const challenge = /cf-chl-|challenge-platform|Just a moment/i.test(result.body);
        const valid = result.status === 200 && !challenge &&
          (name === 'latest' ? /list_grid/.test(result.body) : /book_info/.test(result.body));
        return Response.json({ case: name, status: result.status, valid, challenge,
          milliseconds: Date.now() - started,
          ingress: /^[A-Z]{3}$/.test(request.cf?.colo || '') ? request.cf.colo : null,
          placement: request.headers.get('cf-placement')?.match(/[A-Z]{3}$/)?.[0] || null,
          sourceColo: headers.get('cf-ray')?.match(/-([A-Z]{3})$/)?.[1] || null,
        }, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ case: name, status: 503, valid: false, transportError: true },
          { headers: { 'Cache-Control': 'no-store' } });
      }
    },
  };
}

export default createSourceDiagnostic();
