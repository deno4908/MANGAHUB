import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
