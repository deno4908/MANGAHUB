import type { Manga } from '@/types/manga';
import { normalizeMangaDexId } from './mangaLinks';

type RatingAggregate = {
  average?: number | string | null;
  count?: number | string | null;
};

export type BatchRatingsPayload = {
  ratings?: Record<string, RatingAggregate>;
  views?: Record<string, number | string>;
  my_scores?: Record<string, number | string | null | undefined>;
} | null | undefined;

export function applyBatchRatingsPayload(
  items: Manga[],
  payload: BatchRatingsPayload,
  options: { pending?: boolean } = {},
): Manga[] {
  const ratingMap = payload?.ratings || {};
  const myScoreMap = payload?.my_scores || {};

  return items.map((manga) => {
    const rawId = String(manga.id || '').trim().toLowerCase();
    const normalizedId = normalizeMangaDexId(rawId) || rawId;
    const keys = [...new Set([rawId, normalizedId, manga.slug?.toLowerCase(),
      `mdx-${normalizedId}`, `mangadex-${normalizedId}`, `mangadex:${normalizedId}`].filter(Boolean))] as string[];
    const aggregate = keys.map(key => ratingMap[key]).find(Boolean);
    const myScoreRaw = keys.map(key => myScoreMap[key]).find(value => value !== undefined);
    const viewsRaw = keys.map(key => payload?.views?.[key]).find(value => value !== undefined);
    const hasViews = viewsRaw !== null && viewsRaw !== undefined && Number.isFinite(Number(viewsRaw));
    const hasMyScore =
      myScoreRaw !== null &&
      myScoreRaw !== undefined &&
      Number.isFinite(Number(myScoreRaw));
    const aggregateAverage = Number(aggregate?.average ?? 0);
    const aggregateCount = Number(aggregate?.count ?? 0);
    const hasAggregate =
      Number.isFinite(aggregateAverage) &&
      Number.isFinite(aggregateCount) &&
      aggregate !== undefined;

    if (!hasAggregate && !hasMyScore && !hasViews && !options.pending) return manga;

    return {
      ...manga,
      ...(options.pending ? { viewsPending: !hasViews, ratingPending: !hasAggregate } : {}),
      ...(hasViews ? { views: Math.max(0, Number(viewsRaw)), view_count: Math.max(0, Number(viewsRaw)),
        localViewCount: Math.max(0, Number(viewsRaw)), local_view_count: Math.max(0, Number(viewsRaw)) } : {}),
      rating: hasAggregate ? aggregateAverage : Number(manga.rating || 0),
      ratingCount: hasAggregate ? aggregateCount : Number(manga.ratingCount || 0),
      myRating: hasMyScore ? Number(myScoreRaw) : (manga.myRating ?? null),
    };
  });
}
