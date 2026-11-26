import { mangaApi, uploadApi } from './api';
import { adaptChapterPages } from './adapters';
import { normalizeMangaDexId } from './mangaLinks';
import { loadMangaDexChapterPages } from './mangaDexImages';

export function chapterQueryOptions(chapterId?: string) {
  const resolved = normalizeMangaDexId(chapterId) || chapterId;
  const uploaded = resolved?.startsWith('upload-');
  const mangadex = !!normalizeMangaDexId(resolved);
  return {
    queryKey: ['manga', 'chapter', 'validated-pages-v2', resolved],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!resolved) throw new Error('No chapter id');
      let pages: string[];
      let raw: any = { data: { item: {} } };
      if (uploaded) {
        const response = await uploadApi.getUpload(resolved.slice('upload-'.length));
        const upload = response?.upload || response;
        pages = Array.isArray(upload?.pages) ? upload.pages.filter(Boolean) : [];
      } else if (mangadex) {
        pages = await loadMangaDexChapterPages(resolved);
      } else {
        raw = await mangaApi.getChapter(resolved, signal);
        pages = adaptChapterPages(raw);
      }
      // A partial response must never become a fresh, hour-long empty chapter,
      // including when the response was fetched by next-chapter preloading.
      if (!pages.length) throw Object.assign(new Error('Chưa tải được ảnh của chương. Vui lòng thử lại.'),
        { status: 502, code: 'CHAPTER_PAGES_UNAVAILABLE' });
      return { pages, raw };
    },
    enabled: !!resolved,
    staleTime: uploaded ? 5 * 60_000 : mangadex ? 30_000 : 60 * 60_000,
    gcTime: uploaded ? 10 * 60_000 : mangadex ? 5 * 60_000 : 30 * 60_000,
    retry: (attempt: number, error: Error & { status?: number }) =>
      !mangadex && attempt < 1 && (!error.status || error.status >= 500),
    retryDelay: 1000,
  };
}
