import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { mangaApi } from '@/lib/api';
import { adaptListData } from '@/lib/adapters';
import { isMatureManga } from '@/lib/contentFilter';
import { useSettingsStore } from '@/store/settingsStore';
import MangaGrid from '@/components/manga/MangaGrid';
import MangaPagination from '@/components/manga/MangaPagination';
import MangaSourceTabs from '@/components/manga/MangaSourceTabs';
import { MangaGridSkeleton } from '@/components/manga/Skeletons';
import { BookOpen, SlidersHorizontal, X } from 'lucide-react';

const sortOptions = [['popular', 'Phổ biến'], ['latest', 'Mới nhất'],
  ['favorites', 'Được lưu nhiều'], ['alphabetical', 'A–Z']] as const;

export default function MoeBrowseManga() {
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const showMature = useSettingsStore(state => state.settings.privacy.showMatureContent);
  const client = useQueryClient();
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const sort = sortOptions.some(([value]) => value === params.get('sort')) ? params.get('sort')! : 'latest';
  const status = ['ongoing', 'completed', 'hiatus'].includes(params.get('status') || '') ? params.get('status')! : '';
  const genres = [...new Set((params.get('genre') || '').split(',').filter(Boolean))].sort();
  const keyword = params.get('keyword') || '';
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set('source', 'moetruyen');
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };
  const categories = useQuery({ queryKey: ['manga', 'moetruyen', 'categories'],
    queryFn: async () => (await mangaApi.getMoeCategories()).data.items as Array<{ name: string; slug: string }>,
    staleTime: 60 * 60_000, retry: 1,
  });
  const options = (target: number) => ({
    queryKey: ['manga', 'moetruyen', 'browse-v1', target, sort, status, genres, keyword, showMature],
    queryFn: async ({ signal }: { signal: AbortSignal }) => adaptListData(await mangaApi.getMoeFiltered({
      page: target, limit: 24, sort, status, genreSlugs: genres, keyword, showMature, attachRatings: true, signal,
    })),
    staleTime: 60_000, gcTime: 10 * 60_000,
  });
  const query = useQuery({ ...options(page), retry: 1, refetchOnWindowFocus: false });
  const items = (query.data?.items || []).filter(item => showMature || !isMatureManga(item));
  const panel = <div className="space-y-5">
    <div className="flex items-center gap-2 font-bold"><SlidersHorizontal className="h-4 w-4 text-primary" />Bộ lọc</div>
    <fieldset><legend className="mb-2 text-xs font-bold uppercase text-muted-foreground">Sắp xếp</legend>
      <div className="flex flex-wrap gap-2">{sortOptions.map(([value, label]) => <button type="button" key={value}
        aria-pressed={sort === value} onClick={() => update('sort', value)}
        className={`rounded-lg px-3 py-2 text-sm ${sort === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
        {label}</button>)}</div>
    </fieldset>
    <label className="block text-xs font-bold uppercase text-muted-foreground">Trạng thái
      <select aria-label="Trạng thái" value={status} onChange={event => update('status', event.target.value)}
        className="mt-2 w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-normal text-foreground">
        <option value="">Tất cả</option><option value="ongoing">Đang ra</option>
        <option value="completed">Hoàn thành</option><option value="hiatus">Tạm dừng</option>
      </select>
    </label>
    <fieldset><legend className="mb-2 text-xs font-bold uppercase text-muted-foreground">Thể loại Mòe Truyện</legend>
      {categories.isLoading ? <p className="text-sm text-muted-foreground">Đang tải thể loại…</p> : null}
      {categories.isError ? <button type="button" className="text-sm text-primary" onClick={() => void categories.refetch()}>Tải lại thể loại</button> : null}
      <div className="flex flex-wrap gap-1.5">{(categories.data || []).map(genre => <button type="button" key={genre.slug}
        aria-pressed={genres.includes(genre.slug)} onClick={() => update('genre', genres.includes(genre.slug)
          ? genres.filter(value => value !== genre.slug).join(',') : [...genres, genre.slug].join(','))}
        className={`rounded-full px-2.5 py-1 text-xs ${genres.includes(genre.slug) ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
        {genre.name}</button>)}</div>
    </fieldset>
    {(genres.length > 0 || status || keyword) ? <button type="button" onClick={() => setParams({ source: 'moetruyen', sort })}
      className="text-sm text-primary">Xóa bộ lọc</button> : null}
  </div>;

  return <div className="container mx-auto px-4 py-8">
    <div className="mb-6 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3"><div className="accent-line" /><h1 className="ed-heading text-2xl">Khám Phá Truyện</h1></div>
      <button type="button" onClick={() => setShowFilters(!showFilters)} className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm lg:hidden">
        {showFilters ? <X className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}Bộ lọc
      </button>
    </div>
    <MangaSourceTabs active="moetruyen" />
    <div className="flex gap-8">
      <aside className="hidden w-64 shrink-0 lg:block"><div className="ed-card sticky top-20 p-4">{panel}</div></aside>
      <section aria-label="Danh sách Mòe Truyện" className="min-w-0 flex-1">
        {showFilters ? <div className="ed-card mb-5 p-4 lg:hidden">{panel}</div> : null}
        {query.isLoading ? <MangaGridSkeleton count={24} /> : query.isError ?
          <div role="alert" className="ed-card p-8 text-center">
            <BookOpen className="mx-auto mb-3 h-8 w-8 text-primary" />
            <p className="font-semibold">Chưa tải được truyện từ Mòe.</p>
            <p className="mt-2 text-sm text-muted-foreground">Nguồn đang phản hồi chậm. Bạn có thể thử tải lại.</p>
            <button type="button" onClick={() => void query.refetch()} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Thử lại</button>
          </div> : items.length ? <>
            <p className="mb-4 text-sm text-muted-foreground">{items.length} kết quả trang này</p>
            <MangaGrid manga={items} />
          </> : <div className="ed-card p-8 text-center"><BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="font-semibold">Chưa có truyện phù hợp.</p><p className="mt-2 text-sm text-muted-foreground">Thử thay đổi thể loại hoặc trạng thái truyện.</p>
          </div>}
        {!query.isLoading && !query.isError ? <MangaPagination currentPage={page} totalPages={query.data?.totalPages || 1}
          onPageChange={target => { update('page', String(target)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          onPageIntent={target => { void client.prefetchQuery(options(target)); }} /> : null}
      </section>
    </div>
  </div>;
}
