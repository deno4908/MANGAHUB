import { useEffect, useRef, useState } from 'react';
import { mangaApi } from '@/lib/api';
import { adaptMangaItem } from '@/lib/adapters';
import { isMatureManga } from '@/lib/contentFilter';
import type { Manga } from '@/types/manga';

type State = { items: Manga[]; loading: boolean; failed: boolean; settled: boolean };
const empty: State = { items: [], loading: false, failed: false, settled: false };
const keyOf = (text: string) => text.trim().toLocaleLowerCase();

export function useMangaSuggestions(keyword: string, options: {
  enabled?: boolean; showMature?: boolean; viewerKey?: string;
} = {}) {
  const { enabled = true, showMature = false, viewerKey = 'guest' } = options;
  const [state, setState] = useState<State>(empty);
  const cache = useRef(new Map<string, { items: Manga[]; expires: number }>());
  const owner = useRef(viewerKey);

  useEffect(() => {
    if (owner.current !== viewerKey) { cache.current.clear(); owner.current = viewerKey; }
    const query = keyword.trim();
    if (!enabled || query.length < 2) { setState(empty); return; }
    const cacheKey = `${showMature}:${keyOf(query)}`;
    const cached = cache.current.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      setState({ items: cached.items, loading: false, failed: false, settled: true });
      return;
    }
    const controller = new AbortController();
    let live = true;
    let pending = 3, failures = 0;
    const results: Manga[][] = [[], [], []];
    setState({ ...empty, loading: true });

    const timer = window.setTimeout(() => {
      const publish = () => {
        if (!live) return;
        // Alternate sources so a full QQ page cannot crowd out the others.
        const merged: Manga[] = [], seen = new Set<string>();
        for (let index = 0; index < Math.max(...results.map(items => items.length)); index++) {
          for (const source of results) {
            const item = source[index];
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id); merged.push(item);
          }
        }
        const items = merged.slice(0, 6);
        setState({ items, loading: pending > 0, failed: failures > 0 && !items.length, settled: pending === 0 });
        // A temporary source failure must be retried on the next search.
        if (!pending && !failures) {
          cache.current.set(cacheKey, { items, expires: Date.now() + 60_000 });
          if (cache.current.size > 60) cache.current.delete(cache.current.keys().next().value!);
        }
      };
      const receive = async (source: number, request: Promise<any>) => {
        try {
          const payload = await request;
          if (!live) return;
          results[source] = (payload?.data?.items || []).map(adaptMangaItem)
            .filter((item: Manga) => showMature || !isMatureManga(item));
        } catch { failures++; }
        finally { pending--; publish(); }
      };
      void receive(0, mangaApi.search(query, 1, { includeMangaDex: false, includeMoe: false, attachRatings: false,
        timeoutMs: 12_000, signal: controller.signal }));
      void receive(1, mangaApi.searchMangaDex({ keyword: query, page: 1, limit: 6,
        sort: 'relevance', translatedLanguage: 'vi', showMature, attachRatings: false,
        filterHidden: true, timeoutMs: 12_000, signal: controller.signal }));
      void receive(2, mangaApi.getMoeFiltered({ keyword: query, page: 1, limit: 6,
        showMature, timeoutMs: 12_000, signal: controller.signal }));
    }, 200);
    return () => { live = false; window.clearTimeout(timer); controller.abort(); };
  }, [keyword, enabled, showMature, viewerKey]);

  return state;
}
