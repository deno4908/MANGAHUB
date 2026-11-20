import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import type { Manga } from '@/types/manga';
import SuggestionChapter from './SuggestionChapter';

const id = '16800ea3-d7cb-4a03-801e-bfbb4dc12bea';
const chapterId = '22222222-2222-4222-8222-222222222222';
const clients: QueryClient[] = [];
const book = (changes = {}) => ({ id, source: 'mangadex', title: 'Search result',
  chapters: [{ id: 'placeholder', number: -1, title: 'MangaDex' }], ...changes } as Manga);
function show(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
afterEach(() => { cleanup();clients.forEach(client => client.clear());clients.length = 0;vi.restoreAllMocks(); });

it('fills a MangaDex search placeholder with the latest VI chapter and shares desktop/mobile requests', async () => {
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters').mockResolvedValue({ items: {
    [id]: { chapter: { id: chapterId, slug: id, source: 'mangadex', chapter_name: '45.5' }, pending: false },
  } });
  show(<><span data-testid="desktop"><SuggestionChapter manga={book()} /></span>
    <span data-testid="mobile"><SuggestionChapter manga={book()} /></span></>);
  expect(screen.getByTestId('desktop')).toHaveTextContent('MangaDex');
  await waitFor(() => expect(screen.getByTestId('desktop')).toHaveTextContent('Chương 45.5'));
  expect(screen.getByTestId('mobile')).toHaveTextContent('Chương 45.5');
  expect(request).toHaveBeenCalledExactlyOnceWith([id]);
});

it('keeps a known QQ chapter without requesting it again', async () => {
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters');
  show(<SuggestionChapter manga={book({ id: 'book-123', source: 'truyenqq', chapters: [
    { id: 'qq--book-123--12', number: 12, uploadDate: '2026-11-20T00:00:00Z' },
  ] })} />);
  expect(screen.getByText('Chương 12')).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('keeps chapter zero and ignores a trailing placeholder', () => {
  show(<SuggestionChapter manga={book({ chapters: [
    { id: chapterId, number: 0 }, { id: 'placeholder', number: -1, title: 'MangaDex' },
  ] })} />);
  expect(screen.getByText('Chương 0')).toBeInTheDocument();
});

it('does not request a Vietnamese chapter for a title that has only other languages', () => {
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters');
  show(<SuggestionChapter manga={book({ availableTranslatedLanguages: ['en'] })} />);
  expect(request).not.toHaveBeenCalled();
});
