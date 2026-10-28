import { Link } from 'react-router-dom';
import type { MangaSource } from '@/lib/mangaLinks';

const sources: Array<[MangaSource, string]> = [
  ['truyenqq', 'TruyenQQ'], ['mangadex', 'MangaDex'], ['moetruyen', 'Mòe Truyện'],
];

export default function MangaSourceTabs({ active }: { active: MangaSource }) {
  return <nav aria-label="Nguồn truyện" className="mb-6 flex flex-wrap items-center gap-2">
    {sources.map(([source, label]) => <Link key={source}
      to={source === 'truyenqq' ? '/manga' : `/manga?source=${source}`}
      aria-current={source === active ? 'page' : undefined}
      className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${source === active
        ? 'bg-primary text-primary-foreground comic-shadow'
        : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'}`}>
      {label}
    </Link>)}
  </nav>;
}
