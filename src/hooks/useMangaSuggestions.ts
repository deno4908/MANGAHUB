import { useEffect, useRef, useState } from 'react';
import { mangaApi } from '@/lib/api';
import { adaptMangaItem } from '@/lib/adapters';
import { isMatureManga } from '@/lib/contentFilter';
import type { Manga } from '@/types/manga';

type State = { items: Manga[]; loading: boolean; failed: boolean; settled: boolean };
const empty: State = { items: [], loading: false, failed: false, settled: false };
const keyOf = (text: string) => text.trim().toLocaleLowerCase();
const sources = ['uploaded', 'truyenqq', 'mangadex'] as const;

export function useMangaSuggestions(keyword: string, options: {
  enabled?: boolean; showMature?: boolean; viewerKey?: string;
} = {}) {
  const { enabled = true, showMature = false, viewerKey = 'guest' } = options;
  const [state, setState] = useState<State>(empty);
  const cache = useRef(new Map<string, { items: Manga[]; expires: number }>());
  const owner = useRef({ viewerKey, showMature });
  const query = keyOf(keyword);

  useEffect(() => {
    const sameOwner = owner.current.viewerKey === viewerKey && owner.current.showMature === showMature;
    if (!sameOwner) { cache.current.clear(); owner.current = { viewerKey, showMature }; }
    if (!enabled || query.length < 2) { setState(empty); return; }
    const controller = new AbortController();
    let live = true, failures = 0;
    const results: Manga[][] = sources.map(source => {
      const cached = cache.current.get(`${query}:${source}`);
      return cached && cached.expires > Date.now() ? cached.items : [];
    });
    const missing = sources.map((source, index) => ({ source, index }))
      .filter(({ source }) => (cache.current.get(`${query}:${source}`)?.expires || 0) <= Date.now());
    let pending = missing.length;
    const publish = () => {
      if (!live) return;
      const merged: Manga[] = [], seen = new Set<string>();
      for (let index = 0; index < Math.max(...results.map(items => items.length)); index++) {
        for (const source of results) {
          const item = source[index];
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id); merged.push(item);
        }
      }
      setState({ items: merged.slice(0, 6), loading: pending > 0,
        failed: failures > 0 && !merged.length, settled: pending === 0 });
    };
    publish();
    const timer = window.setTimeout(() => {
      for (const { source, index } of missing) {
        void (async () => {
          try {
            const payload = await mangaApi.searchSuggestions(query, source, { showMature, signal: controller.signal });
            if (!live) return;
            results[index] = (payload?.data?.items || []).map(adaptMangaItem)
              .filter((item: Manga) => showMature || !isMatureManga(item));
            // Cache sources separately: a failed MDX request must not force a
            // successful QQ search to run again when reopening the same query.
            cache.current.set(`${query}:${source}`, { items: results[index], expires: Date.now() + 60_000 });
            while (cache.current.size > 120) cache.current.delete(cache.current.keys().next().value!);
          } catch { failures++; }
          finally { pending--; publish(); }
        })();
      }
    }, 120);
    return () => { live = false; window.clearTimeout(timer); controller.abort(); };
  }, [query, enabled, showMature, viewerKey]);

  return state;
}
