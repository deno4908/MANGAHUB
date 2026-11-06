import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMangaReadingHistory } from './useApi';
import { useUserStore } from '@/store/userStore';
import { useReaderStore } from '@/store/readerStore';
import { historyIdentity, historyTime, latestReadingHistory, upsertReadingHistory, type ReadingHistory } from '@/lib/readingHistory';
import { syncReadingHistory } from '@/lib/readingHistorySync';

type Options = {
  chapter: string; manga: string; mangaId: string; title: string; thumb: string; chapterName: string;
  totalPages: number; mode: string; currentPage: number; container: RefObject<HTMLDivElement>;
  resume?: ReadingHistory;
  resumeViewer?: string;
};

export function readViewportPosition(container: HTMLElement | null, totalPages: number) {
  const elements = Array.from(container?.querySelectorAll<HTMLElement>('[data-reader-page]') || []);
  let low = 0, high = elements.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (elements[middle].getBoundingClientRect().bottom > 1) high = middle;
    else low = middle + 1;
  }
  const element = elements[low];
  const bounds = element?.getBoundingClientRect();
  const page = Math.min(Math.max(Number(element?.dataset.readerPage) || 0, 0), Math.max(0, totalPages - 1));
  return { page, pageOffset: bounds ? Math.min(1, Math.max(0, -bounds.top / Math.max(1, bounds.height))) : 0 };
}

export function useReaderProgress(options: Options) {
  const viewer = useUserStore(s => s.isLoggedIn && !s.isRestoringSession ? s.user?.id : undefined);
  const client = useQueryClient();
  const history = useMangaReadingHistory([options.manga, options.mangaId], !!options.manga);
  const values = useRef(options);
  values.current = options;
  const restored = useRef('');
  const restoring = useRef(false);
  const captureCurrent = useRef<() => void>(() => {});
  const [interacted, setInteracted] = useState('');
  const key = `${viewer || ''}:${options.manga}:${options.chapter}:${options.mode}`;
  const ready = !!options.totalPages && (!viewer || !!history.data || !history.isPending || interacted === key);

  useEffect(() => {
    if (ready) return;
    const reading = () => setInteracted(key);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    events.forEach(event => window.addEventListener(event, reading, { passive: true }));
    return () => events.forEach(event => window.removeEventListener(event, reading));
  }, [key, ready]);

  useEffect(() => {
    if (!ready || restored.current === key) return;
    restored.current = key;
    // A slow lookup must not jump backwards after the user starts reading.
    if (interacted === key) return;
    const current = values.current;
    const candidates = [history.data, current.resumeViewer === viewer ? current.resume : undefined].filter(Boolean) as ReadingHistory[];
    const saved = candidates.sort((a, b) => historyTime(b) - historyTime(a))
      .find(row => historyIdentity(row.chapter_id) === historyIdentity(current.chapter));
    if (!saved) return;
    const page = Math.min(Math.max(Math.trunc(saved.page || 0), 0), current.totalPages - 1);
    if (current.mode === 'horizontal') {
      useReaderStore.getState().setCurrentPage(page);
      return;
    }
    if (page === 0 && !saved.pageOffset && !saved.progress) return;
    restoring.current = true;
    let stopped = false;
    let frame = 0;
    const anchor = () => {
      if (stopped) return;
      const element = current.container.current?.querySelector<HTMLElement>(`[data-reader-page="${page}"]`);
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + bounds.top + (saved.pageOffset || 0) * bounds.height);
      window.dispatchEvent(new Event('scroll'));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(anchor); };
    const stop = () => { stopped = true; restoring.current = false; cancelAnimationFrame(frame); };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined;
    current.container.current?.querySelectorAll<HTMLElement>('[data-reader-page]').forEach(element => observer?.observe(element));
    const container = current.container.current;
    container?.addEventListener('load', schedule, true);
    // Stop anchoring as soon as the reader moves, including touch and keyboard.
    const interactions = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    interactions.forEach(event => window.addEventListener(event, stop, { passive: true }));
    schedule();
    const timeout = window.setTimeout(stop, 8_000);
    return () => {
      stop(); clearTimeout(timeout); observer?.disconnect();
      container?.removeEventListener('load', schedule, true);
      interactions.forEach(event => window.removeEventListener(event, stop));
    };
  }, [key, ready]);

  useEffect(() => {
    if (!viewer || !options.manga || !options.chapter || !options.totalPages || !ready) return;
    const started = Date.now();
    const identity = { ...values.current };
    let lastPosition = '';
    let snapshot: ReadingHistory | undefined;
    const capture = () => {
      if (restoring.current || restored.current !== key) return;
      const current = values.current;
      // Never read the next chapter's reset page into the old chapter's flush.
      if (current.chapter !== identity.chapter || current.manga !== identity.manga || current.mode !== identity.mode) return;
      const position = current.mode === 'horizontal'
        ? { page: Math.min(useReaderStore.getState().currentPage, current.totalPages - 1), pageOffset: 0 }
        : readViewportPosition(current.container.current, current.totalPages);
      const height = document.documentElement.scrollHeight - window.innerHeight;
      const progress = current.mode === 'horizontal' ? ((position.page + 1) / current.totalPages) * 100
        : height > 0 ? window.scrollY / height * 100 : 0;
      if (Date.now() - started < 8_000 && progress < (current.totalPages <= 2 ? 1 : 5) && position.page < 1) return;
      const signature = `${position.page}:${position.pageOffset.toFixed(3)}:${Math.round(progress)}`;
      if (signature === lastPosition) return;
      lastPosition = signature;
      const now = new Date().toISOString();
      snapshot = { manga_slug: identity.manga, manga_title: current.title, manga_thumb: current.thumb,
        chapter_id: identity.chapter, chapter_name: current.chapterName, ...position,
        scrollY: window.scrollY, progress: Math.min(100, Math.max(0, Math.round(progress))),
        client_read_at: now, read_at: now, synced: false };
    };
    const flush = (keepalive = false) => {
      capture();
      const state = useUserStore.getState();
      if (!state.isLoggedIn || state.user?.id !== viewer) return;
      if (snapshot) {
        useReaderStore.getState().saveProgress(viewer, snapshot);
        upsertReadingHistory(client, snapshot, viewer);
      }
      const pending = latestReadingHistory(Object.values(useReaderStore.getState().readingProgress[viewer] || {}), [identity.manga, identity.mangaId]);
      if (pending && !pending.synced) void syncReadingHistory(viewer, pending, client, keepalive);
      snapshot = undefined;
    };
    captureCurrent.current = capture;
    // A fixed timer still fires during continuous scrolling and auto-scroll.
    const timer = window.setInterval(() => flush(), 3_000);
    const hide = () => flush(true);
    const visibility = () => { if (document.hidden) hide(); };
    window.addEventListener('scroll', capture, { passive: true });
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('scroll', capture);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
      flush(true);
    };
  }, [viewer, key, options.totalPages, ready, client]);
  useEffect(() => { captureCurrent.current(); }, [options.currentPage, key]);
  return history;
}
