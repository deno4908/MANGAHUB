const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MANGADEX_EDGE_BASE = String(
  import.meta.env.VITE_MANGADEX_EDGE_URL ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/api/mangadex-edge`
      : ""),
).replace(/\/+$/, "");
let edgeUnavailableUntil = 0;

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
