import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChapterReader from './ChapterReader';
import { mangaApi } from '@/lib/api';
import { writeReaderMetaToStorage } from '@/lib/readerMetadata';

vi.mock('@/hooks/useApi', () => ({ useChapter: () => ({ data: { pages: ['https://images.example/page.jpg'], raw: { data: { item: {} } } }, isLoading: false }) }));
vi.mock('@/hooks/useReaderProgress', () => ({ useReaderProgress: vi.fn() }));
vi.mock('@/store/userStore', () => ({ useUserStore: () => ({ user: { role: 'admin' }, isLoggedIn: true }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: (select: any) => select({ settings: { reader: { imageLoading: 'lazy' }, privacy: { silentViewTracking: true } } }) }));
vi.mock('@/lib/api', () => ({ mangaApi: { getDetail: vi.fn() } }));
vi.mock('@/components/reader/ReaderImage', () => ({ default: () => <div>Page</div> }));
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
  localStorage.clear(); sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.mocked(mangaApi.getDetail).mockReset().mockResolvedValue({ data: { item: {
    slug, name: 'Reader comic', source: 'truyenqq', chapters: [{ server_name: 'TruyenQQ', server_data: chapters.map(ch => ({ chapter_name: String(ch.number), chapter_api_data: `/api/manga/chapter/${ch.id}` })) }],
  } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

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
