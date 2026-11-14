import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bookmarkApi, followApi, historyApi, mangaApi } from '@/lib/api';
import * as covers from '@/lib/coverCache';
import BookmarksPage from './BookmarksPage';
import FollowingPage from './FollowingPage';
import HistoryPage from './HistoryPage';

vi.mock('@/store/userStore', () => ({ useUserStore: (select: (value: any) => any) =>
  select({ isLoggedIn: true, isRestoringSession: false, user: { id: 'library-reader' } }) }));
// Image transport is tested separately. Keep actual page, hooks and query cache.
vi.mock('@/components/ui/OptimizedImage', () => ({ default: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} /> }));

const rows = [
  { manga_slug: 'native-book-123', manga_title: 'Native QQ saved title',
    manga_thumb: '/api/manga/truyenqq/cover/native-book-123', chapter_id: 'qq--native-book-123--12',
    chapter_name: 'Chapter 12', page: 8, progress: 73, read_at: '2026-11-14T08:00:00Z' },
  { manga_slug: 'old-saved-slug', manga_title: 'Legacy QQ saved title', manga_thumb: 'old.jpg',
    chapter_id: 'qq--old-saved-slug--6', chapter_name: 'Chapter 6', page: 4, progress: 42,
    read_at: '2026-11-14T07:00:00Z' },
];

beforeEach(() => {
  vi.spyOn(covers, 'warmCovers').mockReturnValue(() => {});
  vi.spyOn(bookmarkApi, 'getAll').mockResolvedValue({ bookmarks: rows });
  vi.spyOn(followApi, 'getAll').mockResolvedValue({ follows: rows });
  vi.spyOn(historyApi, 'getAll').mockResolvedValue({ history: rows });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const Page of [BookmarksPage, FollowingPage, HistoryPage]) {
  it(`${Page.name} renders saved QQ records immediately and keeps them after missing source metadata`, async () => {
    let finish!: (value: any) => void;
    const metadata = vi.spyOn(mangaApi, 'getCardMetadata').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const client = new QueryClient();
    const mounted = render(<QueryClientProvider client={client}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Page /></MemoryRouter></QueryClientProvider>);
    // A source lookup may be pending for seconds; saved content is already usable.
    await screen.findByText(rows[0].manga_title);
    expect(screen.getByText(rows[1].manga_title)).toBeInTheDocument();
    expect(screen.getByText(rows[0].manga_title).closest('a')).toHaveAttribute('href', '/manga/native-book-123');
    await waitFor(() => expect(metadata).toHaveBeenCalled());
    await act(async () => finish({ items: Object.fromEntries(rows.map(row => [row.manga_slug, null])) }));
    await waitFor(() => expect(client.getQueryData(['manga', 'card-metadata', rows[0].manga_slug])).toBeNull());
    for (const row of rows) expect(screen.getByText(row.manga_title)).toBeInTheDocument();
    if (Page === HistoryPage) {
      expect(screen.getByText(/Chapter 12.*73%/)).toBeInTheDocument();
      expect(screen.getByText(/Chapter 6.*42%/)).toBeInTheDocument();
    }
    mounted.unmount();client.clear();
  });
}
