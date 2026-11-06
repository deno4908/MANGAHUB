import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { ReadingMode } from '@/types/manga';
import { historyIdentity, historyMatches, historyTime, type ReadingHistory } from '@/lib/readingHistory';

export type PageDirection = 'ltr' | 'rtl';
export type ImageFit = 'width' | 'height' | 'original';

interface ReaderStore {
  // Reading
  mode: ReadingMode;
  currentPage: number;
  pageDirection: PageDirection;
  imageFit: ImageFit;

  // Visual
  brightness: number;
  zoom: number;
  pageGap: number;

  // UI
  isFullscreen: boolean;
  showControls: boolean;
  showToolbar: boolean;
  showPageNumber: boolean;
  showProgressBar: boolean;

  // Auto scroll
  autoScroll: boolean;
  autoScrollSpeed: number;

  // Progress tracking
  lastReadPositions: Record<string, { page: number; scrollY: number; chapterId: string }>;
  readingProgress: Record<string, Record<string, ReadingHistory>>;
  saveProgress: (viewer: string, entry: ReadingHistory) => void;
  removeProgress: (viewer: string, identifiers?: string[]) => void;

  // Actions
  setMode: (mode: ReadingMode) => void;
  setCurrentPage: (page: number) => void;
  setPageDirection: (dir: PageDirection) => void;
  setImageFit: (fit: ImageFit) => void;
  setBrightness: (brightness: number) => void;
  setZoom: (zoom: number) => void;
  setPageGap: (gap: number) => void;
  toggleFullscreen: () => void;
  setShowControls: (show: boolean) => void;
  setShowToolbar: (show: boolean) => void;
  setShowPageNumber: (show: boolean) => void;
  setShowProgressBar: (show: boolean) => void;
  setAutoScroll: (on: boolean) => void;
  setAutoScrollSpeed: (speed: number) => void;
  saveReadingPosition: (mangaId: string, chapterId: string, page: number, scrollY: number) => void;
  getReadingPosition: (mangaId: string) => { page: number; scrollY: number; chapterId: string } | null;
}

export const useReaderStore = create<ReaderStore>()(
  persist(
    (set, get) => ({
      mode: 'vertical',
      currentPage: 0,
      pageDirection: 'ltr',
      imageFit: 'width',
      brightness: 100,
      zoom: 100,
      pageGap: 0,
      isFullscreen: false,
      showControls: true,
      showToolbar: true,
      showPageNumber: false,
      showProgressBar: true,
      autoScroll: false,
      autoScrollSpeed: 2,
      lastReadPositions: {},
      readingProgress: {},
      saveProgress: (viewer, entry) => {
        if (!viewer || !entry.manga_slug || !entry.chapter_id) return;
        set(state => {
          const records = state.readingProgress[viewer] || {};
          const key = historyIdentity(entry.manga_slug);
          if (historyTime(records[key]) > historyTime(entry)) return state;
          const next = { ...records, [key]: entry };
          const bounded = Object.fromEntries(Object.entries(next).sort((a, b) => historyTime(b[1]) - historyTime(a[1])).slice(0, 200));
          return { readingProgress: { ...state.readingProgress, [viewer]: bounded } };
        });
      },
      removeProgress: (viewer, identifiers) => set(state => ({ readingProgress: {
        ...state.readingProgress, [viewer]: identifiers
          ? Object.fromEntries(Object.entries(state.readingProgress[viewer] || {}).filter(([, row]) => !historyMatches(row, identifiers))) : {},
      } })),

      setMode: (mode) => set({ mode }),
      setCurrentPage: (page) => set({ currentPage: page }),
      setPageDirection: (dir) => set({ pageDirection: dir }),
      setImageFit: (fit) => set({ imageFit: fit }),
      setBrightness: (brightness) => set({ brightness }),
      setZoom: (zoom) => set({ zoom: Math.max(50, Math.min(200, zoom)) }),
      setPageGap: (gap) => set({ pageGap: Math.max(0, Math.min(32, gap)) }),
      toggleFullscreen: () => set(s => ({ isFullscreen: !s.isFullscreen })),
      setShowControls: (show) => set({ showControls: show }),
      setShowToolbar: (show) => set({ showToolbar: show }),
      setShowPageNumber: (show) => set({ showPageNumber: show }),
      setShowProgressBar: (show) => set({ showProgressBar: show }),
      setAutoScroll: (on) => set({ autoScroll: on }),
      setAutoScrollSpeed: (speed) => set({ autoScrollSpeed: speed }),
      saveReadingPosition: (mangaId, chapterId, page, scrollY) => {
        set(s => ({
          lastReadPositions: {
            ...s.lastReadPositions,
            [mangaId]: { page, scrollY, chapterId },
          },
        }));
      },
      getReadingPosition: (mangaId) => {
        return get().lastReadPositions[mangaId] || null;
      },
    }),
    {
      name: 'reader-settings',
      storage: createJSONStorage(() => ({
        getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
        setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* Keep in-memory progress and server sync usable. */ } },
        removeItem: key => { try { localStorage.removeItem(key); } catch { /* Storage can be disabled by the browser. */ } },
      })),
      partialize: (state) => ({
        mode: state.mode,
        pageDirection: state.pageDirection,
        imageFit: state.imageFit,
        brightness: state.brightness,
        zoom: state.zoom,
        pageGap: state.pageGap,
        showToolbar: state.showToolbar,
        showPageNumber: state.showPageNumber,
        showProgressBar: state.showProgressBar,
        autoScrollSpeed: state.autoScrollSpeed,
        lastReadPositions: state.lastReadPositions,
        readingProgress: state.readingProgress,
      }),
    }
  )
);
