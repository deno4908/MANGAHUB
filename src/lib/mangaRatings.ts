import type { Manga } from '@/types/manga';

type RatingAggregate = {
  average?: number | string | null;
  count?: number | string | null;
};

export type BatchRatingsPayload = {
  ratings?: Record<string, RatingAggregate>;
  my_scores?: Record<string, number | string | null | undefined>;
} | null | undefined;

export function applyBatchRatingsPayload(
  items: Manga[],
  payload: BatchRatingsPayload,
): Manga[] {
  const ratingMap = payload?.ratings || {};
  const myScoreMap = payload?.my_scores || {};

  return items.map((manga) => {
    const rawId = String(manga.id || '').trim();
    const normalizedId = rawId.toLowerCase();
    const aggregate =
      ratingMap[rawId] ||
      ratingMap[normalizedId] ||
      ratingMap[`mdx-${normalizedId}`];
    const myScoreRaw =
      myScoreMap[rawId] ??
      myScoreMap[normalizedId] ??
      myScoreMap[`mdx-${normalizedId}`];
    const hasMyScore =
      myScoreRaw !== null &&
      myScoreRaw !== undefined &&
      Number.isFinite(Number(myScoreRaw));
    const aggregateAverage = Number(aggregate?.average ?? 0);
    const aggregateCount = Number(aggregate?.count ?? 0);
    const hasAggregate =
      Number.isFinite(aggregateAverage) &&
      Number.isFinite(aggregateCount) &&
      (aggregateCount > 0 || aggregateAverage > 0);

    if (!hasAggregate && !hasMyScore) return manga;

    return {
      ...manga,
      rating: hasAggregate ? aggregateAverage : Number(manga.rating || 0),
      ratingCount: hasAggregate ? aggregateCount : Number(manga.ratingCount || 0),
      myRating: hasMyScore ? Number(myScoreRaw) : (manga.myRating ?? null),
    };
  });
}
