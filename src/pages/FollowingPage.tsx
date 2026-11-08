import { useFollows, useToggleFollow } from '@/hooks/useApi';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Heart, X, Loader2 } from 'lucide-react';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { getSavedMangaDetailPath, resolveSavedMangaCover } from '@/lib/savedManga';

const FollowingPage = () => {
  const { data: follows = [], isLoading } = useFollows();
  const toggleFollow = useToggleFollow();

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
        <Heart className="w-5 h-5 text-primary" />
        <h1 className="ed-heading text-2xl">Đang Theo Dõi</h1>
        <span className="text-sm text-muted-foreground">({follows.length})</span>
      </div>

      {follows.length === 0 ? (
        <div className="text-center py-20">
          <Heart className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">Chưa theo dõi truyện nào.</p>
          <Link to="/manga" className="text-primary text-sm font-bold mt-2 inline-block hover:underline">Khám phá truyện →</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
          {follows.map((f: any, i: number) => {
            const cover = resolveSavedMangaCover(f.manga_source_slug || f.manga_slug, f.manga_thumb, f.manga_thumb_fallback, 256);
            return (
              <motion.div
                key={f.manga_slug}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 3) * 0.05 }}
                className="group relative"
              >
                <Link to={getSavedMangaDetailPath(f)} className="block">
                  <div className="aspect-[3/4] rounded-lg overflow-hidden bg-muted">
                    <OptimizedImage
                      src={cover.primary}
                      fallbackSrc={cover.fallback}
                      alt={f.manga_title}
                      priority={i < 4}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  </div>
                  <p className="text-sm font-semibold mt-1.5 line-clamp-2">{f.manga_title}</p>
                </Link>
                <button
                  onClick={() => toggleFollow.mutate({ slug: f.manga_slug, title: f.manga_title, thumb: f.manga_thumb, isFollowing: true })}
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

export default FollowingPage;
