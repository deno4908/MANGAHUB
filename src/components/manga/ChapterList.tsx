import { Chapter } from '@/types/manga';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BookOpen, Clock, ChevronLeft, ChevronRight, ArrowUpNarrowWide, ArrowDownNarrowWide } from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';

interface ChapterListProps {
  chapters: Chapter[];
  mangaId: string;
  mangaDetailId?: string;
  mangaTitle?: string;
  defaultSortAsc?: boolean;
}

const CHAPTERS_PER_PAGE = 100;

function chapterCredit(chapter: Chapter): string {
  const source = String(chapter.translationSourceLabel || '').trim();
  const group = String(chapter.scanlationGroup || '').trim();
  if (source && group && source.toLowerCase() !== group.toLowerCase()) {
    return `${source} · ${group}`;
  }
  return group || source;
}

const ChapterList = ({ chapters, mangaId, mangaDetailId, mangaTitle, defaultSortAsc = true }: ChapterListProps) => {
  const [sortAsc, setSortAsc] = useState(defaultSortAsc);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();

  const sorted = useMemo(
    () => (sortAsc ? [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)) : [...chapters].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))),
    [chapters, sortAsc]
  );

  const totalPages = Math.ceil(sorted.length / CHAPTERS_PER_PAGE);
  const paged = sorted.slice((page - 1) * CHAPTERS_PER_PAGE, page * CHAPTERS_PER_PAGE);

  useEffect(() => {
    setPage(1);
  }, [chapters.length, mangaId]);

  const handleChapterClick = (ch: Chapter) => {
    navigate(`/chapter/${ch.id}`, {
      state: {
        mangaId: mangaDetailId || mangaId,
        mangaSlug: mangaId,
        mangaTitle: mangaTitle || '',
        chapterNumber: ch.number,
        chapterTitle: ch.title,
        chapters: chapters.map(c => ({ id: c.id, number: c.number, title: c.title })),
      },
    });
  };

  const handlePageChange = (p: number) => {
    setPage(p);
    // Scroll to top of chapter list
    document.getElementById('chapter-list-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div>
      <div id="chapter-list-top" className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-comic text-gradient">{chapters.length} Chương</h3>
        <div className="flex items-center gap-2">
          {totalPages > 1 && (
            <span className="text-xs text-muted-foreground">
              Trang {page}/{totalPages}
            </span>
          )}
          <button
            onClick={() => { setSortAsc(!sortAsc); setPage(1); }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg bg-secondary border border-border/50 transition-colors"
          >
            {sortAsc
              ? <><ArrowUpNarrowWide className="w-3.5 h-3.5" /> Cũ &rarr; Mới</>
              : <><ArrowDownNarrowWide className="w-3.5 h-3.5" /> Mới &rarr; Cũ</>}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        {paged.map((ch, i) => {
          const credit = chapterCredit(ch);
          return (
          <motion.div
            key={ch.id}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.01, 0.5) }}
          >
            <button
              onClick={() => handleChapterClick(ch)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-secondary/80 transition-all group border border-transparent hover:border-border/50 text-left"
            >
              <div className="flex items-center gap-3">
                <BookOpen className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                <div>
                  <span className="text-sm font-semibold group-hover:text-primary transition-colors">
                    Chương {ch.number}
                  </span>
                  {ch.title !== `Chapter ${ch.number}` && ch.title !== `Chương ${ch.number}` && (
                    <span className="text-xs text-muted-foreground ml-2">- {ch.title}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {credit && <span className="hidden sm:inline max-w-[220px] truncate">{credit}</span>}
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span>{timeAgoVi(ch.uploadDate, ch.id)}</span>
                </div>
              </div>
            </button>
          </motion.div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-6 pt-4 border-t border-border/50">
          <button
            onClick={() => handlePageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .reduce<(number | '...')[]>((acc, p, i, arr) => {
              if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('...');
              acc.push(p);
              return acc;
            }, [])
            .map((p, i) =>
              p === '...' ? (
                <span key={`dots-${i}`} className="px-2 text-xs text-muted-foreground">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => handlePageChange(p as number)}
                  className={`min-w-[32px] h-8 rounded-lg text-xs font-bold transition-colors ${
                    p === page
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {p}
                </button>
              )
            )}

          <button
            onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="p-2 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

function extractObjectIdTimestampMs(value: string): number {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const tail = raw.split('/').pop() || raw;
  const normalized = tail.trim().toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(normalized)) return Number.NaN;
  const seconds = Number.parseInt(normalized.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return Number.NaN;
  return seconds * 1000;
}

function timeAgoVi(dateStr: string, chapterId?: string): string {
  const directTs = Date.parse(String(dateStr || ''));
  const fallbackTs = extractObjectIdTimestampMs(String(chapterId || ''));
  const ts = Number.isFinite(directTs) ? directTs : fallbackTs;
  if (!Number.isFinite(ts)) return '--';

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

export default ChapterList;
