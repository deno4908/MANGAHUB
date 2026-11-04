import { expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { incrementMangaViewsInQueryCache } from './querySync';

it('keeps batch view overlays and home/detail records aligned after an accepted read', () => {
  const id = 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938';
  const client = new QueryClient();
  const key = ['rating', 'batch', 'home'];
  client.setQueryData(key, { ratings: {}, views: { [id]: 6, other: 20 } });
  client.setQueryData(['manga', 'homepage'], { latestFeed: [{ id, views: 6, localViewCount: 6 }] });
  incrementMangaViewsInQueryCache(client, ['mdx-' + id]);
  expect(client.getQueryData(key)).toMatchObject({ views: { [id]: 7, other: 20 } });
  expect(client.getQueryData(['manga', 'homepage'])).toMatchObject({ latestFeed: [{ views: 7, localViewCount: 7 }] });
  client.clear();
});
