import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ mangaApi: { getMangaDexChapterPages: vi.fn() }, getAccessToken: () => 'allowed-reader-token', isSiteAccessRestricted: () => restricted.value }));
const restricted = vi.hoisted(() => ({ value: false }));
import { mangaApi } from "@/lib/api";

afterEach(() => { restricted.value = false; vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MangaDex chapter loading", () => {
  it("starts the backend after a short head start and shares requests with prefetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    vi.mocked(mangaApi.getMangaDexChapterPages).mockResolvedValue({ image_urls: ["https://node.mangadex.network/page.jpg"] });
    const { loadMangaDexChapterPages } = await import("./mangaDexImages");
    const first = loadMangaDexChapterPages("chapter-1");
    const second = loadMangaDexChapterPages("chapter-1");
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(150);
    expect(await first).toEqual(["https://node.mangadex.network/page.jpg"]);
    expect(mangaApi.getMangaDexChapterPages).toHaveBeenCalledTimes(1);
  });

  it("uses a fast edge response without sending a backend request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      baseUrl: "https://node.mangadex.network", chapter: { hash: "hash", dataSaver: ["1.jpg"] },
    }) }));
    const { loadMangaDexChapterPages } = await import("./mangaDexImages");
    expect(await loadMangaDexChapterPages("chapter-2")).toEqual(["https://node.mangadex.network/data-saver/hash/1.jpg"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(mangaApi.getMangaDexChapterPages).not.toHaveBeenCalled();
  });

  it('authenticates an edge reader when whitelist mode is enabled', async () => {
    restricted.value = true;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ baseUrl: 'https://node.mangadex.network', chapter: { hash: 'restricted', dataSaver: ['1.jpg'] } }) });
    vi.stubGlobal('fetch', fetcher);
    const { loadMangaDexChapterPages } = await import('./mangaDexImages');
    expect(await loadMangaDexChapterPages('restricted-chapter')).toHaveLength(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer allowed-reader-token');
  });
});

it('keeps healthy CDN images direct and only remembers the host that actually failed', async () => {
  vi.useFakeTimers();
  const { getPreferredMangaDexImageUrl, rememberMangaDexImageFailure } = await import('./mangaDexImages');
  const first = 'https://failed-node.mangadex.network/data-saver/hash/1.jpg';
  const next = 'https://failed-node.mangadex.network/data-saver/hash/2.jpg';
  const healthy = 'https://healthy-node.mangadex.network/data-saver/hash/1.jpg';
  expect(getPreferredMangaDexImageUrl(first)).toBe(first);
  rememberMangaDexImageFailure(first);
  expect(getPreferredMangaDexImageUrl(next)).toContain('/api/images/img?url=');
  expect(new URL(getPreferredMangaDexImageUrl(next)).searchParams.get('url')).toBe(next);
  expect(getPreferredMangaDexImageUrl(healthy)).toBe(healthy);
  expect(getPreferredMangaDexImageUrl('https://cdn.example/1.jpg')).toBe('https://cdn.example/1.jpg');
  rememberMangaDexImageFailure(getPreferredMangaDexImageUrl(next));
  expect(getPreferredMangaDexImageUrl(next)).toBe(next);
  rememberMangaDexImageFailure(first);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(getPreferredMangaDexImageUrl(next)).toBe(next);
});
