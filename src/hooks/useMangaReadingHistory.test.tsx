import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { historyApi } from '@/lib/api';
import { useReaderStore } from '@/store/readerStore';
import { useUserStore } from '@/store/userStore';
import { useMangaReadingHistory } from './useApi';

vi.mock('@/store/userStore', async () => {
  const { create } = await import('zustand');
  return { useUserStore: create(() => ({ isLoggedIn: true, isRestoringSession: false, user: { id: 'reader' } })) };
});
const manga = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
const row = { manga_slug: manga, chapter_id: 'chapter-a', page: 12, progress: 50, read_at: '2026-11-06T10:00:00Z' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); useReaderStore.setState({ readingProgress: {} }); useUserStore.setState({ user: { id: 'reader' } as any }); });

it('returns local progress immediately while a delayed history lookup runs in the background', async () => {
  const client = new QueryClient();
  let respond!: (value: any) => void;
  vi.spyOn(historyApi, 'getManga').mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  useReaderStore.getState().saveProgress('reader', row);
  const { result } = renderHook(() => useMangaReadingHistory([manga]), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  expect(result.current.data?.page).toBe(12);
  await act(async () => { respond({ history: { ...row, page: 0, read_at: '2026-11-05T10:00:00Z' } }); });
  expect(result.current.data?.page).toBe(12);
  client.clear();
});

it('queries one book instead of downloading the recent-100 library and isolates account changes', async () => {
  const client = new QueryClient();
  const all = vi.spyOn(historyApi, 'getAll');
  const one = vi.spyOn(historyApi, 'getManga').mockResolvedValue({ history: row });
  const { result } = renderHook(() => useMangaReadingHistory([manga]), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.data?.page).toBe(12));
  expect(one).toHaveBeenCalledWith(manga, []); expect(all).not.toHaveBeenCalled();
  one.mockImplementation(() => new Promise(() => {}));
  act(() => useUserStore.setState({ user: { id: 'someone-else' } as any }));
  expect(result.current.data).toBeUndefined();
  expect(result.current.isPending).toBe(true);
  client.clear();
});
