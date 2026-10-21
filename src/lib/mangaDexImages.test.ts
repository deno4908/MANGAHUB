import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ mangaApi: { getMangaDexChapterPages: vi.fn() } }));
import { mangaApi } from "@/lib/api";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
});
