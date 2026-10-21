import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from './api';
import { loadHomeCardMetadata } from './homeCardMetadata';

afterEach(() => vi.restoreAllMocks());

it('fills home ranking labels through shared batches without requesting manga details or feeds', async () => {
  const client = new QueryClient();
  const mdx = '11111111-1111-4111-8111-111111111111';
  const metadata: Record<string, any> = {
    'legacy-book': { id: 'legacy-book-123', slug: 'legacy-book-123', source: 'truyenqq', title: 'Native QQ title',
      genres: ['Romance'], tags: ['romance'], chapters_latest: [{ chapter_name: '46', chapter_api_data: 'qq--legacy-book-123--46' }] },
    [mdx]: { id: mdx, slug: mdx, source: 'mangadex', title: 'Native MangaDex title', content_rating: 'safe' },
  };
  const batch = vi.spyOn(mangaApi, 'getCardMetadata').mockImplementation(async ids => ({
    items: Object.fromEntries(ids.map(id => [id, metadata[id]])),
  }));
  const qqDetail = vi.spyOn(mangaApi, 'getDetail');
  const mdxDetail = vi.spyOn(mangaApi, 'getMangaDexDetail');
  const result = await loadHomeCardMetadata(['legacy-book', mdx], client);
  expect(result['legacy-book'].title).toBe('Native QQ title');
  expect(result['legacy-book'].id).toBe('legacy-book');
  expect(result['legacy-book'].slug).toBe('legacy-book-123');
  expect(result['legacy-book'].chapters[0].number).toBe(46);
  expect(result[mdx].title).toBe('Native MangaDex title');
  expect(result[mdx].contentRating).toBe('safe');
  expect(batch).toHaveBeenCalledTimes(2); // Each source has its own batch.
  expect(qqDetail).not.toHaveBeenCalled();
  expect(mdxDetail).not.toHaveBeenCalled();
  client.clear();
});
