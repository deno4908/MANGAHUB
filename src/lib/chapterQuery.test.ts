import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { chapterQueryOptions } from './chapterQuery';
import { mangaApi, uploadApi } from './api';
import { loadMangaDexChapterPages } from './mangaDexImages';

vi.mock('./api', () => ({ mangaApi: { getChapter: vi.fn() }, uploadApi: { getUpload: vi.fn() } }));
vi.mock('./mangaDexImages', () => ({ loadMangaDexChapterPages: vi.fn() }));
const id = 'qq--reader-book-123--2';
const valid = { data: { item: { chapter_image: [{ image_file: '/api/manga/truyenqq/image/reader-book-123/2/1' }] } } };
afterEach(() => vi.resetAllMocks());

it('does not cache an empty prefetch as a valid chapter and recovers without reloading the app', async () => {
  const client = new QueryClient();
  try {
    vi.mocked(mangaApi.getChapter).mockResolvedValueOnce({ data: { item: { chapter_image: [] } } }).mockResolvedValueOnce(valid);
    const options = { ...chapterQueryOptions(id), retry: false as const };
    await client.prefetchQuery(options);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryState(options.queryKey)?.error).toMatchObject({ status: 502 });
    expect((await client.fetchQuery(options)).pages).toHaveLength(1);
    expect(mangaApi.getChapter).toHaveBeenCalledTimes(2);
  } finally { client.clear(); }
});

it('shares one verified result between next-chapter prefetch and navigation', async () => {
  const client = new QueryClient();
  try {
    vi.mocked(mangaApi.getChapter).mockResolvedValue(valid);
    const options = chapterQueryOptions(id);
    await client.prefetchQuery(options);
    expect((await client.fetchQuery(options)).pages).toHaveLength(1);
    expect(mangaApi.getChapter).toHaveBeenCalledTimes(1);
    expect(mangaApi.getChapter).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  } finally { client.clear(); }
});

it('bounds transient retries and never retries missing chapters or access denials', () => {
  const options = chapterQueryOptions(id);
  for (const status of [401, 403, 404]) expect(options.retry(0, Object.assign(new Error(), { status }))).toBe(false);
  expect(options.retry(0, Object.assign(new Error(), { status: 503 }))).toBe(true);
  expect(options.retry(1, Object.assign(new Error(), { status: 503 }))).toBe(false);
});

it('validates MangaDex and uploaded pages through the same prefetch path', async () => {
  const signal = new AbortController().signal;
  vi.mocked(loadMangaDexChapterPages).mockResolvedValue([]);
  await expect(chapterQueryOptions('66666666-6666-4666-8666-666666666666').queryFn({ signal })).rejects.toMatchObject({ status: 502 });
  vi.mocked(uploadApi.getUpload).mockResolvedValue({ upload: { pages: ['https://images.example/page.jpg'] } });
  expect((await chapterQueryOptions('upload-123').queryFn({ signal })).pages).toEqual(['https://images.example/page.jpg']);
});
