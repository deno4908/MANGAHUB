import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { syncReadingHistory } from './readingHistorySync';
import { historyApi } from './api';
import { useReaderStore } from '@/store/readerStore';
import { useUserStore } from '@/store/userStore';

vi.mock('./api', () => ({ historyApi: { add: vi.fn() } }));
vi.mock('@/store/userStore', async () => {
  const { create } = await import('zustand');
  return { useUserStore: create(() => ({ user: { id: 'reader' }, isLoggedIn: true })) };
});
afterEach(() => { vi.resetAllMocks(); useReaderStore.setState({ readingProgress: {} }); useUserStore.setState({ user: { id: 'reader' } as any }); });
const row = (page: number) => ({ manga_slug: 'book', chapter_id: 'chapter', page, progress: page * 10, client_read_at: `2026-11-06T10:00:0${page}Z` });

it('serializes writes, coalesces intermediate pages and ignores a delayed older queue entry', async () => {
  const client = new QueryClient();
  client.setQueryData(['history', 'raw'], [row(3)]);
  let finish!: (value: any) => void;
  vi.mocked(historyApi.add).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({});
  const first = syncReadingHistory('reader', row(1), client);
  await syncReadingHistory('reader', row(2), client);
  await syncReadingHistory('reader', row(3), client);
  await syncReadingHistory('reader', row(2), client);
  expect(historyApi.add).toHaveBeenCalledTimes(1);
  finish({}); await first;
  expect(vi.mocked(historyApi.add).mock.calls.map(([entry]) => entry.page)).toEqual([1, 3]);
  expect(client.getQueryData<any[]>(['history', 'raw'])?.[0].page).toBe(3);
  client.clear();
});

it('does not repopulate history or send queued data under another signed-in account', async () => {
  const client = new QueryClient();
  client.setQueryData(['history', 'raw'], []);
  let finish!: (value: any) => void;
  vi.mocked(historyApi.add).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = syncReadingHistory('reader', row(1), client);
  await syncReadingHistory('reader', row(3), client);
  useUserStore.setState({ user: { id: 'different-reader' } as any });
  finish({}); await first;
  expect(historyApi.add).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(['history', 'raw'])).toEqual([]);
  expect(useReaderStore.getState().readingProgress.reader).toBeUndefined();
  client.clear();
});
