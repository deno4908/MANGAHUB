import { render, renderHook, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { Manga } from '@/types/manga';
import { historyApi, mangaApi } from '@/lib/api';
import { useHistory } from '@/hooks/useApi';
import { useCardMetadata, useCanonicalMangaRecords } from './useCardMetadata';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Preview({ manga }: { manga: Manga }) {
  const resolved = useCardMetadata(manga);
  return <div data-source={resolved.source} data-cover={resolved.cover}>{resolved.title} | {resolved.views} | {resolved.id}</div>;
}

it('repairs an eight-word legacy card and preserves its local views and route', async () => {
  const id = 'vo-trong-game-cua-toi-la-idol-noi-tieng-ngoai-doi';
  const client = new QueryClient();
  vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { [id]: {
    id: id + '-18078', slug: id + '-18078', source: 'truyenqq',
    title: 'Vợ Trong Game Của Tôi Là Idol Nổi Tiếng Ngoài Đời',
  } } });
  render(<QueryClientProvider client={client}><Preview manga={{ id, title: 'Vo Trong Game Cua Toi La Idol Noi', views: 50 } as Manga} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText(/Vợ Trong Game Của Tôi Là Idol Nổi Tiếng Ngoài Đời/)).toHaveTextContent(`| 50 | ${id}`));
  client.clear();
});

it('retains a valid romanized title if an old QQ slug has no source match', async () => {
  const client = new QueryClient();
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { 'nozo-x-kimi': null } });
  render(<QueryClientProvider client={client}><Preview manga={{ id: 'nozo-x-kimi', title: 'Nozo X Kimi', views: 7 } as Manga} /></QueryClientProvider>);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(screen.getByText('Nozo X Kimi | 7 | nozo-x-kimi')).toBeInTheDocument();
  client.clear();
});

it('keeps uploaded card metadata even when an external source shares its cached ID', () => {
  const client = new QueryClient();
  const id = '16800ea3-d7cb-4a03-801e-bfbb4dc12bea';
  client.setQueryData(['manga', 'card-metadata', id], {
    id, slug: id, source: 'mangadex', title: 'External manga', cover_url: '/external-cover.jpg',
  });
  render(<QueryClientProvider client={client}><Preview manga={{ id, title: 'Uploaded title', source: 'uploaded', cover: '/own-cover.jpg', views: 8 } as Manga} /></QueryClientProvider>);
  const card = screen.getByText(`Uploaded title | 8 | ${id}`);
  expect(card).toHaveAttribute('data-source', 'uploaded');
  expect(card).toHaveAttribute('data-cover', '/own-cover.jpg');
  client.clear();
});

it('repairs saved cards directly, deduplicates titles and retains reading progress and IDs', async () => {
  const client = new QueryClient();
  const rows = [
    { manga_slug: 'book-123', manga_title: 'Book', manga_thumb: '', progress: 42, chapter_id: 'chapter-old' },
    { manga_slug: 'book-123', manga_title: 'Book', manga_thumb: '', progress: 70, chapter_id: 'chapter-new' },
    { manga_slug: 'book-123', progress: 5, chapter_id: 'chapter-no-title' },
  ];
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { 'book-123': {
    id: 'book-123', slug: 'book-123', source: 'truyenqq', title: 'Tên Truyện Thật', cover_url: '/api/manga/truyenqq/cover/book-123',
  } } });
  function Saved() {
    const data = useCanonicalMangaRecords(rows, { fillMissingCovers: true });
    return <div>{data?.map((row, i) => <span key={i}>{row.manga_title} | {row.progress} | {row.chapter_id} | {row.manga_slug}</span>)}</div>;
  }
  render(<QueryClientProvider client={client}><Saved /></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByText(/Tên Truyện Thật/)).toHaveLength(3));
  expect(screen.getByText('Tên Truyện Thật | 42 | chapter-old | book-123')).toBeInTheDocument();
  expect(screen.getByText('Tên Truyện Thật | 70 | chapter-new | book-123')).toBeInTheDocument();
  expect(screen.getByText('Tên Truyện Thật | 5 | chapter-no-title | book-123')).toBeInTheDocument();
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(['book-123']);
  expect(rows[0].manga_title).toBe('Book');
  client.clear();
});

it('loads history immediately and enriches its title without downloading the 200-book catalog', async () => {
  const client = new QueryClient();
  const id = '16800ea3-d7cb-4a03-801e-bfbb4dc12bea';
  vi.spyOn(historyApi, 'getAll').mockResolvedValue({ history: [
    { manga_slug: id, manga_title: 'MangaDex 16800ea3', manga_thumb: '', progress: 65, chapter_id: 'saved-chapter' },
  ] } as any);
  const catalog = vi.spyOn(mangaApi, 'getMangaDexViCatalog');
  const metadata = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { [id]: {
    id, slug: id, source: 'mangadex', title: 'Vợ tôi là quỷ vương',
  } } });
  const { result, rerender } = renderHook(() => useHistory({ enabled: true }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.data?.[0].manga_title).toBe('Vợ tôi là quỷ vương'));
  expect(result.current.data?.[0]).toMatchObject({ manga_slug: id, progress: 65, chapter_id: 'saved-chapter' });
  expect(catalog).not.toHaveBeenCalled();
  rerender();
  expect(metadata).toHaveBeenCalledOnce();
  client.clear();
});
