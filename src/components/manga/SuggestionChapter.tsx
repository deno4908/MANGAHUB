import { useCardChapter } from '@/hooks/useCardChapter';
import type { Manga } from '@/types/manga';

export default function SuggestionChapter({ manga }: { manga: Manga }) {
  const resolved = useCardChapter(manga);
  // Hydration prepends the verified chapter. Search responses may still carry
  // a placeholder at the end, so do not treat the final array item as newest.
  const chapters = resolved.chapters || [];
  const numbered = chapters.filter(chapter => Number.isFinite(chapter.number) && chapter.number >= 0);
  const latest = numbered.reduce<(typeof chapters)[number] | undefined>(
    (best, chapter) => !best || chapter.number > best.number ? chapter : best, undefined,
  ) || chapters[0];
  if (!latest) return <>Đang cập nhật</>;
  if (Number.isFinite(latest.number) && latest.number >= 0) return <>Chương {latest.number}</>;
  return <>{String(latest.title || 'Đang cập nhật').trim()}</>;
}
