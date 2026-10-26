import { normalizeMangaDexId } from './mangaLinks';

/** Hover, touch, keyboard intent and the detail page must share the same key. */
export function mangaDetailQueryKey(id: string | undefined, maxChapters: number | 'all' = 'all',
  language = 'vi', group = '') {
  const mdx = id ? normalizeMangaDexId(id) : null;
  return ['manga', 'detail', mdx || id, mdx ? 'mangadex' : 'truyenqq',
    mdx ? maxChapters : 'truyenqq', mdx ? language : 'truyenqq',
    mdx ? group || 'all-groups' : 'truyenqq'] as const;
}
