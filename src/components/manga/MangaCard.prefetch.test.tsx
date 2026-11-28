import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useMangaDetail } from '@/hooks/useApi';
import type { Manga } from '@/types/manga';
import MangaCard from './MangaCard';

vi.mock('@/hooks/useCardMetadata', () => ({ useCardMetadata: (item: Manga) => item }));
vi.mock('@/hooks/useCardChapter', () => ({ useCardChapter: (item: Manga) => item }));
vi.mock('@/components/ui/OptimizedImage', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['mouseEnter', 'focus', 'touchStart'] as const)('reuses every chapter from the %s prefetch on opening QQ detail', async intent => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = vi.spyOn(mangaApi, 'getDetail').mockResolvedValue({ data: { item: {
    slug: 'ready-12345', name: 'Ready book', source: 'truyenqq', status: 'ongoing',
    chapters: [{ server_name: 'QQ', server_data: [1, 2, 3].map(n => ({ chapter_name: String(n),
      chapter_api_data: '/api/manga/chapter/qq--ready-12345--' + n })) }],
  } } });
  const item = { id: 'ready-12345', slug: 'ready-12345', source: 'truyenqq', title: 'Ready book',
    cover: '/no-cover.svg', status: 'ongoing', genres: [], tags: [], chapters: [], rating: 0, views: 0 } as Manga;
  function Detail() {
    const { data } = useMangaDetail('ready-12345');
    return <div data-testid="chapters">{data?.chapters.map(ch => ch.number).join(',')}</div>;
  }
  render(<QueryClientProvider client={client}><MemoryRouter><Routes>
    <Route path="/" element={<MangaCard manga={item} />} />
    <Route path="/manga/ready-12345" element={<Detail />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  fireEvent[intent](screen.getByRole('link'));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => expect(screen.getByTestId('chapters')).toHaveTextContent('3,2,1'));
  expect(request).toHaveBeenCalledTimes(1);
  client.clear();
});

it.each(['default', 'horizontal', 'compact'] as const)('does not fetch a QQ detail while swiping over a %s card or passing it with the mouse', async variant => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = vi.spyOn(mangaApi, 'getDetail').mockResolvedValue({ data: { item: { slug: 'ready-12345', chapters: [] } } });
  const item = { id: 'ready-12345', slug: 'ready-12345', source: 'truyenqq', title: 'Ready',
    cover: '/no-cover.svg', status: 'ongoing', genres: [], tags: [], chapters: [], rating: 0, views: 0 } as Manga;
  render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={item} variant={variant} /></MemoryRouter></QueryClientProvider>);
  const link = screen.getByRole('link');
  fireEvent.touchStart(link, { touches: [{ clientX: 50, clientY: 100 }] });
  fireEvent.touchMove(link, { touches: [{ clientX: 51, clientY: 60 }] });
  fireEvent.touchEnd(link);
  fireEvent.mouseEnter(link);
  fireEvent.mouseLeave(link);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(request).not.toHaveBeenCalled();
  // A real short tap still starts the normal shared detail read immediately.
  fireEvent.touchStart(link, { touches: [{ clientX: 50, clientY: 100 }] });
  fireEvent.touchEnd(link);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(request).toHaveBeenCalledTimes(1);
  client.clear();
});

it('discards unstarted detail prefetches when the card unmounts during a scroll', async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const request = vi.spyOn(mangaApi, 'getDetail');
  const item = { id: 'ready-12345', source: 'truyenqq', title: 'Ready', cover: '/no-cover.svg',
    status: 'ongoing', genres: [], tags: [], chapters: [], rating: 0, views: 0 } as Manga;
  const view = render(<QueryClientProvider client={client}><MemoryRouter><MangaCard manga={item} /></MemoryRouter></QueryClientProvider>);
  fireEvent.touchStart(screen.getByRole('link'));
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(request).not.toHaveBeenCalled();
  client.clear();
});
