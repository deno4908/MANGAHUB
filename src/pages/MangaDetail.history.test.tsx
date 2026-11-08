import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MangaDetail from './MangaDetail';
import { historyApi, ratingApi, uploadApi } from '@/lib/api';
import { useReaderStore } from '@/store/readerStore';

const fixture = vi.hoisted(() => {
  const id = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  const first = '8272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  const last = '9272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  return { id, first, last, manga: { id, slug: id, source: 'mangadex', title: 'Background history', author: '', artist: '',
    description: 'Description', cover: '/no-cover.svg', status: 'ongoing', type: 'manga', genres: [], tags: [], rating: 0,
    ratingCount: 0, follows: 0, views: 0, year: 2026, lastUpdated: '', chapters: [first, last].map((chapter, index) => ({
      id: chapter, mangaId: id, number: index + 1, title: `Chapter ${index + 1}`, pages: [], uploadDate: '',
      translationSource: 'mangadex', translatedLanguage: 'vi', scanlationGroup: '',
    })) } };
});
vi.mock('@/hooks/useApi', async () => ({
  ...await vi.importActual<typeof import('@/hooks/useApi')>('@/hooks/useApi'),
  useMangaDetail: () => ({ data: fixture.manga, isLoading: false, isFetching: false, error: null }),
  useIsBookmarked: () => ({ data: false }), useIsFollowing: () => ({ data: false }),
  useToggleBookmark: () => ({ mutate: vi.fn() }), useToggleFollow: () => ({ mutate: vi.fn() }),
  useRateManga: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/store/userStore', async () => {
  const { create } = await import('zustand');
  return { useUserStore: create(() => ({ isLoggedIn: true, isRestoringSession: false, user: { id: 'reader', role: 'reader' } })) };
});
vi.mock('@/components/manga/CommentSection', () => ({ default: () => null }));
vi.mock('@/components/manga/ChapterList', () => ({ default: () => <div>Chapter list available</div> }));
vi.mock('@/components/ui/OptimizedImage', () => ({ default: ({ src, alt }: any) => <img src={src} alt={alt} /> }));
vi.mock('framer-motion', async () => {
  const { forwardRef } = await import('react');
  const component = (tag: string) => forwardRef(({ initial, animate, transition, layout, ...props }: any, ref: any) => {
    const Tag = tag as any; return <Tag {...props} ref={ref} />;
  });
  return { motion: { div: component('div'), p: component('p') } };
});
let client: QueryClient;
const saved = { manga_slug: fixture.id, chapter_id: fixture.last, chapter_name: 'Chapter 2', page: 12, progress: 50, read_at: '2026-11-06T10:00:00Z' };
beforeEach(() => {
  vi.useFakeTimers(); focusManager.setFocused(true);
  client = new QueryClient();
  useReaderStore.setState({ readingProgress: {} });
  vi.spyOn(uploadApi, 'getPublishedChapters').mockResolvedValue({ chapters: [] });
  vi.spyOn(ratingApi, 'getMangaRating').mockResolvedValue({ average: 0, count: 0 });
  vi.spyOn(ratingApi, 'getMyRating').mockResolvedValue({ score: null });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); focusManager.setFocused(undefined); });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function show() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/manga/${fixture.id}`]}>
    <Routes><Route path="/manga/:id" element={<MangaDetail />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
}

it('keeps reading available immediately while history loads silently in the background', async () => {
  let respond!: (value: any) => void;
  vi.spyOn(historyApi, 'getManga').mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  show();
  expect(screen.getByRole('link', { name: 'Đọc ngay' })).toHaveAttribute('href', `/chapter/${fixture.first}`);
  expect(screen.queryByText(/Đang tải tiến trình đọc|Thử lại tiến trình đọc/)).not.toBeInTheDocument();
  await act(async () => respond({ history: saved })); await tick(1);
  expect(screen.getByRole('link', { name: 'Đọc tiếp' })).toHaveAttribute('href', `/chapter/${fixture.last}`);
});

it('recovers automatically from a failed lookup without a loading or retry button', async () => {
  const request = vi.spyOn(historyApi, 'getManga').mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValue({ history: saved });
  show(); await tick(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: 'Đọc ngay' })).toBeEnabled();
  expect(screen.queryByText(/Đang tải tiến trình đọc|Thử lại tiến trình đọc/)).not.toBeInTheDocument();
  await tick(1_020);
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('link', { name: 'Đọc tiếp' })).toHaveAttribute('href', `/chapter/${fixture.last}`);
  await tick(60_000);
  expect(request).toHaveBeenCalledTimes(2);
});

it('retains cached progress during an outage and backs off rather than repeatedly blocking reading', async () => {
  useReaderStore.getState().saveProgress('reader', saved);
  const request = vi.spyOn(historyApi, 'getManga').mockRejectedValue(new Error('offline'));
  show(); await tick(1);
  expect(screen.getByRole('link', { name: 'Đọc tiếp' })).toHaveAttribute('href', `/chapter/${fixture.last}`);
  await tick(999); expect(request).toHaveBeenCalledTimes(2);
  await tick(2_001); expect(request).toHaveBeenCalledTimes(3);
  await tick(4_001); expect(request).toHaveBeenCalledTimes(4);
  expect(screen.queryByText(/Đang tải tiến trình đọc|Thử lại tiến trình đọc/)).not.toBeInTheDocument();
});

it('stops automatic polling when access is denied', async () => {
  const request = vi.spyOn(historyApi, 'getManga').mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
  show(); await tick(60_000);
  expect(request).toHaveBeenCalledTimes(1);
});
