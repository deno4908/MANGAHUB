import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ReadingHistorySync from './ReadingHistorySync';
import { historyApi } from '@/lib/api';
import { useReaderStore } from '@/store/readerStore';
import { useUserStore } from '@/store/userStore';
vi.mock('@/lib/api', () => ({ historyApi: { add: vi.fn() } }));
vi.mock('@/store/userStore', async () => {
  const { create } = await import('zustand');
  return { useUserStore: create(() => ({ user: { id: 'reader' }, isLoggedIn: true, isRestoringSession: false })) };
});
let client: QueryClient;
const row = { manga_slug: 'qq-book-123', chapter_id: 'qq--qq-book-123--12', page: 7, progress: 51,
  client_read_at: '2026-11-14T08:00:00Z', synced: false };
beforeEach(() => {
  vi.useFakeTimers();vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  useUserStore.setState({ user: { id: 'reader' } as any, isLoggedIn: true });
  useReaderStore.setState({ readingProgress: {} });useReaderStore.getState().saveProgress('reader', row);
  client = new QueryClient();
});
afterEach(() => { cleanup();client.clear();vi.restoreAllMocks();vi.useRealTimers(); });
it('retries a failed QQ checkpoint after leaving the reader, including after reloading the journal', async () => {
  vi.mocked(historyApi.add).mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  render(<QueryClientProvider client={client}><ReadingHistorySync /></QueryClientProvider>);
  await act(async () => {});
  expect(useReaderStore.getState().readingProgress.reader['qq-book-123'].synced).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(historyApi.add).toHaveBeenCalledTimes(2);
  expect(useReaderStore.getState().readingProgress.reader['qq-book-123']).toMatchObject({ page: 7, progress: 51, synced: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(historyApi.add).toHaveBeenCalledTimes(2);
});
it('does not send another account checkpoint after logout or account switching', async () => {
  vi.mocked(historyApi.add).mockReset().mockRejectedValue(new Error('offline'));
  render(<QueryClientProvider client={client}><ReadingHistorySync /></QueryClientProvider>);
  await act(async () => {});
  act(() => useUserStore.setState({ user: { id: 'other-reader' } as any }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000);window.dispatchEvent(new Event('online')); });
  expect(historyApi.add).toHaveBeenCalledTimes(1);
});
