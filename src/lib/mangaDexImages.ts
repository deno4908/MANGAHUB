const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

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
