import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { Manga } from '@/types/manga';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { getMangaDetailPath, normalizeMangaDexId } from '@/lib/mangaLinks';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const DEFAULT_COVER_FALLBACK = '/no-cover.svg';

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

const resolveMangaDexHeroCover = (cover?: string, fallback?: string): string => {
  const candidates = [cover, fallback].map((value) => String(value || '').trim()).filter(Boolean);
  const proxied = candidates.find(isImageProxyUrl);
  if (proxied) return proxied;

  for (const candidate of candidates) {
    const proxiedCandidate = toMangaDexProxyImageUrl(candidate);
    if (proxiedCandidate) return proxiedCandidate;
  }

  return candidates[0] || DEFAULT_COVER_FALLBACK;
};

const resolveMangaDexCurrentCover = (mangaId?: string): string => {
  const normalized = normalizeMangaDexId(String(mangaId || '').trim());
  if (!normalized) return '';
  return `${API_BASE}/api/manga/mangadex-cover/${encodeURIComponent(normalized)}`;
};

const isUsableCoverSrc = (value?: string): boolean => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  return !raw.includes('/no-cover.svg') && !raw.includes('/no-cover-dark.svg');
};

const HeroSlider = ({ manga }: { manga: Manga[] }) => {
  const [current, setCurrent] = useState(0);
  const items = manga.slice(0, 5);

  useEffect(() => {
    const timer = setInterval(() => setCurrent(prev => (prev + 1) % items.length), 6000);
    return () => clearInterval(timer);
  }, [items.length]);

  // A source fallback can replace five slides with a smaller QQ selection.
  const activeIndex = current < items.length ? current : 0;
  const m = items[activeIndex];
  if (!m) return null;

  const mangaDexId = normalizeMangaDexId(m.id);
  const isMangaDexManga = !!mangaDexId;
  const mangaDexFallbackCover = resolveMangaDexHeroCover(m.cover, m.coverProxy);
  const mangaDexCurrentCover = resolveMangaDexCurrentCover(m.id);
  const heroCoverSrc = isMangaDexManga
    ? (isUsableCoverSrc(mangaDexFallbackCover) ? mangaDexFallbackCover : (mangaDexCurrentCover || DEFAULT_COVER_FALLBACK))
    : m.cover;
  const heroCoverFallbackSrc = isMangaDexManga
    ? (mangaDexCurrentCover || (isUsableCoverSrc(mangaDexFallbackCover) ? mangaDexFallbackCover : DEFAULT_COVER_FALLBACK))
    : (String(m.coverProxy || '').trim() || DEFAULT_COVER_FALLBACK);
  const chapterCandidates = (m.chapters || []).filter((chapter) => {
    const chapterId = String(chapter?.id || '').trim();
    if (!chapterId) return false;
    if (isMangaDexManga) {
      if (!normalizeMangaDexId(chapterId)) return false;
    } else if (chapterId.startsWith('ch-')) {
      return false;
    }
    return true;
  });
  const validNumberChapters = chapterCandidates
    .filter((chapter) => Number.isFinite(Number(chapter.number)) && Number(chapter.number) >= 0)
    .sort((a, b) => Number(a.number) - Number(b.number));
  const latestReadableChapter = validNumberChapters[validNumberChapters.length - 1] || null;
  const startChapter = validNumberChapters[0] || null;
  const detailPath = getMangaDetailPath(m.id);
  const readNowTarget = startChapter ? `/chapter/${startChapter.id}` : detailPath;
  const readNowState = startChapter
    ? {
        mangaSlug: m.slug || m.id,
        mangaId: m.id,
        mangaTitle: m.title,
        mangaThumb: m.cover,
        chapterNumber: startChapter.number,
        chapterTitle: startChapter.title,
        chapters: validNumberChapters.map((chapter) => ({
          id: chapter.id,
          number: chapter.number,
          title: chapter.title,
        })),
      }
    : undefined;

  return (
    <div className="relative w-full h-[320px] md:h-[420px] rounded-lg overflow-hidden group border border-border">
      <AnimatePresence mode="wait">
        <motion.div key={m.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }} className="absolute inset-0">
          <OptimizedImage src={heroCoverSrc} fallbackSrc={heroCoverFallbackSrc} fallbackDelayMs={isMangaDexManga ? 12000 : undefined} maxRetries={isMangaDexManga ? 5 : 2} alt={m.title} className="w-full h-full object-cover scale-115 blur-[2px] opacity-85" priority />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0)_70%)]" />
          <div className="absolute inset-0 p-0 md:p-1">
            <OptimizedImage src={heroCoverSrc} fallbackSrc={heroCoverFallbackSrc} fallbackDelayMs={isMangaDexManga ? 12000 : undefined} maxRetries={isMangaDexManga ? 5 : 2} alt={m.title} className="w-full h-full object-contain scale-[1.03] brightness-95 saturate-100 drop-shadow-[0_10px_30px_rgba(0,0,0,0.35)]" priority />
          </div>
          <div className="absolute inset-0 bg-gradient-to-r from-foreground/84 via-foreground/62 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-foreground/52 via-transparent to-transparent" />
        </motion.div>
      </AnimatePresence>

      <div className="absolute inset-0 flex items-end md:items-center p-6 md:p-10 z-10">
        <AnimatePresence mode="wait">
          <motion.div key={m.id + '-c'} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.4, delay: 0.1 }} className="max-w-lg drop-shadow-[0_2px_10px_rgba(0,0,0,0.55)]">
            <div className="flex items-center gap-2 mb-3">
              <span className="px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary text-primary-foreground">
                Nổi bật
              </span>
              <span className="flex items-center gap-1 text-xs font-bold text-manga-yellow">
                <Star className="w-3 h-3 fill-manga-yellow" /> {Number(m.rating).toFixed(1)}
              </span>
            </div>
            <h2 className="ed-heading text-3xl md:text-5xl text-white mb-1 line-clamp-2 leading-[1.1]">{m.title}</h2>
            {m.altTitle && <p className="text-sm text-white/70 mb-2">{m.altTitle}</p>}
            {latestReadableChapter && (
              <p className="text-xs text-white/80 font-semibold mb-2">
                Chương {latestReadableChapter.number}
              </p>
            )}
            <p className="text-sm text-white/80 line-clamp-2 mb-4 max-w-md">{m.description}</p>
            <div className="flex flex-wrap gap-1.5 mb-5">
              {m.genres.map(g => (
                <span key={g} className="px-2 py-0.5 rounded text-[10px] font-semibold text-white/80 border border-white/25 bg-white/10">
                  {g}
                </span>
              ))}
            </div>
            <div className="flex gap-3">
              <Link to={readNowTarget}
                state={readNowState}
                className="px-5 py-2 rounded-lg bg-primary text-primary-foreground font-bold text-sm hover:brightness-110 transition-all flex items-center gap-2">
                Đọc ngay <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to={detailPath}
                state={{ previewManga: m }}
                className="px-5 py-2 rounded-lg bg-white/15 text-white font-bold text-sm hover:bg-white/25 transition-all border border-white/25">
                Chi tiết
              </Link>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <button onClick={() => setCurrent(c => (c - 1 + items.length) % items.length)}
        className="absolute left-3 top-1/2 -translate-y-1/2 z-20 p-2 rounded-lg bg-background/80 border border-border opacity-0 group-hover:opacity-100 transition-all hover:bg-background">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button onClick={() => setCurrent(c => (c + 1) % items.length)}
        className="absolute right-3 top-1/2 -translate-y-1/2 z-20 p-2 rounded-lg bg-background/80 border border-border opacity-0 group-hover:opacity-100 transition-all hover:bg-background">
        <ChevronRight className="w-4 h-4" />
      </button>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
        {items.map((_, i) => (
          <button key={i} onClick={() => setCurrent(i)}
            className={`h-1 rounded-full transition-all duration-400 ${
              i === activeIndex ? 'w-8 bg-primary' : 'w-2.5 bg-background/40 hover:bg-background/60'
            }`} />
        ))}
      </div>
    </div>
  );
};

export default HeroSlider;
