import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import { applyCardMetadata, needsCanonicalTitle, requestCardMetadata } from './cardMetadata';

const legacy = 'vo-trong-game-cua-toi-la-idol-noi-tieng-ngoai-doi';
const title = 'Vợ Trong Game Của Tôi Là Idol Nổi Tiếng Ngoài Đời';
const mdx = '16800ea3-d7cb-4a03-801e-bfbb4dc12bea';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('canonical card titles', () => {
  it('recognizes generated names and retains authoritative Unicode titles', () => {
    expect(needsCanonicalTitle(mdx, 'MangaDex 16800ea3')).toBe(true);
    expect(needsCanonicalTitle(mdx, mdx)).toBe(true);
    expect(needsCanonicalTitle(legacy, 'Vo Trong Game Cua Toi La Idol Noi')).toBe(true);
    expect(needsCanonicalTitle(legacy, 'Vo Trong Game Cua Toi La Idol Noi Tieng Ngoai Doi')).toBe(true);
    expect(needsCanonicalTitle(legacy, title)).toBe(false);
    expect(needsCanonicalTitle(mdx, 'Vợ tôi là quỷ vương')).toBe(false);
    expect(needsCanonicalTitle(mdx, 'My Wife Is a Demon Queen')).toBe(false);
    expect(needsCanonicalTitle(mdx, '妻は魔王')).toBe(false);
  });

  it('preserves local stats and old identity while restoring full title and canonical slug', () => {
    const original = { id: legacy, title: 'Vo Trong Game Cua Toi La Idol Noi', views: 50,
      localViewCount: 50, rating: 4.5, ratingCount: 3, myRating: 5, cover: 'old.jpg', chapters: [],
      genres: [], tags: [] } as unknown as Manga;
    const result = applyCardMetadata(original, { id: legacy + '-18078', slug: legacy + '-18078',
      source: 'truyenqq', title, genres: ['Romance'],
      chapters_latest: [{ chapter_name: '46', chapter_api_data: '/api/manga/chapter/qq--book-18078--46' }] });
    expect(result.title).toBe(title);
    expect(result.id).toBe(legacy);
    expect(result.slug).toBe(legacy + '-18078');
    expect([result.views, result.localViewCount, result.rating, result.ratingCount, result.myRating]).toEqual([50, 50, 4.5, 3, 5]);
    expect(result.chapters[0].id).toBe('qq--book-18078--46');
    expect(original.chapters).toHaveLength(0);
  });

  it('batches duplicate cards by source and repairs cached lists without replacing user state', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(['manga', 'trending'], [{ slug: legacy, title: 'Vo Trong Game Cua Toi La Idol Noi', views: 50, rating: 4.5 }]);
    client.setQueryData(['history', 'user'], [{ manga_slug: legacy, manga_title: 'Vo Trong Game Cua Toi La Idol Noi', chapter_id: 'old-progress' }]);
    const request = vi.spyOn(mangaApi, 'getCardMetadata').mockImplementation(async ids => ({
      items: Object.fromEntries(ids.map(id => [id, { id, slug: id, source: id === mdx ? 'mangadex' : 'truyenqq', title: id === mdx ? 'Vợ tôi là quỷ vương' : title }]))
    }));
    const results = [requestCardMetadata(legacy, client), requestCardMetadata(mdx, client), requestCardMetadata(legacy, client)];
    await vi.advanceTimersByTimeAsync(35);
    expect((await Promise.all(results)).map(value => value?.title)).toEqual([title, 'Vợ tôi là quỷ vương', title]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(['manga', 'trending'])).toMatchObject([{ title, slug: legacy, views: 50, rating: 4.5 }]);
    expect(client.getQueryData(['history', 'user'])).toMatchObject([{ manga_title: title, manga_slug: legacy, chapter_id: 'old-progress' }]);
    client.clear();
  });

  it('normalizes legacy keys and keeps an invalid identifier out of a valid batch', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const request = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { [legacy]: null } });
    const valid = requestCardMetadata(legacy.toUpperCase(), client);
    expect(await requestCardMetadata('https://example.com/title', client)).toBeNull();
    await vi.advanceTimersByTimeAsync(35);
    expect(await valid).toBeNull();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith([legacy]);
    client.clear();
  });
});
