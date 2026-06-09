const MangaCardSkeleton = () => (
  <div className="rounded-xl comic-border bg-card overflow-hidden animate-pulse">
    <div className="aspect-[3/4] bg-secondary" />
    <div className="p-3 space-y-2">
      <div className="h-4 bg-secondary rounded w-3/4" />
      <div className="h-3 bg-secondary rounded w-1/2" />
      <div className="flex gap-1">
        <div className="h-4 w-12 bg-secondary rounded-md" />
        <div className="h-4 w-10 bg-secondary rounded-md" />
      </div>
    </div>
  </div>
);

const MangaGridSkeleton = ({ count = 6 }: { count?: number }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <MangaCardSkeleton key={i} />
    ))}
  </div>
);

const ChapterListSkeleton = ({ count = 5 }: { count?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="flex items-center justify-between px-4 py-3 rounded-xl bg-secondary/30 animate-pulse">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 bg-secondary rounded" />
          <div className="h-4 w-24 bg-secondary rounded" />
        </div>
        <div className="h-3 w-16 bg-secondary rounded" />
      </div>
    ))}
  </div>
);

const ReaderSkeleton = () => (
  <div className="max-w-4xl mx-auto space-y-2 animate-pulse">
    {Array.from({ length: 3 }).map((_, i) => (
      <div key={i} className="w-full aspect-[2/3] bg-secondary rounded-lg" />
    ))}
  </div>
);

const HeroSkeleton = () => (
  <div className="w-full h-[340px] md:h-[420px] rounded-2xl comic-border bg-secondary animate-pulse overflow-hidden">
    <div className="absolute inset-0 flex items-end p-6 md:p-10">
      <div className="space-y-3 w-full max-w-lg">
        <div className="h-6 w-20 bg-muted rounded-lg" />
        <div className="h-10 w-3/4 bg-muted rounded-lg" />
        <div className="h-4 w-full bg-muted rounded" />
        <div className="flex gap-3">
          <div className="h-10 w-28 bg-muted rounded-xl" />
          <div className="h-10 w-20 bg-muted rounded-xl" />
        </div>
      </div>
    </div>
  </div>
);

export { MangaCardSkeleton, MangaGridSkeleton, ChapterListSkeleton, ReaderSkeleton, HeroSkeleton };
