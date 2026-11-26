import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChapterReader from './ChapterReader';
import { mangaApi } from '@/lib/api';
import { writeReaderMetaToStorage } from '@/lib/readerMetadata';
import * as imageCache from '@/lib/coverCache';

const chapter = vi.hoisted(() => ({ result: {} as any, retry: vi.fn() }));
vi.mock('@/hooks/useApi', () => ({ useChapter: () => chapter.result }));
vi.mock('@/hooks/useReaderProgress', () => ({ useReaderProgress: vi.fn() }));
vi.mock('@/store/userStore', () => ({ useUserStore: () => ({ user: { role: 'admin' }, isLoggedIn: true }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: (select: any) => select({ settings: { reader: { imageLoading: 'lazy' }, privacy: { silentViewTracking: true } } }) }));
vi.mock('@/lib/api', () => ({ mangaApi: { getDetail: vi.fn(), getChapter: vi.fn() } }));
vi.mock('@/components/reader/ReaderImage', () => ({ default: ({ index, onVisible }: any) => <button data-testid={`reader-image-${index}`} onClick={() => onVisible?.(index)}>Page</button> }));
vi.mock('@/components/manga/CommentSection', () => ({ default: () => null }));
vi.mock('@/components/reader/ReaderSettings', () => ({ default: () => null }));

const slug = 'reader-comic-123';
const id = (number: number) => `qq--${slug}--${number}`;
const chapters = [0, 1, 2].map(number => ({ id: id(number), number, title: `Chương ${number}` }));
let client: QueryClient;
const Location = () => <output data-testid="location">{useLocation().pathname}</output>;
function open(number: number) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/chapter/${id(number)}`]}>
    <Location /><Routes><Route path="/chapter/:id" element={<ChapterReader />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  chapter.retry.mockReset();
  chapter.result = { data: { pages: ['https://images.example/page.jpg'], raw: { data: { item: {} } } },
    isLoading: false, isFetching: false, error: null, refetch: chapter.retry };
  localStorage.clear(); sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.mocked(mangaApi.getDetail).mockReset().mockResolvedValue({ data: { item: {
    slug, name: 'Reader comic', source: 'truyenqq', chapters: [{ server_name: 'TruyenQQ', server_data: chapters.map(ch => ({ chapter_name: String(ch.number), chapter_api_data: `/api/manga/chapter/${ch.id}` })) }],
  } } });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('preloads at most the first next-chapter image and respects saveData=%s', async saveData => {
  const previousConnection = Object.getOwnPropertyDescriptor(navigator, 'connection');
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData, effectiveType: '4g' } });
  try {
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn();static revokeObjectURL = vi.fn(); });
    const warm = vi.spyOn(imageCache, 'warmReaderImages').mockImplementation(() => vi.fn());
    vi.mocked(mangaApi.getChapter).mockReset().mockResolvedValue({ data: { item: { chapter_image: [
      { image_file: `/api/manga/truyenqq/image/${slug}/2/1` }, { image_file: `/api/manga/truyenqq/image/${slug}/2/2` },
    ] } } });
    chapter.result.data.pages = Array.from({ length: 5 }, (_, n) => `https://images.example/${n}.jpg`);
    open(1);
    await screen.findByRole('button', { name: 'Chương sau' });
    fireEvent.click(screen.getByTestId('reader-image-3'));
    await waitFor(() => expect(mangaApi.getChapter).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
    const next = `${api}/api/manga/truyenqq/image/${slug}/2/1`;
    const nextCalls = warm.mock.calls.filter(([urls]) => urls.includes(next));
    expect(nextCalls).toHaveLength(saveData ? 0 : 1);
    if (!saveData) expect(nextCalls[0][0]).toEqual([next]);
    fireEvent.click(screen.getByTestId('reader-image-4'));
    await act(async () => {});
    expect(mangaApi.getChapter).toHaveBeenCalledTimes(1);
  } finally {
    if (previousConnection) Object.defineProperty(navigator, 'connection', previousConnection);
    else Reflect.deleteProperty(navigator, 'connection');
  }
});

it('offers recovery for a temporary source outage instead of claiming the next chapter is missing', async () => {
  chapter.result.data = undefined;
  chapter.result.error = Object.assign(new Error('temporary source outage'), { status: 503 });
  open(2);
  expect(screen.getByRole('alert')).toHaveTextContent('Chưa tải được chương');
  expect(screen.queryByText('Không tìm thấy chương này.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Thử tải lại chương' }));
  expect(chapter.retry).toHaveBeenCalledTimes(1);
});

it('reserves the missing chapter message for an actual 404', () => {
  chapter.result.data = undefined;
  chapter.result.error = Object.assign(new Error('missing'), { status: 404 });
  open(2);
  expect(screen.getByRole('alert')).toHaveTextContent('Không tìm thấy chương này.');
  expect(screen.queryByRole('button', { name: 'Thử tải lại chương' })).not.toBeInTheDocument();
});

it('keeps the loading state during recovery instead of flashing a missing chapter', () => {
  chapter.result.data = undefined;
  chapter.result.isFetching = true;
  open(2);
  expect(screen.getByText('Đang tải chương...')).toBeInTheDocument();
  expect(screen.queryByText('Không tìm thấy chương này.')).not.toBeInTheDocument();
});

it('cold-mounts a QQ chapter without browser history state and restores next/previous from the verified list', async () => {
  open(1);
  await waitFor(() => expect(mangaApi.getDetail).toHaveBeenCalledWith(slug, expect.any(AbortSignal)));
  const next = await screen.findByRole('button', { name: 'Chương sau' });
  expect(screen.getByRole('button', { name: 'Chương trước' })).toBeInTheDocument();
  expect(screen.queryByText('Chương ?')).not.toBeInTheDocument();
  fireEvent.click(next);
  expect(screen.getByTestId('location')).toHaveTextContent(`/chapter/${id(2)}`);
});

it('keeps chapter zero navigation available immediately from shared metadata while its background refresh is pending', async () => {
  writeReaderMetaToStorage([id(1)], { mangaSlug: slug, mangaTitle: 'Reader comic', chapters });
  sessionStorage.clear();
  vi.mocked(mangaApi.getDetail).mockImplementation(() => new Promise(() => {}));
  open(0);
  expect(screen.getByRole('button', { name: 'Chương sau' })).toBeInTheDocument();
  expect(screen.queryByText('Chương ?')).not.toBeInTheDocument();
  expect(mangaApi.getDetail).not.toHaveBeenCalled();
});
