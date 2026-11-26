import { mangaApi, getAccessToken, isSiteAccessRestricted } from "@/lib/api";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MANGADEX_EDGE_BASE = String(
  import.meta.env.VITE_MANGADEX_EDGE_URL ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/api/mangadex-edge`
      : ""),
).replace(/\/+$/, "");
let edgeUnavailableUntil = 0;
const pendingChapters = new Map<string, Promise<string[]>>();
const failedImageHosts = new Map<string, number>();

/** Give the nearby edge a short head start; a stalled edge must not delay reading. */
export function loadMangaDexChapterPages(chapterId: string): Promise<string[]> {
  const existing = pendingChapters.get(chapterId);
  if (existing) return existing;
  const task = new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let failed = 0;
    let backendStarted = false;
    let timer: ReturnType<typeof setTimeout>;
    const succeed = (pages: string[]) => {
      if (!pages.length) throw new Error("Chương chưa có trang ảnh");
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pages);
    };
    const fail = (error: unknown) => {
      failed += 1;
      if (failed === 2 && !settled) {
        settled = true;
        reject(error);
      }
    };
    const startBackend = () => {
      if (backendStarted || settled) return;
      backendStarted = true;
      mangaApi.getMangaDexChapterPages(chapterId, "saver", false, 8_000)
        .then((data) => succeed(Array.isArray(data?.image_urls) ? data.image_urls.filter(Boolean) : []))
        .catch(fail);
    };
    timer = setTimeout(startBackend, 150);
    getLocalMangaDexChapterPages(chapterId)
      .then(succeed)
      .catch((error) => { fail(error); startBackend(); });
  }).finally(() => { pendingChapters.delete(chapterId); });
  pendingChapters.set(chapterId, task);
  return task;
}

type MangaDexAtHomePayload = {
  baseUrl?: string;
  chapter?: {
    hash?: string;
    data?: string[];
    dataSaver?: string[];
  };
};

export function isMangaDexImageUrl(value: string): boolean {
  try {
    const host = new URL(value, "http://localhost").hostname.toLowerCase();
    return host === "uploads.mangadex.org" || host.endsWith(".mangadex.network");
  } catch {
    return false;
  }
}

function getProxyTarget(value: string): string | null {
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.pathname !== "/api/images/img") return null;
    const target = parsed.searchParams.get("url");
    return target && /^https?:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
}

export function getMangaDexImageFallback(value: string): string | null {
  const target = getProxyTarget(value);
  if (target && isMangaDexImageUrl(target)) return target;
  if (!isMangaDexImageUrl(value)) return null;
  return `${API_BASE}/api/images/img?url=${encodeURIComponent(value)}`;
}

export function rememberMangaDexImageFailure(value: string) {
  const target = getProxyTarget(value);
  if (target && isMangaDexImageUrl(target)) {
    failedImageHosts.delete(new URL(target).hostname);
    return;
  }
  if (!isMangaDexImageUrl(value)) return;
  const host = new URL(value, 'https://mangadex.org').hostname;
  failedImageHosts.delete(host);
  failedImageHosts.set(host, Date.now() + 60_000);
  while (failedImageHosts.size > 16) failedImageHosts.delete(failedImageHosts.keys().next().value!);
}

/** Prefer the existing proxy briefly after a real CDN failure. */
export function getPreferredMangaDexImageUrl(value: string): string {
  if (!isMangaDexImageUrl(value)) return value;
  const url = new URL(value, 'https://mangadex.org');
  return (failedImageHosts.get(url.hostname) || 0) > Date.now()
    ? getMangaDexImageFallback(url.href) || value : value;
}

export async function getLocalMangaDexChapterPages(
  chapterId: string,
  timeoutMs = 2_500,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!MANGADEX_EDGE_BASE || Date.now() < edgeUnavailableUntil) return [];
    // This route should be handled by the Cloudflare edge worker. MangaDex
    // then chooses an At-Home node near the reader instead of the US VPS.
    const response = await fetch(
      `${MANGADEX_EDGE_BASE}/chapter/${encodeURIComponent(chapterId)}`,
      {
        ...(isSiteAccessRestricted() && getAccessToken() ? { headers: { Authorization: `Bearer ${getAccessToken()}` } } : {}),
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      edgeUnavailableUntil = Date.now() + 60_000;
      throw new Error(`MangaDex At-Home HTTP ${response.status}`);
    }
    const payload = (await response.json()) as MangaDexAtHomePayload;
    const baseUrl = String(payload?.baseUrl || "").replace(/\/+$/, "");
    const hash = String(payload?.chapter?.hash || "");
    const saver = Array.isArray(payload?.chapter?.dataSaver)
      ? payload.chapter.dataSaver.filter(Boolean)
      : [];
    const data = Array.isArray(payload?.chapter?.data)
      ? payload.chapter.data.filter(Boolean)
      : [];
    const names = saver.length ? saver : data;
    const mode = saver.length ? "data-saver" : "data";
    if (!baseUrl || !hash || !names.length) return [];
    edgeUnavailableUntil = 0;
    return names.map((name) => `${baseUrl}/${mode}/${hash}/${name}`);
  } catch (error) {
    edgeUnavailableUntil = Date.now() + 60_000;
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
