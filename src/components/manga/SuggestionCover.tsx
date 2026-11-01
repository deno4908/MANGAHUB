import OptimizedImage from '@/components/ui/OptimizedImage';
import { resolveSavedMangaCover } from '@/lib/savedManga';
import type { Manga } from '@/types/manga';

export default function SuggestionCover({ manga }: { manga: Manga }) {
  const cover = resolveSavedMangaCover(manga.id, manga.cover, undefined, 256);
  return <OptimizedImage src={cover.primary} fallbackSrc={cover.fallback} priority maxRetries={1}
    alt="" className="w-8 h-11 shrink-0 rounded object-cover border border-border" />;
}
