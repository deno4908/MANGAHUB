import { useBookmarks, useToggleBookmark } from '@/hooks/useApi';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bookmark, X, Loader2 } from 'lucide-react';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { thumbUrl, thumbFallbackUrl } from '@/lib/adapters';
import { getMangaDetailPath } from '@/lib/mangaLinks';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function resolveCoverSources(slug: string, thumb?: string): { src: string; fallback?: string } {
  const raw = String(thumb || '').trim();
  const safeSlug = String(slug || '').trim();
  if (raw && /^https?:\/\//i.test(raw)) {
    return { src: raw, fallback: thumbFallbackUrl(raw, safeSlug) || undefined };
  }
  if (raw) {
    const resolved = thumbUrl(raw, safeSlug);
    if (/^https?:\/\/img\.otruyenapi\.com/i.test(resolved)) {
      return {
        src: `${API_BASE}/api/images/img?url=${encodeURIComponent(resolved)}`,
        fallback: thumbFallbackUrl(raw, safeSlug) || resolved,
      };
    }
    return { src: resolved, fallback: thumbFallbackUrl(raw, safeSlug) || undefined };
  }
  if (safeSlug) {
    const cdnUrl = thumbUrl('', safeSlug);
    return {
      src: `${API_BASE}/api/images/img?url=${encodeURIComponent(cdnUrl)}`,
      fallback: cdnUrl,
    };
  }
  return { src: '' };
}

const BookmarksPage = () => {
  const { data: bookmarks = [], isLoading } = useBookmarks();
  const toggleBookmark = useToggleBookmark();

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-20 flex justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="accent-line" />
        <Bookmark className="w-5 h-5 text-primary" />
        <h1 className="ed-heading text-2xl">Truyện Đã Lưu</h1>
        <span className="text-sm text-muted-foreground">({bookmarks.length})</span>
      </div>

      {bookmarks.length === 0 ? (
        <div className="text-center py-20">
          <Bookmark className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">Chưa lưu truyện nào.</p>
          <Link to="/manga" className="text-primary text-sm font-bold mt-2 inline-block hover:underline">Khám phá truyện →</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
          {bookmarks.map((bm: any, i: number) => {
            const cover = resolveCoverSources(bm.manga_slug, bm.manga_thumb);
            return (
            <motion.div
              key={bm.manga_slug}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="group relative"
            >
              <Link to={getMangaDetailPath(bm.manga_slug)} className="block">
                <div className="aspect-[3/4] rounded-lg overflow-hidden bg-muted">
                  <OptimizedImage
                    src={cover.src}
                    fallbackSrc={cover.fallback}
                    alt={bm.manga_title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
                <p className="text-sm font-semibold mt-1.5 line-clamp-2">{bm.manga_title}</p>
              </Link>
              <button
                onClick={() => toggleBookmark.mutate({ slug: bm.manga_slug, title: bm.manga_title, thumb: bm.manga_thumb, isBookmarked: true })}
                className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-background/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/20"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BookmarksPage;
