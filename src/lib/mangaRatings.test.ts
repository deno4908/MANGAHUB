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
