import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '@/store/userStore';
import { useReaderStore } from '@/store/readerStore';
import { syncReadingHistory } from '@/lib/readingHistorySync';

/** Continue synchronizing the private journal after the reader page unmounts. */
export default function ReadingHistorySync() {
  const client = useQueryClient();
  const viewer = useUserStore(s => s.isLoggedIn && !s.isRestoringSession ? s.user?.id : undefined);
  useEffect(() => {
    if (!viewer) return;
    let disposed = false, running = false;
    const flush = async () => {
      if (disposed || running || document.hidden || navigator.onLine === false) return;
      running = true;
      try {
        const pending = Object.values(useReaderStore.getState().readingProgress[viewer] || {})
          .filter(row => !row.synced).slice(0, 4);
        for (const row of pending) {
          if (disposed) break;
          await syncReadingHistory(viewer, row, client);
        }
      } finally { running = false; }
    };
    void flush();
    const timer = window.setInterval(() => { void flush(); }, 15_000);
    const recover = () => { void flush(); };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      disposed = true;window.clearInterval(timer);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [viewer, client]);
  return null;
}
