import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';

interface MangaPaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageIntent?: (page: number) => void;
}

const MangaPagination = ({ currentPage, totalPages, onPageChange, onPageIntent }: MangaPaginationProps) => {
  const pageInputId = useId();
  const [pageInput, setPageInput] = useState(String(currentPage));
  const intentTimer = useRef<ReturnType<typeof setTimeout>>();
  const clearIntent = () => clearTimeout(intentTimer.current);
  const intendPage = (target: number) => {
    clearIntent();
    if (onPageIntent && target !== currentPage && target >= 1 && target <= totalPages) {
      intentTimer.current = setTimeout(() => onPageIntent(target), 150);
    }
  };
  useEffect(() => clearIntent, [currentPage, totalPages, onPageIntent]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  if (totalPages <= 1) return null;

  const goToPage = () => {
    const parsedPage = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsedPage)) {
      setPageInput(String(currentPage));
      return;
    }

    const nextPage = Math.min(totalPages, Math.max(1, parsedPage));
    setPageInput(String(nextPage));
    if (nextPage !== currentPage) onPageChange(nextPage);
  };

  const handleGoToPageSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    goToPage();
  };

  const getPages = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('...');
      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
        pages.push(i);
      }
      if (currentPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
      <div className="flex items-center justify-center gap-1">
        <button
          type="button"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          onPointerDown={() => onPageIntent?.(currentPage - 1)}
          onPointerEnter={() => intendPage(currentPage - 1)} onFocus={() => intendPage(currentPage - 1)} onPointerLeave={clearIntent} onBlur={clearIntent}
          className="p-2 rounded-md bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          aria-label="Trang trước"
          title="Trang trước"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {getPages().map((p, i) =>
          p === '...' ? (
            <span key={`ellipsis-${i}`} className="px-2 text-muted-foreground text-sm">...</span>
          ) : (
            <button
              type="button"
              key={p}
              onClick={() => onPageChange(p)}
              onPointerDown={() => onPageIntent?.(p)}
              onPointerEnter={() => intendPage(p)} onFocus={() => intendPage(p)} onPointerLeave={clearIntent} onBlur={clearIntent}
              className={`w-9 h-9 rounded-md text-sm font-medium transition-all ${
                currentPage === p
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
              aria-label={`Trang ${p}`}
              aria-current={currentPage === p ? 'page' : undefined}
            >
              {p}
            </button>
          )
        )}
        <button
          type="button"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          onPointerDown={() => onPageIntent?.(currentPage + 1)}
          onPointerEnter={() => intendPage(currentPage + 1)} onFocus={() => intendPage(currentPage + 1)} onPointerLeave={clearIntent} onBlur={clearIntent}
          className="p-2 rounded-md bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          aria-label="Trang sau"
          title="Trang sau"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleGoToPageSubmit} className="flex h-9 items-center gap-1.5">
        <label htmlFor={pageInputId} className="sr-only">Đến trang</label>
        <input
          id={pageInputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pageInput}
          onChange={(event) => {
            const value = event.target.value.replace(/\D/g, '');
            setPageInput(value);
            intendPage(Number.parseInt(value, 10));
          }}
          placeholder="Trang"
          className="h-full w-16 rounded-md border border-border bg-card px-2 text-center text-sm font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          aria-label={`Đến trang, từ 1 đến ${totalPages}`}
        />
        <span className="text-xs font-medium text-muted-foreground">/ {totalPages}</span>
        <button
          type="submit"
          className="grid h-full w-9 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Đến trang"
          title="Đến trang"
        >
          <ArrowRight className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};

export default MangaPagination;
