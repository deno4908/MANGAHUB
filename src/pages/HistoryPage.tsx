import { useHistory } from '@/hooks/useApi';
import { historyApi } from '@/lib/api';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { History as HistoryIcon, Trash2, X, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { toast } from 'sonner';
import { getMangaDetailPath } from '@/lib/mangaLinks';

const HistoryPage = () => {
  const { data: history = [], isLoading } = useHistory();
  const qc = useQueryClient();

  const handleRemove = async (slug: string) => {
    const snapshots = qc.getQueriesData<any[]>({ queryKey: ['history'] });
    qc.setQueriesData({ queryKey: ['history'] }, (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.filter((item: any) => item?.manga_slug !== slug);
    });

    try {
      await historyApi.remove(slug);
      toast.success('Đã xoá khỏi lịch sử');
    } catch (error) {
      snapshots.forEach(([key, value]) => qc.setQueryData(key, value));
      toast.error('Không thể xoá lịch sử. Vui lòng thử lại.');
    } finally {
      qc.invalidateQueries({ queryKey: ['history'], refetchType: 'inactive' });
    }
  };

  const handleClear = async () => {
    if (!confirm('Xoá tất cả lịch sử đọc?')) return;
    const snapshots = qc.getQueriesData<any[]>({ queryKey: ['history'] });
    qc.setQueriesData({ queryKey: ['history'] }, (old: any) => {
      if (!Array.isArray(old)) return old;
      return [];
    });

    try {
      await historyApi.clear();
      toast.success('Đã xoá toàn bộ lịch sử');
    } catch (error) {
      snapshots.forEach(([key, value]) => qc.setQueryData(key, value));
      toast.error('Không thể xoá lịch sử. Vui lòng thử lại.');
    } finally {
      qc.invalidateQueries({ queryKey: ['history'], refetchType: 'inactive' });
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-20 flex justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="accent-line" />
          <HistoryIcon className="w-5 h-5 text-primary" />
          <h1 className="ed-heading text-2xl">Lịch Sử Đọc</h1>
          <span className="text-sm text-muted-foreground">({history.length})</span>
        </div>
        {history.length > 0 && (
          <button onClick={handleClear} className="flex items-center gap-1.5 text-xs font-bold text-manga-red hover:underline">
            <Trash2 className="w-3.5 h-3.5" /> Xoá tất cả
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="text-center py-20">
          <HistoryIcon className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">Chưa đọc truyện nào.</p>
          <Link to="/manga" className="text-primary text-sm font-bold mt-2 inline-block hover:underline">Khám phá truyện →</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {history.map((item: any, i: number) => (
            <motion.div
              key={item.manga_slug}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/50 hover:border-primary/20 transition-all group"
            >
              <Link to={getMangaDetailPath(item.manga_slug)} className="shrink-0">
                <OptimizedImage src={item.manga_thumb || ''} fallbackSrc={item.manga_thumb_fallback || undefined} alt="" className="w-12 h-16 rounded-lg object-cover border border-border" />
              </Link>
              <div className="flex-1 min-w-0">
                <Link to={getMangaDetailPath(item.manga_slug)} className="text-sm font-bold line-clamp-1 hover:text-primary transition-colors">
                  {item.manga_title}
                </Link>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {item.chapter_name || 'Unknown chapter'} · {item.progress || 0}%
                </p>
                <p className="text-[10px] text-muted-foreground">{timeAgoVi(item.read_at || item.last_read_at || item.created_at)}</p>
              </div>
              <button
                onClick={() => handleRemove(item.manga_slug)}
                className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-destructive/10 transition-all"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

function timeAgoVi(dateStr: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

export default HistoryPage;
