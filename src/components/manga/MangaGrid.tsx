import React from 'react';
import { Manga } from '@/types/manga';
import MangaCard from './MangaCard';
import { useSettingsStore } from '@/store/settingsStore';
import { isMatureManga } from '@/lib/contentFilter';

interface MangaGridProps {
  manga: Manga[];
  title?: string;
  variant?: 'default' | 'horizontal' | 'compact';
  columns?: 'default' | 'dense';
  lazyBatch?: boolean;
  initialBatchSize?: number;
  batchStep?: number;
  batchDelayMs?: number;
}

const MANGADEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESERVED_PUBLIC_MANGA_SLUGS = new Set([
  'admin',
  'api',
  'bookmarks',
  'browse',
  'chapter',
  'chapters',
  'completed',
  'history',
  'images',
  'img',
  'latest',
  'login',
  'manga',
  'none',
  'notifications',
  'null',
  'popular',
  'profile',
  'random',
  'ranking',
  'rankings',
  'read',
  'reader',
  'register',
  'search',
  'settings',
  'u',
  'undefined',
  'upload',
  'uploads',
]);

const normalizePublicMangaSlug = (value: unknown): string =>
  String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');

const isReservedPublicMangaSlug = (value: unknown): boolean => {
  const slug = normalizePublicMangaSlug(value);
  if (!slug || slug.length < 3) return true;
  if (MANGADEX_ID_RE.test(slug)) return false;
  if (slug.startsWith('mdx-') && MANGADEX_ID_RE.test(slug.slice(4))) return false;
  return RESERVED_PUBLIC_MANGA_SLUGS.has(slug);
};

const normalizeCardText = (value: unknown): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Ä‘/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasSyntheticRouteCover = (value: unknown): boolean => {
  const raw = String(value || '').trim().toLowerCase();
  return /(?:^|[/?=&%-])(browse|random|undefined|null|none)-thumb\./.test(raw);
};

const isGenericPlaceholderTitle = (value: unknown): boolean => {
  const normalized = normalizeCardText(value);
  return (
    !normalized ||
    normalized === 'chua co tieu de' ||
    normalized === 'dang cap nhat' ||
    normalized === 'mangadex' ||
    normalized === 'no title' ||
    normalized === 'untitled'
  );
};

const shouldHideInvalidMangaCard = (item: Manga): boolean => {
  if (isReservedPublicMangaSlug(item.id)) return true;

  const cover = String(item.cover || '').trim();
  const coverProxy = String(item.coverProxy || '').trim();
  const hasBadCover = hasSyntheticRouteCover(cover) || hasSyntheticRouteCover(coverProxy);
  const hasNoRealCover =
    !cover ||
    cover.endsWith('/no-cover.svg') ||
    cover.endsWith('/no-cover-dark.svg') ||
    cover.includes('/no-cover.svg') ||
    cover.includes('/no-cover-dark.svg');

  return isGenericPlaceholderTitle(item.title) && (hasBadCover || hasNoRealCover);
};

const MangaGrid = React.forwardRef<HTMLDivElement, MangaGridProps>(
  ({
    manga,
    title,
    variant = 'default',
    columns = 'default',
    lazyBatch = false,
    initialBatchSize = 8,
    batchStep = 4,
    batchDelayMs = 180,
  }, ref) => {
    const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
    const safeManga = React.useMemo(
      () => (Array.isArray(manga) ? manga.filter((item) => !shouldHideInvalidMangaCard(item)) : []),
      [manga],
    );
    const visibleManga = showMatureContent ? safeManga : safeManga.filter((item) => !isMatureManga(item));
    const shouldBatch = lazyBatch && variant === 'default';
    const safeInitialBatch = Math.max(1, initialBatchSize);
    const safeBatchStep = Math.max(1, batchStep);
    const safeBatchDelay = Math.max(60, batchDelayMs);
    const [renderCount, setRenderCount] = React.useState(
      shouldBatch ? Math.min(visibleManga.length, safeInitialBatch) : visibleManga.length,
    );

    React.useEffect(() => {
      setRenderCount(shouldBatch ? Math.min(visibleManga.length, safeInitialBatch) : visibleManga.length);
    }, [visibleManga.length, shouldBatch, safeInitialBatch]);

    React.useEffect(() => {
      if (!shouldBatch) return;
      if (renderCount >= visibleManga.length) return;

      const timer = window.setTimeout(() => {
        setRenderCount((prev) => Math.min(visibleManga.length, prev + safeBatchStep));
      }, safeBatchDelay);

      return () => window.clearTimeout(timer);
    }, [renderCount, visibleManga.length, shouldBatch, safeBatchStep, safeBatchDelay]);

    const renderItems = shouldBatch ? visibleManga.slice(0, renderCount) : visibleManga;

    if (variant === 'horizontal') {
      return (
        <div ref={ref}>
          {title && <h2 className="text-lg font-comic tracking-wide mb-3">{title}</h2>}
          <div className="space-y-0.5">
            {renderItems.map((m, i) => (
              <MangaCard key={m.id} manga={m} index={i} variant="horizontal" />
            ))}
          </div>
        </div>
      );
    }

    if (variant === 'compact') {
      return (
        <div ref={ref}>
          {title && <h2 className="text-lg font-comic tracking-wide mb-3">{title}</h2>}
          <div className="space-y-0">
            {renderItems.map((m, i) => (
              <MangaCard key={m.id} manga={m} index={i} variant="compact" />
            ))}
          </div>
        </div>
      );
    }

    const gridCols = columns === 'dense'
      ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8'
      : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';

    return (
      <div ref={ref}>
        {title && <h2 className="text-lg font-comic tracking-wide mb-3">{title}</h2>}
        <div className={`grid ${gridCols} gap-3 md:gap-4 items-stretch`}>
          {renderItems.map((m, i) => (
            <MangaCard key={m.id} manga={m} index={i} />
          ))}
        </div>
      </div>
    );
  }
);

MangaGrid.displayName = 'MangaGrid';

export default MangaGrid;
