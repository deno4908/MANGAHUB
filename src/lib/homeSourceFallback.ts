export function isMangaDexCoverUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    if (/^\/api\/manga\/mangadex-cover\//.test(url.pathname)) return true;
    if (url.pathname === '/api/images/img') {
      const target = url.searchParams.get('url');
      if (!target) return false;
      const host = new URL(target).hostname;
      return host === 'uploads.mangadex.org' || host.endsWith('.mangadex.network');
    }
    return url.hostname === 'uploads.mangadex.org' || url.hostname.endsWith('.mangadex.network');
  } catch {
    return false;
  }
}
