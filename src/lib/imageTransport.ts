import { getAccessToken, isSiteAccessRestricted } from './api';
import { fetchWithTruyenQQRelay } from './truyenqqRelay';
import { fetchWithTimeout } from './http';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function isProtectedImage(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === new URL(API_BASE).origin && (url.pathname === '/api/images/img' ||
      /^\/api\/manga\/(?:mangadex-cover|truyenqq\/(?:image|cover))\//.test(url.pathname));
  } catch { return false; }
}

/** Only our own image endpoints receive the website token, never a source CDN. */
export function fetchImageResponse(url: string, options: RequestInit = {}, timeout = 25_000): Promise<Response> {
  const headers = new Headers(options.headers);
  const owned = isProtectedImage(url);
  if (!owned) headers.delete('Authorization');
  if (owned && isSiteAccessRestricted() && getAccessToken()) {
    headers.set('Authorization', `Bearer ${getAccessToken()}`);
  }
  const request = { ...options, headers, credentials: owned ? 'include' as const : 'omit' as const, referrerPolicy: 'no-referrer' as const };
  return owned && new URL(url, window.location.origin).pathname.startsWith('/api/manga/truyenqq/')
    ? fetchWithTruyenQQRelay(url, request, timeout)
    : fetchWithTimeout(url, request, timeout);
}
