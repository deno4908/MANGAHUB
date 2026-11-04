import { describe, expect, it } from 'vitest';

import { applyBatchRatingsPayload } from '@/lib/mangaRatings';
import type { Manga } from '@/types/manga';

const manga = {
  id: 'community-rated-manga',
  rating: 0,
  ratingCount: 0,
  myRating: null,
} as Manga;

describe('applyBatchRatingsPayload', () => {
  it('shows the community average even when the viewer has not rated', () => {
    const [result] = applyBatchRatingsPayload([manga], {
      ratings: {
        'community-rated-manga': { average: 4.5, count: 8 },
      },
      my_scores: {},
    });

    expect(result.rating).toBe(4.5);
    expect(result.ratingCount).toBe(8);
    expect(result.myRating).toBeNull();
  });

  it('keeps the community average separate from the viewer score', () => {
    const [result] = applyBatchRatingsPayload([manga], {
      ratings: {
        'community-rated-manga': { average: 3.8, count: 5 },
      },
      my_scores: {
        'community-rated-manga': 5,
      },
    });

    expect(result.rating).toBe(3.8);
    expect(result.ratingCount).toBe(5);
    expect(result.myRating).toBe(5);
  });
});


it('uses authoritative zero counters and clears a removed community rating', () => {
  const [result] = applyBatchRatingsPayload([{ ...manga, views: 10, rating: 5, ratingCount: 1 }], {
    views: { [manga.id]: 0 }, ratings: { [manga.id]: { average: 0, count: 0 } },
  }, { pending: true });
  expect(result).toMatchObject({ views: 0, localViewCount: 0, rating: 0, ratingCount: 0, viewsPending: false, ratingPending: false });
});

it('matches canonical MangaDex stats to prefixed card IDs and preserves missing data', () => {
  const id = 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938';
  const [result] = applyBatchRatingsPayload([{ ...manga, id: 'mdx-' + id, views: 0 }], {
    views: { [id]: 6 }, ratings: { [id]: { average: 4, count: 2 } },
  });
  expect(result).toMatchObject({ views: 6, localViewCount: 6, rating: 4, ratingCount: 2 });
  expect(applyBatchRatingsPayload([result], { ratings: {} })[0]).toBe(result);
});
