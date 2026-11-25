// High-volume image reads bypass Workers. Only a real host failure switches
// subsequent images to the owned standby; healthy images need no extra probe.
const PRIMARY = 'https://api.mangahub.art';
const BACKUP = 'https://standby.mangahub.art';
let preferenceUntil = 0;
let preferBackup = false;

export function isOriginImage(url: URL): boolean {
  return url.pathname === '/api/images/img' ||
    /^\/api\/manga\/(?:mangadex-cover|truyenqq\/(?:cover|image))\//.test(url.pathname);
}

export function imageOriginRoute(value: string, method = 'GET', now = Date.now()) {
  try {
    const url = new URL(value);
    if (!['GET', 'HEAD'].includes(method.toUpperCase()) || url.origin !== PRIMARY || !isOriginImage(url)) return null;
    const alternate = new URL(url);alternate.host = new URL(BACKUP).host;
    // A reader already on standby should use its local image proxy directly.
    // Keep explicit failure recovery in either direction, without health probes.
    const onStandby = typeof window !== 'undefined' && window.location.origin === BACKUP;
    return { primary: url.href, backup: alternate.href, preferBackup: now < preferenceUntil ? preferBackup : onStandby };
  } catch { return null; }
}

export function rememberImageOrigin(backup: boolean) {
  preferBackup = backup;
  preferenceUntil = Date.now() + 60_000;
}

export function failedImageHost(response: Response) {
  // A source/authorization error must keep its existing recovery behavior.
  return !response.headers.has('X-TruyenQQ-Error') &&
    ([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(response.status) ||
      response.status === 402 && ['DEPLOYMENT_DISABLED', 'DEPLOYMENT_PAUSED'].includes(response.headers.get('X-Vercel-Error') || ''));
}
