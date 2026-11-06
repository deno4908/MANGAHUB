import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReaderProgress } from './useReaderProgress';
import { useReaderStore } from '@/store/readerStore';
import { useUserStore } from '@/store/userStore';
import { historyApi } from '@/lib/api';

const remote = vi.hoisted(() => ({ data: null as any, isPending: false }));
vi.mock('./useApi', () => ({ useMangaReadingHistory: () => remote }));
vi.mock('@/lib/api', () => ({ historyApi: { add: vi.fn() } }));
vi.mock('@/store/userStore', async () => {
  const { create } = await import('zustand');
  return { useUserStore: create(() => ({ user: { id: 'reader' }, isLoggedIn: true, isRestoringSession: false })) };
});

let client: QueryClient;
let container: HTMLDivElement;
let resize: () => void;
const observers = new Set<() => void>();
let pageHeight = 1000;
const options = (chapter = 'chapter-a') => ({ chapter, manga: 'book-23', mangaId: 'book-23', title: 'Book', thumb: '',
  chapterName: 'Chương 3', totalPages: 20, mode: 'vertical', currentPage: 0, container: { current: container } });
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
  vi.mocked(historyApi.add).mockReset().mockResolvedValue({});
  remote.data = null; remote.isPending = false;
  useUserStore.setState({ user: { id: 'reader' } as any, isLoggedIn: true });
  useReaderStore.setState({ readingProgress: {}, currentPage: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['history', 'raw'], []);
  container = document.createElement('div'); document.body.append(container);
  pageHeight = 1000;
  for (let i = 0; i < 20; i++) {
    const page = document.createElement('div'); page.dataset.readerPage = String(i);
    page.getBoundingClientRect = () => ({ top: i * pageHeight - window.scrollY, bottom: (i + 1) * pageHeight - window.scrollY, height: pageHeight }) as DOMRect;
    container.append(page);
  }
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 20 * pageHeight });
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
  vi.spyOn(window, 'scrollTo').mockImplementation((_x: any, y?: number) => { Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y || 0 }); });
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
    observe() {} disconnect() { observers.delete(this.callback); }
  });
  resize = () => observers.forEach(callback => callback());
});
afterEach(async () => {
  cleanup(); await act(async () => { await Promise.resolve(); });
  client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); observers.clear();
});

it('saves during continuous scrolling and flushes SPA navigation to the old chapter', async () => {
  const { rerender, unmount } = renderHook(({ chapter }) => useReaderProgress(options(chapter)), { initialProps: { chapter: 'chapter-a' }, wrapper });
  for (let i = 1; i <= 7; i++) {
    act(() => { window.scrollTo(0, i * 500); window.dispatchEvent(new Event('scroll')); });
    await tick(500);
  }
  expect(historyApi.add).toHaveBeenCalled();
  act(() => { window.scrollTo(0, 4600); window.dispatchEvent(new Event('scroll')); });
  rerender({ chapter: 'chapter-b' });
  await tick(0);
  const old = vi.mocked(historyApi.add).mock.calls.map(([entry]) => entry).filter(entry => entry.chapter_id === 'chapter-a');
  expect(old.at(-1)).toMatchObject({ chapter_id: 'chapter-a', page: 4 });
  expect(useReaderStore.getState().readingProgress.reader['book-23'].page).toBe(4);
  // No old page is assigned to the next chapter before it is read.
  unmount(); await tick(0);
});

it('keeps a failed write locally, updates actual caches and retries without scrolling', async () => {
  vi.mocked(historyApi.add).mockRejectedValueOnce(new Error('offline'));
  const { unmount } = renderHook(() => useReaderProgress(options()), { wrapper });
  act(() => { window.scrollTo(0, 6200); window.dispatchEvent(new Event('scroll')); });
  await tick(3000);
  expect(useReaderStore.getState().readingProgress.reader['book-23']).toMatchObject({ page: 6, synced: false });
  expect(client.getQueryData<any[]>(['history', 'raw'])?.[0].page).toBe(6);
  await tick(3000);
  expect(useReaderStore.getState().readingProgress.reader['book-23'].synced).toBe(true);
  const count = vi.mocked(historyApi.add).mock.calls.length;
  await tick(6000);
  expect(historyApi.add).toHaveBeenCalledTimes(count);
  unmount();
});

it('restores the saved vertical page through lazy image resizing and stops after user input', async () => {
  remote.data = { manga_slug: 'book-23', chapter_id: 'chapter-a', page: 7, pageOffset: 0.25, progress: 35 };
  renderHook(() => useReaderProgress(options()), { wrapper });
  await tick(20);
  expect(window.scrollY).toBe(7250);
  pageHeight = 1200; act(() => resize()); await tick(20);
  expect(window.scrollY).toBe(8700);
  act(() => { window.dispatchEvent(new Event('wheel')); window.scrollTo(0, 9000); window.dispatchEvent(new Event('scroll')); });
  pageHeight = 1400; act(() => resize()); await tick(20);
  expect(window.scrollY).toBe(9000);
});

it('restores horizontal pages and flushes the last page when leaving before the timer', async () => {
  remote.data = { manga_slug: 'book-23', chapter_id: 'chapter-a', page: 12, progress: 65 };
  const { rerender, unmount } = renderHook(({ page }) => useReaderProgress({ ...options(), mode: 'horizontal', currentPage: page }), { initialProps: { page: 0 }, wrapper });
  expect(useReaderStore.getState().currentPage).toBe(12);
  act(() => useReaderStore.getState().setCurrentPage(15));
  rerender({ page: 15 }); unmount(); await tick(0);
  expect(historyApi.add).toHaveBeenCalledWith(expect.objectContaining({ page: 15 }), expect.objectContaining({ keepalive: true }));
});

it('does not write while history is pending or leak a previous account navigation state', async () => {
  remote.isPending = true;
  const { rerender } = renderHook(() => useReaderProgress({ ...options(), resumeViewer: 'other-user',
    resume: { manga_slug: 'book-23', chapter_id: 'chapter-a', page: 9, progress: 50 } }), { wrapper });
  await tick(9000); expect(historyApi.add).not.toHaveBeenCalled();
  remote.isPending = false; rerender(); await tick(20);
  expect(window.scrollY).toBe(0);
  act(() => { window.scrollTo(0, 6000); window.dispatchEvent(new Event('scroll')); });
  act(() => useUserStore.setState({ user: { id: 'other-user' } as any }));
  await tick(0);
  expect(useReaderStore.getState().readingProgress.reader).toBeUndefined();
});

it('keeps reading responsive while a lookup is slow and ignores late automatic restoration', async () => {
  remote.isPending = true;
  const { rerender } = renderHook(() => useReaderProgress(options()), { wrapper });
  act(() => window.dispatchEvent(new Event('wheel')));
  act(() => { window.scrollTo(0, 5500); window.dispatchEvent(new Event('scroll')); });
  await tick(3000);
  expect(historyApi.add).toHaveBeenCalledWith(expect.objectContaining({ page: 5 }), expect.anything());
  remote.data = { manga_slug: 'book-23', chapter_id: 'chapter-a', page: 2, progress: 15 };
  remote.isPending = false; rerender(); await tick(20);
  expect(window.scrollY).toBe(5500);
});
