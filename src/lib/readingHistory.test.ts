import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { historyMatches, latestReadingHistory, resolveResumeChapter, upsertReadingHistory, type ReadingHistory } from './readingHistory';
import { useReaderStore } from '@/store/readerStore';

const manga = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
const chapter = '9272da37-6c69-4ecc-a1e0-d25db7b3e80f';
const row = (overrides: Partial<ReadingHistory> = {}): ReadingHistory => ({ manga_slug: manga, chapter_id: chapter,
  page: 12, progress: 45, read_at: '2026-11-06T10:00:00Z', ...overrides });

describe('reading checkpoints', () => {
  it('updates the actual history caches and refuses out-of-order responses', () => {
    const client = new QueryClient();
    client.setQueryData(['history', 'raw'], [row({ manga_slug: `mdx-${manga}`, page: 1 })]);
    client.setQueryData(['history', 'enriched'], []);
    client.setQueryData(['history', 'manga', 'reader', [manga]], null);
    client.setQueryData(['history', 'manga', 'other-user', [manga]], null);
    const latest = row({ client_read_at: '2026-11-06T10:05:00Z', page: 17 });
    upsertReadingHistory(client, latest, 'reader');
    upsertReadingHistory(client, row({ page: 2 }), 'reader');
    expect(client.getQueryData(['history', 'raw'])).toEqual([latest]);
    expect(client.getQueryData(['history', 'enriched'])).toEqual([latest]);
    expect(client.getQueryData(['history', 'manga', 'reader', [manga]])).toEqual(latest);
    expect(client.getQueryData(['history', 'manga', 'other-user', [manga]])).toBeNull();
    expect(client.getQueryData(['history'])).toBeUndefined();
    client.clear();
  });

  it('resumes the exact chapter outside a selected filter or short MDX response', () => {
    expect(resolveResumeChapter(row({ chapter_id: `mdx-${chapter}` }), [{ id: chapter, number: 7, title: 'Special' }], manga)?.id).toBe(chapter);
    expect(resolveResumeChapter(row({ chapter_id: chapter, chapter_name: 'Chương 70.5' }), [], manga)).toMatchObject({ id: chapter, number: 70.5 });
    expect(resolveResumeChapter(row({ chapter_id: 'retired-qq-id', chapter_name: 'Chương 0' }), [{ id: 'new', number: 0 }], 'book-23')?.id).toBe('new');
    expect(resolveResumeChapter(row({ chapter_id: 'retired-qq-id', chapter_name: 'Unknown' }), [{ id: 'new', number: 0 }], 'book-23')).toBeUndefined();
  });

  it('only matches normalized MDX IDs or an explicit verified QQ alias', () => {
    expect(historyMatches(row({ manga_slug: `mdx-${manga}` }), [manga])).toBe(true);
    expect(historyMatches(row({ manga_slug: 'book', manga_source_slug: 'book-23' }), ['book-23'])).toBe(true);
    expect(historyMatches(row({ manga_slug: 'book-22' }), ['book-23'])).toBe(false);
    expect(latestReadingHistory([row(), row({ page: 2, read_at: '2026-11-05T10:00:00Z' })], [manga])?.page).toBe(12);
  });

  it('keeps account-local progress without regression and removes it with history', () => {
    useReaderStore.setState({ readingProgress: {} });
    const store = useReaderStore.getState();
    store.saveProgress('reader-a', row());
    store.saveProgress('reader-a', row({ read_at: '2026-11-05T10:00:00Z', page: 0 }));
    store.saveProgress('reader-b', row({ page: 2 }));
    expect(useReaderStore.getState().readingProgress['reader-a'][manga].page).toBe(12);
    store.removeProgress('reader-a', [`mdx-${manga}`]);
    expect(useReaderStore.getState().readingProgress['reader-a']).toEqual({});
    expect(useReaderStore.getState().readingProgress['reader-b'][manga].page).toBe(2);
    store.removeProgress('reader-b');
    expect(useReaderStore.getState().readingProgress['reader-b']).toEqual({});
  });
});
