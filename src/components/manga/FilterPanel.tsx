import { useQueryClient } from '@tanstack/react-query';
import { useCategories } from '@/hooks/useApi';
import { useMangaStore } from '@/store/mangaStore';
import { mangaApi } from '@/lib/api';
import { adaptListData } from '@/lib/adapters';
import TagBadge from './TagBadge';
import { X, SlidersHorizontal, TrendingUp, Clock3, Star, ArrowUpAZ } from 'lucide-react';

const statusVi: Record<string, string> = {
  ongoing: 'Đang ra',
  completed: 'Hoàn thành',
  hiatus: 'Sắp ra mắt',
};

const FilterPanel = () => {
  const { filters, setFilter, resetFilters } = useMangaStore();
  const { data: categories = [] } = useCategories();
  const queryClient = useQueryClient();

  const prefetchGenre = (slug: string, pages: number[] = [1]) => {
    if (!slug) return;
    pages.forEach((page) => {
      queryClient.prefetchQuery({
        queryKey: ['manga', 'category', slug, page],
        queryFn: async () => adaptListData(await mangaApi.getCategoryManga(slug, page)),
        staleTime: 2 * 60 * 1000,
        gcTime: 2 * 60 * 1000,
      });
    });
  };

  const toggleGenre = (slug: string) => {
    const genres = filters.genres.includes(slug)
      ? filters.genres.filter(g => g !== slug)
      : [slug]; // OTruyen only supports 1 genre at a time
    setFilter('genres', genres);
  };

  const statuses = ['ongoing', 'completed', 'hiatus'] as const;
  const years = Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - i);
  const sorts = [
    { value: 'popular' as const, label: 'Phổ biến', icon: TrendingUp },
    { value: 'latest' as const, label: 'Mới nhất', icon: Clock3 },
    { value: 'rating' as const, label: 'Đánh giá', icon: Star },
    { value: 'alphabetical' as const, label: 'A-Z', icon: ArrowUpAZ },
  ];

  const hasFilters = filters.genres.length > 0 || filters.status || filters.year || filters.minRating > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal className="w-4 h-4 text-primary" />
        <h3 className="font-comic text-base text-gradient">Bộ lọc</h3>
      </div>

      {/* Sort */}
      <div>
        <h4 className="text-xs font-bold mb-2 text-foreground/80 uppercase tracking-wider">Sắp xếp</h4>
        <div className="flex flex-wrap gap-1.5">
          {sorts.map(s => (
            <button
              key={s.value}
              onClick={() => setFilter('sort', s.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filters.sort === s.value
                  ? 'bg-primary text-primary-foreground comic-shadow'
                  : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
              }`}
            >
              <span className="inline-flex items-center gap-1"><s.icon className="w-3.5 h-3.5" /> {s.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Genres */}
      <div>
        <h4 className="text-xs font-bold mb-2 text-foreground/80 uppercase tracking-wider">Thể loại</h4>
        <div className="flex flex-wrap gap-1.5">
          {categories.map(cat => (
            <TagBadge
              key={cat.slug}
              tag={cat.name}
              active={filters.genres.includes(cat.slug)}
              onMouseEnter={() => {
                if (cat.source === 'mangadex') return;
                prefetchGenre(cat.slug, [1]);
              }}
              onClick={() => {
                if (cat.source !== 'mangadex') {
                  prefetchGenre(cat.slug, [1]);
                }
                toggleGenre(cat.slug);
              }}
            />
          ))}
        </div>
      </div>

      {/* Status */}
      <div>
        <h4 className="text-xs font-bold mb-2 text-foreground/80 uppercase tracking-wider">Trạng thái</h4>
        <div className="flex flex-wrap gap-1.5">
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => setFilter('status', filters.status === s ? null : s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filters.status === s
                  ? 'bg-primary text-primary-foreground comic-shadow'
                  : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
              }`}
            >
              {statusVi[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Year */}
      <div>
        <h4 className="text-xs font-bold mb-2 text-foreground/80 uppercase tracking-wider">Năm</h4>
        <div className="flex flex-wrap gap-1.5">
          {years.map(y => (
            <button
              key={y}
              onClick={() => setFilter('year', filters.year === y ? null : y)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filters.year === y
                  ? 'bg-primary text-primary-foreground comic-shadow'
                  : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Rating */}
      <div>
        <h4 className="text-xs font-bold mb-2 text-foreground/80 uppercase tracking-wider">Đánh giá tối thiểu</h4>
        <div className="flex flex-wrap gap-1.5">
          {[0, 3, 3.5, 4, 4.5].map(r => (
            <button
              key={r}
              onClick={() => setFilter('minRating', r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filters.minRating === r
                  ? 'bg-primary text-primary-foreground comic-shadow'
                  : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
              }`}
            >
              {r === 0 ? 'Tất cả' : <span className="inline-flex items-center gap-1">{r}+ <Star className="w-3.5 h-3.5" /></span>}
            </button>
          ))}
        </div>
      </div>

      {hasFilters && (
        <button
          onClick={resetFilters}
          className="flex items-center gap-1.5 text-xs font-bold text-manga-red hover:underline mt-2"
        >
          <X className="w-3 h-3" />
          Xoá bộ lọc
        </button>
      )}
    </div>
  );
};

export default FilterPanel;
