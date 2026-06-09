import { create } from 'zustand';
import { Manga, SortOption, MangaStatus } from '@/types/manga';

interface MangaFilters {
  genres: string[];
  status: MangaStatus | null;
  year: number | null;
  minRating: number;
  sort: SortOption;
  search: string;
}

interface MangaStore {
  filters: MangaFilters;
  setFilter: <K extends keyof MangaFilters>(key: K, value: MangaFilters[K]) => void;
  resetFilters: () => void;
}

const defaultFilters: MangaFilters = {
  genres: [],
  status: null,
  year: null,
  minRating: 0,
  sort: 'popular',
  search: '',
};

export const useMangaStore = create<MangaStore>((set) => ({
  filters: { ...defaultFilters },
  setFilter: (key, value) => set(state => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () => set({ filters: { ...defaultFilters } }),
}));
