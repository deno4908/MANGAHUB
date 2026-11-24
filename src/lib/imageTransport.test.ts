import { afterEach, expect, it, vi } from 'vitest';
import { fetchImageResponse } from './imageTransport';
import { setSiteAccessRestricted } from './siteAccessState';
import { clearQQRecovery } from './truyenqqRelay';
vi.mock('./api', async () => ({ getAccessToken: () => 'fixture-website-token',
  isSiteAccessRestricted: (await import('./siteAccessState')).isSiteAccessRestricted }));
afterEach(() => { clearQQRecovery();vi.unstubAllGlobals();setSiteAccessRestricted(false); });
const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const image = () => new Response('image-bytes', { headers: { 'Content-Type': 'image/jpeg' } });

it.each(['cover/book-123', 'image/book-123/1/2'])('recovers protected QQ %s using the exact source hint without sending credentials to a source CDN', async path => {
  setSiteAccessRestricted(true);
  const url = `${api}/api/manga/truyenqq/${path}`;
  const request = vi.fn().mockResolvedValueOnce(new Response('unavailable', { status: 503, headers: {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/truyen-tranh/book-123',
  } })).mockResolvedValueOnce(new Response('<div class="book_info"></div>')).mockResolvedValueOnce(image());
  vi.stubGlobal('fetch', request);
  expect((await fetchImageResponse(url)).headers.get('Content-Type')).toBe('image/jpeg');
  expect(request.mock.calls[0][0]).toBe(url);
  expect(new Headers(request.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer fixture-website-token');
  expect(request.mock.calls[1][0]).toBe('https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge/truyen-tranh/book-123');
  expect(request.mock.calls[1][1].credentials).toBe('omit');
  expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-website-token');
  expect(request.mock.calls[2][0]).toBe(url);
});

it('never attaches the website token or credentials to an external image', async () => {
  setSiteAccessRestricted(true);
  const request = vi.fn().mockResolvedValue(image());vi.stubGlobal('fetch', request);
  await fetchImageResponse('https://cdn.example/page.jpg', { headers: { Authorization: 'must-not-leak' } });
  expect(request.mock.calls[0][1].credentials).toBe('omit');
  expect(new Headers(request.mock.calls[0][1].headers).has('Authorization')).toBe(false);
});
