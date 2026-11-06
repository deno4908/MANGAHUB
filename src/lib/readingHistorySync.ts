import type { QueryClient } from '@tanstack/react-query';
import { historyApi } from './api';
import { historyIdentity, upsertReadingHistory, type ReadingHistory } from './readingHistory';
import { useReaderStore } from '@/store/readerStore';
import { useUserStore } from '@/store/userStore';

type Write = { entry: ReadingHistory; client: QueryClient; keepalive: boolean };
const queues = new Map<string, { running: boolean; activeTime?: number; pending?: Write }>();

// Coalesce rapid position changes and serialize writes to the same book. An
// older request must not arrive after a newer chapter and move history back.
export async function syncReadingHistory(viewer: string, entry: ReadingHistory, client: QueryClient, keepalive = false) {
  const currentViewer = () => {
    const state = useUserStore.getState();
    return state.isLoggedIn && state.user?.id === viewer;
  };
  if (!currentViewer()) return;
  const key = `${viewer}:${historyIdentity(entry.manga_slug)}`;
  const queue = queues.get(key) || { running: false };
  const timestamp = Date.parse(entry.client_read_at || entry.read_at || '') || 0;
  if (queue.activeTime !== undefined && queue.activeTime >= timestamp) return;
  if (queue.pending && (Date.parse(queue.pending.entry.client_read_at || queue.pending.entry.read_at || '') || 0) > timestamp) return;
  queue.pending = { entry, client, keepalive };
  queues.set(key, queue);
  if (queue.running) return;
  queue.running = true;
  try {
    while (queue.pending && currentViewer()) {
      const write = queue.pending;
      queue.pending = undefined;
      queue.activeTime = Date.parse(write.entry.client_read_at || write.entry.read_at || '') || 0;
      try {
        const result = await historyApi.add(write.entry, { keepalive: write.keepalive, timeoutMs: 5_000 });
        if (!currentViewer()) break;
        // The journal keeps the checkpoint on failure, including across reloads.
        const acknowledged = { ...write.entry, synced: true };
        useReaderStore.getState().saveProgress(viewer, acknowledged);
        if (result?.stale) void write.client.invalidateQueries({ queryKey: ['history'], refetchType: 'active' });
        else upsertReadingHistory(write.client, acknowledged, viewer);
      } catch {
        // Retry through the reader's bounded timer rather than a tight loop.
        break;
      }
    }
  } finally {
    queues.delete(key);
  }
}
