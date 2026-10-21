import { describe, expect, it } from "vitest";
import { adaptChapterPages, adaptListData, adaptMangaDetail } from "./adapters";
import { getMangaDetailPath, normalizeMangaDexId, resolveMangaRoute } from "./mangaLinks";

const slug = "truyen-thu-123";
const token = `qq--${slug}--45-5`;
const item = {
  _id: "123", slug, name: "Truyện thử", source: "truyenqq", status: "ongoing",
  thumb_url: `/api/manga/truyenqq/cover/${slug}`,
  chapters: [{ server_name: "TruyenQQ", server_data: [
    { chapter_name: "45.5", chapter_api_data: `/api/manga/chapter/${token}` },
    { chapter_name: "0", chapter_api_data: `/api/manga/chapter/qq--${slug}--0` },
  ] }],
};

describe("TruyenQQ website contract", () => {
  it("uses source pagination even when the source does not publish an item total", () => {
    const page = adaptListData({ data: { items: [item], params: { pagination: {
      currentPage: 2, totalItemsPerPage: 42, totalItems: null, totalPages: 444,
    } } } });
    expect(page.totalPages).toBe(444);
    expect(page.currentPage).toBe(2);
    expect(page.items[0].source).toBe("truyenqq");
    expect(new URL(page.items[0].cover).pathname).toBe(`/api/manga/truyenqq/cover/${slug}`);
  });

  it("keeps comic and chapter identifiers distinct from MangaDex UUIDs", () => {
    const manga = adaptMangaDetail({ data: { item } });
    expect(manga.id).toBe(slug);
    expect(manga.chapters.map((chapter) => chapter.number)).toEqual([0, 45.5]);
    expect(manga.chapters[1].id).toBe(token);
    expect(normalizeMangaDexId(token)).toBeNull();
    expect(getMangaDetailPath(slug, "truyenqq")).toBe(`/manga/${slug}`);
    expect(resolveMangaRoute("truyenqq", slug).source).toBe("truyenqq");
  });

  it("uses the QQ image endpoint without prepending the old CDN", () => {
    const path = `/api/manga/truyenqq/image/${slug}/45-5/1`;
    const pages = adaptChapterPages({ data: { item: { chapter_image: [{ image_file: path }] } } });
    expect(new URL(pages[0]).pathname).toBe(path);
    expect(pages[0]).not.toContain("otruyen");
  });
});
