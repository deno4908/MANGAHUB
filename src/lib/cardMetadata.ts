import type { QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import { normalizeMangaDexId } from '@/lib/mangaLinks';
import { repairMojibakeText, thumbUrl } from '@/lib/adapters';
import { patchMangaInQueryCache } from '@/lib/querySync';

export type CardMetadata = {
  id: string; slug: string; source: 'mangadex' | 'truyenqq'; title: string;
  cover_url?: string; genres?: string[]; tags?: string[]; status?: Manga['status']; content_rating?: string;
  chapters_latest?: Array<{ chapter_name?: string; chapter_title?: string; chapter_api_data?: string; updatedAt?: string }>;
};

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function needsCanonicalTitle(identifier: string, value: unknown): boolean {
  const title = repairMojibakeText(value).trim();
  if (!title || /^(?:mangadex(?:\s+[0-9a-f-]+)?|untitled|unknown|chưa có tiêu đề|đang tải tên truyện…)$/i.test(title)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title)) return true;
  if (/[^\x00-\x7f]/.test(title)) return false;
  const bare = normalize(identifier.replace(/-\d+$/, ''));
  const label = normalize(title);
  return bare === label || [8, 10].some(length => bare.split(' ').slice(0, length).join(' ') === label);
}

export function applyCardMetadata(manga: Manga, metadata: CardMetadata): Manga {
  const latest = metadata.chapters_latest?.[0];
  const chapterId = latest?.chapter_api_data?.split('/').pop();
  const chapters = chapterId && !manga.chapters?.length ? [{ id: chapterId, mangaId: manga.id,
    number: Number(latest?.chapter_name) || 0, title: latest?.chapter_title || `Chương ${latest?.chapter_name}`,
    pages: [], uploadDate: latest?.updatedAt || '', scanlationGroup: '' }] : manga.chapters;
  return { ...manga, title: metadata.title, source: metadata.source, slug: metadata.slug,
    cover: metadata.cover_url ? thumbUrl(metadata.cover_url, metadata.id) : manga.cover,
    genres: metadata.genres?.length ? metadata.genres : manga.genres,
    tags: metadata.tags?.length ? metadata.tags : manga.tags,
    contentRating: metadata.content_rating || manga.contentRating, chapters };
}

type Waiter = { client: QueryClient; resolve: (value: CardMetadata | null) => void; reject: (error: unknown) => void };
let queued = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  const batch = queued; queued = new Map(); timer = undefined;
  const sources = [true, false].map(mdx => [...batch.keys()].filter(id => Boolean(normalizeMangaDexId(id)) === mdx));
  await Promise.all(sources.map(async ids => {
    for (let offset = 0; offset < ids.length; offset += 48) {
      const group = ids.slice(offset, offset + 48);
      try {
        const response = await mangaApi.getCardMetadata(group);
        for (const id of group) {
          const waiters = batch.get(id) || [];
          if (!(id in response.items)) {
            waiters.forEach(waiter => waiter.reject(new Error('Metadata temporarily unavailable')));
            continue;
          }
          const metadata = response.items[id] as CardMetadata | null;
          if (metadata) for (const client of new Set(waiters.map(waiter => waiter.client))) {
            patchMangaInQueryCache(client, [id, metadata.id], record => {
              const title = String(record.title || record.name || record.manga_title || '');
              if (!needsCanonicalTitle(id, title)) return record;
              const next: Record<string, any> = { ...record, title: metadata.title, contentRating: metadata.content_rating || record.contentRating };
              if ('name' in record) next.name = metadata.title;
              if ('manga_title' in record || 'manga_slug' in record) next.manga_title = metadata.title;
              if (metadata.cover_url) for (const field of ['thumb', 'thumb_url', 'cover_url', 'manga_thumb']) {
                if (field in record) next[field] = metadata.cover_url;
              }
              if (!record.genres?.length) next.genres = metadata.genres || [];
              if (!record.tags?.length) next.tags = metadata.tags || [];
              return next;
            });
          }
          waiters.forEach(waiter => waiter.resolve(metadata));
        }
      } catch (error) {
        group.forEach(id => batch.get(id)?.forEach(waiter => waiter.reject(error)));
      }
    }
  }));
}

export function requestCardMetadata(id: string, client: QueryClient): Promise<CardMetadata | null> {
  id = id.trim().toLowerCase();
  if (id.length > 200 || !/^[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(id)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    queued.set(id, [...(queued.get(id) || []), { client, resolve, reject }]);
    if (!timer) timer = setTimeout(() => void flush(), 30);
  });
}
