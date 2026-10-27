import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import MangaCard from '@/components/manga/MangaCard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: {} });
});
const manga = { id: 'vo-trong-game-cua-toi-la-idol-noi-tieng-ngoai-doi', source: 'truyenqq',
  title: 'Vợ Trong Game Của Tôi Là Idol Nổi Tiếng Ngoài Đời', cover: '/no-cover.svg',
  chapters: [], genres: [], tags: [], views: 50, rating: 0, lastUpdated: '', status: 'ongoing' } as unknown as Manga;

it('shows the card immediately, then fills its latest chapter without loading full detail', async () => {
  const client = new QueryClient();
  const detail = vi.spyOn(mangaApi, 'getDetail');
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters')
    .mockResolvedValueOnce({ items: { [manga.id]: { chapter: null, pending: true } } })
    .mockResolvedValue({ items: { [manga.id]: { pending: false, chapter: {
      id: 'qq--book-18078--46', slug: 'book-18078', source: 'truyenqq', chapter_name: '46',
    } } } });
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={manga} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(manga.title)).toBeInTheDocument();
  expect(screen.getByTitle('50 lượt xem')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Chương 46')).toBeInTheDocument(), { timeout: 2500 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(detail).not.toHaveBeenCalled();
  client.clear();
});

it('does not hydrate a card that already has a real native latest chapter', () => {
  const client = new QueryClient();
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters');
  const ready = { ...manga, lastUpdated: new Date().toISOString(),
    chapters: [{ id: 'qq--book-18078--46', number: 46, title: 'Chương 46' } as any] };
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={ready} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText('Chương 46')).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  client.clear();
});

it('hides an old QQ card once the source confirms it no longer resolves', async () => {
  const client = new QueryClient();
  vi.spyOn(mangaApi, 'getLatestCardChapters').mockResolvedValue({ items: {
    [manga.id]: { chapter: null, pending: false, state: 'unavailable' },
  } });
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={manga} /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.queryByText(manga.title)).not.toBeInTheDocument());
  client.clear();
});

it('hides confirmed unmatched metadata even when a saved card has stale chapter data', async () => {
  const client = new QueryClient();
  vi.mocked(mangaApi.getCardMetadata).mockResolvedValue({ items: { [manga.id]: null } });
  const saved = { ...manga, chapters: [{ id: 'qq--book-18078--46', number: 46 } as any] };
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={saved} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(manga.title)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(manga.title)).not.toBeInTheDocument());
  client.clear();
});

it('keeps local publications visible without asking either source', () => {
  const client = new QueryClient();
  const chapters = vi.spyOn(mangaApi, 'getLatestCardChapters');
  const uploaded = { ...manga, source: 'uploaded', chapterAvailability: 'unavailable' } as Manga;
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={uploaded} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(manga.title)).toBeInTheDocument();
  expect(mangaApi.getCardMetadata).not.toHaveBeenCalled();
  expect(chapters).not.toHaveBeenCalled();
  client.clear();
});

it('keeps a lower-number new release even when an older highest chapter is cached', () => {
  const client = new QueryClient();
  const id = '66666666-6666-4666-8666-666666666666';
  client.setQueryData(['manga', 'card-chapter', id], { pending: false, chapter: {
    id: '77777777-7777-4777-8777-777777777777', chapter_name: '99', source: 'mangadex',
    slug: id, publish_at: '2020-01-01T00:00:00Z',
  } });
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters');
  const release = { id: '88888888-8888-4888-8888-888888888888', mangaId: id,
    number: 2, title: 'Release chapter 2', pages: [], uploadDate: new Date().toISOString(), scanlationGroup: '' };
  const ready = { ...manga, id, source: 'mangadex', title: 'Release test',
    releaseChapter: release, chapters: [release] } as Manga;
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={ready} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(/2 -/)).toBeInTheDocument();
  expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  client.clear();
});

it('shows the date of an unnumbered release without requesting a highest chapter', () => {
  const client = new QueryClient();
  const id = '66666666-6666-4666-8666-666666666666';
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters');
  const release = { id: '88888888-8888-4888-8888-888888888888', mangaId: id,
    number: -1, title: 'One shot', pages: [], uploadDate: new Date().toISOString(),
    translationSource: 'mangadex', scanlationGroup: '' } as const;
  const ready = { ...manga, id, source: 'mangadex', title: 'Release test',
    releaseChapter: release, chapters: [release] } as unknown as Manga;
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={ready} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText(/One shot -/)).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  client.clear();
});
