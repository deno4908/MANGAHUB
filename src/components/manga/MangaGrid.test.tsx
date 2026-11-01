import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import MangaGrid from './MangaGrid';

beforeEach(() => vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  disconnect() {}
  unobserve() {}
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const card = (id: string, extra: Partial<Manga> = {}) => ({
  id, source: 'truyenqq', title: `Readable title ${id}`, cover: '/no-cover.svg',
  chapters: [{ id: `qq--${id}--1`, number: 1, title: 'Chapter 1' }],
  genres: [], tags: [], views: 83, rating: 4.5, lastUpdated: '', status: 'ongoing', ...extra,
}) as Manga;
function show(items: Manga[], client: QueryClient, maxItems?: number) {
  return render(<QueryClientProvider client={client}><MemoryRouter>
    <MangaGrid manga={items} maxItems={maxItems} />
  </MemoryRouter></QueryClientProvider>);
}

it('renders all 24 paginated MangaDex cards immediately without a staggered invisible entrance', () => {
  const client = new QueryClient();
  vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: {} });
  vi.spyOn(mangaApi, 'getMangaDexLatestChapters').mockResolvedValue({ items: {} });
  const items = Array.from({ length: 24 }, (_, n) => {
    const id = `${String(n + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
    return card(id, { source: 'mangadex', cover: `https://uploads.mangadex.org/covers/${id}/ready.jpg.256.jpg`,
      chapters: [{ id: '22222222-2222-4222-8222-222222222222', number: 4 } as any] });
  });
  render(<QueryClientProvider client={client}><MemoryRouter>
    <MangaGrid manga={items} lazyBatch={false} animateEntrance={false} />
  </MemoryRouter></QueryClientProvider>);
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(24);
  for (const link of links) expect(link.parentElement).toHaveStyle({ opacity: '1' });
  client.clear();
});

it('loads a known MangaDex CDN cover immediately and recovers an expired filename through its ID', async () => {
  const client = new QueryClient();
  const id = '55555555-5555-4555-8555-555555555555';
  const cover = `https://uploads.mangadex.org/covers/${id}/fast.jpg.256.jpg`;
  show([card(id, { source: 'mangadex', cover, chapters: [{ id: '22222222-2222-4222-8222-222222222222', number: 2 } as any] })], client);
  const image = screen.getByRole('img', { name: `Readable title ${id}` });
  expect(new URL(image.getAttribute('src')!).searchParams.get('url')).toBe(cover);
  fireEvent.error(image);
  await waitFor(() => expect(image.getAttribute('src')).toContain(`/api/manga/mangadex-cover/${id}`));
  client.clear();
});

it('keeps omitted and missing legacy QQ matches out of the initial grid, then admits verified matches with their old statistics', async () => {
  const client = new QueryClient();
  let resolve!: (value: any) => void;
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockReturnValue(new Promise(value => { resolve = value; }));
  const items = [card('old-unresolved'), card('old-missing'), card('old-matched'), card('native-book-128')];
  show(items, client);
  expect(screen.queryByText(items[0].title)).not.toBeInTheDocument();
  expect(screen.queryByText(items[1].title)).not.toBeInTheDocument();
  expect(screen.queryByText(items[2].title)).not.toBeInTheDocument();
  expect(screen.getByText(items[3].title)).toBeInTheDocument();
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  resolve({ items: { 'old-missing': null, 'old-matched': {
    id: 'old-matched-123', slug: 'old-matched-123', source: 'truyenqq',
    title: items[2].title, cover_url: '/qq-new-cover.jpg',
  } } });
  await screen.findByText(items[2].title);
  expect(screen.queryByText(items[0].title)).not.toBeInTheDocument();
  expect(screen.queryByText(items[1].title)).not.toBeInTheDocument();
  expect(screen.getAllByTitle('83 lượt xem')).toHaveLength(2);
  expect(screen.getByRole('img', { name: items[2].title }).getAttribute('src')).toContain('/qq-new-cover.jpg');
  expect(items[2].cover).toBe('/no-cover.svg');
  client.clear();
});

it('filters before the six-card limit and preserves MangaDex and local publications', () => {
  const client = new QueryClient();
  vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: {} });
  const missing = Array.from({ length: 6 }, (_, i) => card(`old-unresolved-${String.fromCharCode(97 + i)}`));
  const valid = [card('5272da37-6c69-4ecc-a1e0-d25db7b3e80f', { source: 'mangadex',
    chapters: [{ id: '22222222-2222-4222-8222-222222222222', number: 1 } as any] }),
    card('local-publication', { source: 'uploaded' }),
    ...Array.from({ length: 4 }, (_, i) => card(`native-book-${100 + i}`))];
  show([...missing, ...valid], client, 6);
  for (const item of missing) expect(screen.queryByText(item.title)).not.toBeInTheDocument();
  for (const item of valid) expect(screen.getByText(item.title)).toBeInTheDocument();
  expect(screen.getAllByRole('link')).toHaveLength(6);
  client.clear();
});

it('preserves genuine Japanese-only MangaDex titles in the release list', () => {
  const client = new QueryClient();
  const item = card('f340eb91-fab8-41d6-ae3f-71f3f0a89a46', { source: 'mangadex',
    title: '\u30d8\u30c3\u30ba', chapters: [{ id: '22222222-2222-4222-8222-222222222222', number: 4 } as any] });
  show([item], client);
  expect(screen.getByText(item.title)).toBeInTheDocument();
  client.clear();
});

it('hides placeholder titles even with an old cover URL and never hides a previously verified match on a refresh failure', async () => {
  const client = new QueryClient();
  client.setQueryData(['manga', 'card-metadata', 'old-verified'], {
    id: 'old-verified-123', slug: 'old-verified-123', source: 'truyenqq', title: 'Verified book',
  }, { updatedAt: 1 });
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockRejectedValue(new Error('Temporary source outage'));
  show([card('old-verified', { title: 'Verified book' }), card('native-book-128', {
    title: 'Chưa có tiêu đề', cover: 'https://old.example/book.jpg',
  }), card('old-unverified')], client);
  expect(screen.getByText('Verified book')).toBeInTheDocument();
  expect(screen.queryByText('Chưa có tiêu đề')).not.toBeInTheDocument();
  expect(screen.queryByText('Readable title old-unverified')).not.toBeInTheDocument();
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(screen.getByText('Verified book')).toBeInTheDocument();
  client.clear();
});
