import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Star, Eye, Clock, ArrowRight } from 'lucide-react';
import { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import { adaptMangaDetail } from '@/lib/adapters';
import { getMangaDetailPath, getMangaSource } from '@/lib/mangaLinks';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { useCallback } from 'react';

interface MangaCardProps {
  manga: Manga;
  index?: number;
  variant?: 'default' | 'horizontal' | 'compact';
}

const statusVi: Record<string, string> = { ongoing: 'Đang ra', completed: 'Hoàn thành', hiatus: 'Sắp ra mắt', cancelled: 'Đã huỷ' };
const statusClass: Record<string, string> = {
  ongoing: 'tag-ongoing',
  completed: 'tag-completed',
  hiatus: 'tag-hiatus',
  cancelled: 'tag-cancelled',
};
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const DEFAULT_CARD_COVER_FALLBACK = '/no-cover.svg';

const isImageProxyUrl = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    return new URL(raw, API_BASE).pathname === '/api/images/img';
  } catch {
    return false;
  }
};

const isMangaDexImageUrl = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith('uploads.mangadex.org') || host.endsWith('mangadex.network');
  } catch {
    return false;
  }
};

const toMangaDexProxyImageUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isImageProxyUrl(raw)) return raw;
  if (!isMangaDexImageUrl(raw)) return '';
  return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
};

const resolveMangaDexCardCover = (cover?: string, fallback?: string): string => {
  const candidates = [cover, fallback].map((value) => String(value || '').trim()).filter(Boolean);
  const proxied = candidates.find(isImageProxyUrl);
  if (proxied) return proxied;

  for (const candidate of candidates) {
    const proxiedCandidate = toMangaDexProxyImageUrl(candidate);
    if (proxiedCandidate) return proxiedCandidate;
  }

  return candidates[0] || DEFAULT_CARD_COVER_FALLBACK;
};

const formatCompactViews = (value: number): string => {
  const views = Math.max(0, Math.floor(Number(value) || 0));
  if (views < 1_000) return views.toLocaleString('vi-VN');
  if (views < 1_000_000) {
    const compact = views / 1_000;
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const compact = views / 1_000_000;
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, '')}M`;
};

const normalizeLooseText = (value: string): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const looksLikeRelativeTimeText = (value: string): boolean =>
  /\b(ago|truoc|trc|gio|phut|ngay|tuan|thang|nam|h)\b/.test(normalizeLooseText(value));

const isValidChapterNumber = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const parseChapterNumberFromText = (value: string): number => {
  const raw = String(value ?? '').trim();
  if (!raw) return Number.NaN;

  const direct = Number(raw.replace(',', '.'));
  if (isValidChapterNumber(direct)) return direct;

  const normalized = normalizeLooseText(raw);
  if (!normalized) return Number.NaN;

  const keywordMatch = normalized.match(/\b(?:chapter|chuong|ch)\.?\s*(\d+(?:[.,]\d+)?)/i);
  if (keywordMatch) {
    const parsed = Number(keywordMatch[1].replace(',', '.'));
    if (isValidChapterNumber(parsed)) return parsed;
  }

  if (looksLikeRelativeTimeText(normalized)) return Number.NaN;

  const leadingMatch = normalized.match(/^(\d+(?:[.,]\d+)?)(?=$|[\s)\]-])/);
  if (!leadingMatch) return Number.NaN;

  const parsed = Number(leadingMatch[1].replace(',', '.'));
  return isValidChapterNumber(parsed) ? parsed : Number.NaN;
};

const formatChapterNumber = (value: number): string => {
  if (!isValidChapterNumber(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(value)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
};

const resolveReadableChapterNumber = (chapter: Manga['chapters'][number] | undefined): number => {
  if (!chapter) return Number.NaN;
  if (
    chapter.number !== null &&
    chapter.number !== undefined &&
    isValidChapterNumber(Number(chapter.number))
  ) {
    return Number(chapter.number);
  }
  return parseChapterNumberFromText(String(chapter.title || ''));
};

function chapterDisplay(
  lastChapter: Manga['chapters'][number] | undefined,
  status?: Manga['status'],
  isMangaDexItem = false,
): string {
  const fallbackLabel = isMangaDexItem
    ? 'Chưa có dữ liệu chương'
    : (status === 'hiatus' ? 'Sắp ra mắt' : 'Đang cập nhật');

  if (!lastChapter) return fallbackLabel;

  const chapterNumber = resolveReadableChapterNumber(lastChapter);
  if (isValidChapterNumber(chapterNumber)) {
    const formatted = formatChapterNumber(chapterNumber);
    return formatted ? `Chương ${formatted}` : fallbackLabel;
  }

  const title = String(lastChapter.title || '').trim();
  if (!title) return fallbackLabel;

  const normalizedTitle = normalizeLooseText(title);
  const isKnownPlaceholder =
    normalizedTitle === 'mangadex' ||
    normalizedTitle === 'sap ra mat' ||
    normalizedTitle === 'dang cap nhat' ||
    normalizedTitle === 'chua co du lieu chuong';
  const isNoisyPlaceholder = looksLikeRelativeTimeText(title);

  if (isKnownPlaceholder) return fallbackLabel;
  if (isNoisyPlaceholder && !isKnownPlaceholder) return fallbackLabel;

  return title;
}

function isPlaceholderChapter(ch: Manga['chapters'][number] | undefined): boolean {
  return !!ch && ch.number === -1;
}

function chapterTimeLabel(
  ch: Manga['chapters'][number] | undefined,
  mangaLastUpdated?: string,
): string {
  if (ch && !isPlaceholderChapter(ch)) {
    const chapterTime = timeAgoVi(ch.uploadDate);
    if (chapterTime) return chapterTime;
  }

  const mangaTime = timeAgoVi(mangaLastUpdated || '');
  if (!mangaTime) return '';
  return mangaTime;
}

function chapterSortTimestamp(ch?: Manga['chapters'][number]): number {
  if (!ch) return 0;
  const ts = Date.parse(String(ch.uploadDate || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function pickLatestChapter(chapters: Manga['chapters']): Manga['chapters'][number] | undefined {
  if (!Array.isArray(chapters) || chapters.length === 0) return undefined;

  return [...chapters].sort((a, b) => {
    const numberDiff = Number(b?.number || 0) - Number(a?.number || 0);
    if (numberDiff !== 0) return numberDiff;

    const timeDiff = chapterSortTimestamp(b) - chapterSortTimestamp(a);
    if (timeDiff !== 0) return timeDiff;

    return String(b?.id || '').localeCompare(String(a?.id || ''));
  })[0];
}

const MangaCard = ({ manga, index = 0, variant = 'default' }: MangaCardProps) => {
  const lastChapter = pickLatestChapter(manga.chapters);
  const chapterTime = chapterTimeLabel(lastChapter, manga.lastUpdated);
  const queryClient = useQueryClient();
  const isMangaDexItem = getMangaSource(manga.id, manga.source) === 'mangadex';
  const chapterLabel = chapterDisplay(lastChapter, manga.status, isMangaDexItem);
  const chapterMetaLabel = chapterTime ? `${chapterLabel} - ${chapterTime}` : chapterLabel;
  const safeCoverFallback = String(manga.coverProxy || '').trim() || DEFAULT_CARD_COVER_FALLBACK;
  const coverSrc = isMangaDexItem
    ? resolveMangaDexCardCover(manga.cover, manga.coverProxy)
    : manga.cover;
  const coverFallbackSrc = isMangaDexItem ? DEFAULT_CARD_COVER_FALLBACK : safeCoverFallback;
  const coverFallbackDelayMs = isMangaDexItem ? 12000 : undefined;
  const detailLinkState = { previewManga: manga };
  const detailPath = getMangaDetailPath(manga.id);
  const ratingLabel = Number(manga.rating).toFixed(1);
  const rawViewCount = Math.max(0, Math.floor(Number(manga.views) || 0));
  const localMangaDexViewCount = Math.max(
    0,
    Math.floor(Number((manga as any).localViewCount ?? (manga as any).local_view_count ?? 0) || 0),
  );
  const mangaDexPopularityScore = Math.max(
    0,
    Number(
      (manga as any).mangadexPopularityScore ??
      (manga as any).mangadex_popularity_score ??
      (manga as any).popularityScore ??
      (manga as any).popularity_score ??
      0,
    ) || 0,
  );
  const viewCount =
    isMangaDexItem && localMangaDexViewCount <= 0 && mangaDexPopularityScore > 0 && rawViewCount > 0
      ? 0
      : isMangaDexItem && rawViewCount >= 900_000
      ? localMangaDexViewCount
      : rawViewCount;
  const viewCountLabel = formatCompactViews(viewCount);
  const fullViewCountLabel = `${viewCount.toLocaleString('vi-VN')} lượt xem`;
  const coverMetrics = (
    <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
      <div className="flex items-center gap-0.5 bg-card/90 backdrop-blur-sm rounded px-1.5 py-0.5 border border-border">
        <Star className="w-3 h-3 text-manga-yellow fill-manga-yellow" />
        <span className="text-[10px] font-bold">{ratingLabel}</span>
      </div>
      <div
        className="flex items-center gap-0.5 bg-card/90 backdrop-blur-sm rounded px-1.5 py-0.5 border border-border"
        title={fullViewCountLabel}
      >
        <Eye className="w-3 h-3 text-primary" />
        <span className="text-[10px] font-bold">{viewCountLabel}</span>
      </div>
    </div>
  );

  const prefetchDetail = useCallback(() => {
    if (manga.externalUrl || isMangaDexItem) return;
    const detailLookupId = manga.slug || manga.id;
    const prefetchKey = ['manga', 'detail', detailLookupId, 'otruyen', 'otruyen'] as const;
    if (queryClient.getQueryData(prefetchKey)) return;
    queryClient.prefetchQuery({
      queryKey: prefetchKey,
      queryFn: async () => {
        const data = await mangaApi.getDetail(detailLookupId);
        return adaptMangaDetail(data);
      },
      staleTime: 2 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
    });
  }, [isMangaDexItem, manga.externalUrl, manga.id, manga.slug, queryClient]);

  if (variant === 'horizontal') {
    if (manga.externalUrl) {
      return (
        <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, delay: index * 0.04 }}>
          <a href={manga.externalUrl} target="_blank" rel="noreferrer" className="group flex gap-3.5 p-3 rounded-lg hover:bg-muted/60 transition-all border border-transparent hover:border-border">
            <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-14 h-[78px] object-cover rounded shrink-0 border border-border" priority={index < 4} rootMargin="140px" />
            <div className="flex-1 min-w-0 py-0.5">
              <h3 className="text-sm font-semibold line-clamp-2 group-hover:text-primary transition-colors">{manga.title}</h3>
              <div className="flex items-center gap-2.5 mt-1.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><Star className="w-3 h-3 text-manga-yellow fill-manga-yellow" /> {ratingLabel}</span>
                <span className="flex items-center gap-1" title={fullViewCountLabel}><Eye className="w-3 h-3" /> {viewCountLabel}</span>
              </div>
              {manga.myRating != null && (
                <p className="text-[11px] font-semibold text-primary mt-1">Bạn: {manga.myRating}★</p>
              )}
              {lastChapter && (
                <p className="text-[11px] text-primary font-medium mt-1.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {chapterMetaLabel}
                </p>
              )}
            </div>
          </a>
        </motion.div>
      );
    }
    return (
      <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, delay: index * 0.04 }}>
        <Link to={detailPath} state={detailLinkState} className="group flex gap-3.5 p-3 rounded-lg hover:bg-muted/60 transition-all border border-transparent hover:border-border" onMouseEnter={prefetchDetail}>
          <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-14 h-[78px] object-cover rounded shrink-0 border border-border" priority={index < 4} rootMargin="140px" />
          <div className="flex-1 min-w-0 py-0.5">
            <h3 className="text-sm font-semibold line-clamp-2 group-hover:text-primary transition-colors">{manga.title}</h3>
            <div className="flex items-center gap-2.5 mt-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><Star className="w-3 h-3 text-manga-yellow fill-manga-yellow" /> {ratingLabel}</span>
              <span className="flex items-center gap-1" title={fullViewCountLabel}><Eye className="w-3 h-3" /> {viewCountLabel}</span>
            </div>
            {manga.myRating != null && (
              <p className="text-[11px] font-semibold text-primary mt-1">Bạn: {manga.myRating}★</p>
            )}
            {lastChapter && (
              <p className="text-[11px] text-primary font-medium mt-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> {chapterMetaLabel}
              </p>
            )}
          </div>
        </Link>
      </motion.div>
    );
  }

  if (variant === 'compact') {
    if (manga.externalUrl) {
      return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: index * 0.03 }}>
          <a href={manga.externalUrl} target="_blank" rel="noreferrer" className="group flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-muted/60 transition-all">
            <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-10 h-14 object-cover rounded shrink-0 border border-border" priority={index < 4} rootMargin="140px" />
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-semibold line-clamp-1 group-hover:text-primary transition-colors">{manga.title}</h3>
              {lastChapter && isValidChapterNumber(Number(lastChapter.number)) ? (
                <p className="text-[10px] text-muted-foreground mt-0.5">Chương {lastChapter.number}</p>
              ) : (
                <p className="text-[10px] text-muted-foreground mt-0.5">{manga.author}</p>
              )}
            </div>
            <div className="shrink-0 flex flex-col items-end gap-0.5 text-[10px]">
              <span className="text-manga-yellow font-bold flex items-center gap-0.5">
                <Star className="w-2.5 h-2.5 fill-manga-yellow" /> {ratingLabel}
              </span>
              <span className="text-muted-foreground font-semibold flex items-center gap-0.5" title={fullViewCountLabel}>
                <Eye className="w-2.5 h-2.5" /> {viewCountLabel}
              </span>
            </div>
          </a>
        </motion.div>
      );
    }
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: index * 0.03 }}>
        <Link to={detailPath} state={detailLinkState} className="group flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-muted/60 transition-all" onMouseEnter={prefetchDetail}>
          <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-10 h-14 object-cover rounded shrink-0 border border-border" priority={index < 4} rootMargin="140px" />
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold line-clamp-1 group-hover:text-primary transition-colors">{manga.title}</h3>
            {lastChapter && isValidChapterNumber(Number(lastChapter.number)) ? (
              <p className="text-[10px] text-muted-foreground mt-0.5">Chương {lastChapter.number}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground mt-0.5">{manga.author}</p>
            )}
          </div>
          <div className="shrink-0 flex flex-col items-end gap-0.5 text-[10px]">
            <span className="text-manga-yellow font-bold flex items-center gap-0.5">
              <Star className="w-2.5 h-2.5 fill-manga-yellow" /> {ratingLabel}
            </span>
            <span className="text-muted-foreground font-semibold flex items-center gap-0.5" title={fullViewCountLabel}>
              <Eye className="w-2.5 h-2.5" /> {viewCountLabel}
            </span>
          </div>
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div className="h-full" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: index * 0.04 }}>
      {manga.externalUrl ? (
        <a href={manga.externalUrl} target="_blank" rel="noreferrer" className="group block h-full">
          <div className="ed-card h-full flex flex-col">
            <div className="relative aspect-[2/3] overflow-hidden">
              <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" priority={index < 4} rootMargin="140px" />
              <div className="absolute inset-0 bg-gradient-to-t from-foreground/90 via-foreground/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3">
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary-foreground bg-primary px-3 py-1 rounded w-fit">
                  Đọc ngay <ArrowRight className="w-3 h-3" />
                </span>
              </div>
              <div className="absolute top-2 left-2">
                <span className={`tag-pill ${statusClass[manga.status] || 'tag-pill'}`}>
                  {statusVi[manga.status]}
                </span>
              </div>
              {coverMetrics}
            </div>
            <div className="p-2.5 flex flex-col flex-1">
              <h3 className="text-[13px] font-semibold line-clamp-2 leading-snug min-h-[36px] group-hover:text-primary transition-colors">
                {manga.title}
              </h3>
              <p className="text-[10px] text-muted-foreground font-medium mt-1 truncate min-h-[16px]">
                {chapterMetaLabel}
              </p>
              {manga.myRating != null && (
                <p className="text-[10px] font-semibold text-primary mt-1">Bạn: {manga.myRating}★</p>
              )}
              <div className="flex flex-wrap gap-1 mt-auto pt-1.5 min-h-[24px]">
                {manga.genres.slice(0, 2).map(g => (
                  <span key={g} className="px-1.5 py-0.5 rounded text-[8px] bg-muted text-muted-foreground font-medium uppercase tracking-wide">
                    {g}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </a>
      ) : (
      <Link to={detailPath} state={detailLinkState} className="group block h-full" onMouseEnter={prefetchDetail}>
        <div className="ed-card h-full flex flex-col">
          <div className="relative aspect-[2/3] overflow-hidden">
            <OptimizedImage src={coverSrc} fallbackSrc={coverFallbackSrc} fallbackDelayMs={coverFallbackDelayMs} alt={manga.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" priority={index < 4} rootMargin="140px" />
            
            {/* Hover overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-foreground/90 via-foreground/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3">
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary-foreground bg-primary px-3 py-1 rounded w-fit">
                Đọc ngay <ArrowRight className="w-3 h-3" />
              </span>
            </div>

            {/* Status */}
            <div className="absolute top-2 left-2">
              <span className={`tag-pill ${statusClass[manga.status] || 'tag-pill'}`}>
                {statusVi[manga.status]}
              </span>
            </div>

            {/* Rating */}
            {coverMetrics}
          </div>

          <div className="p-2.5 flex flex-col flex-1">
            <h3 className="text-[13px] font-semibold line-clamp-2 leading-snug min-h-[36px] group-hover:text-primary transition-colors">
              {manga.title}
            </h3>
            <p className="text-[10px] text-muted-foreground font-medium mt-1 truncate min-h-[16px]">
              {chapterMetaLabel}
            </p>
            {manga.myRating != null && (
              <p className="text-[10px] font-semibold text-primary mt-1">Bạn: {manga.myRating}★</p>
            )}
            <div className="flex flex-wrap gap-1 mt-auto pt-1.5 min-h-[24px]">
              {manga.genres.slice(0, 2).map(g => (
                <span key={g} className="px-1.5 py-0.5 rounded text-[8px] bg-muted text-muted-foreground font-medium uppercase tracking-wide">
                  {g}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Link>
      )}
    </motion.div>
  );
};

function timeAgoVi(dateStr: string): string {
  const ts = Date.parse(String(dateStr || ''));
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) {
    if (Math.abs(diff) < 5 * 60 * 1000) return 'Vừa xong';
    return new Date(ts).toLocaleDateString('vi-VN');
  }
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'Vừa xong';
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngày trước`;
  if (days < 30) return `${Math.floor(days / 7)} tuần trước`;
  return new Date(ts).toLocaleDateString('vi-VN');
}

export default MangaCard;
