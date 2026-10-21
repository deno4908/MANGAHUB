import { useQuery } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { normalizeMangaDexId } from '@/lib/mangaLinks';
import { applyCardChapter, needsCardChapter, requestCardChapter } from '@/lib/cardChapters';

export function useCardChapter(manga: Manga): Manga {
  const id = normalizeMangaDexId(manga.id) || manga.slug || manga.id;
  const needed = needsCardChapter(manga);
  const query = useQuery({
    queryKey: ['manga', 'card-chapter', id],
    queryFn: () => requestCardChapter(id),
    enabled: needed,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
    refetchInterval: query => query.state.data?.pending ? 1000 : (query.state.data?.retry_after || false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  if (query.data?.chapter) return applyCardChapter(manga, query.data.chapter);
  const state = query.data?.state;
  if (needed && (state === 'empty' || state === 'unavailable')) return { ...manga, chapterAvailability: state };
  return manga;
}
