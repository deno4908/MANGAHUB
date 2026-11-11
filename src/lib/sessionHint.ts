// This is only a hint to try the canonical auth host's HttpOnly cookie. It
// contains no token and can never grant access without backend verification.
const NAME = 'mh_session_present';
const hosts = new Set(['mangahub.art', 'standby.mangahub.art']);

function sharedDomain() {
  return typeof window !== 'undefined' && window.location.protocol === 'https:' && hosts.has(window.location.hostname);
}

export function sharedSessionHint(): boolean {
  if (!sharedDomain()) return false;
  try { return document.cookie.split(';').some(item => item.trim() === NAME + '=1'); }
  catch { return false; }
}

export function setSharedSessionHint(present: boolean) {
  if (!sharedDomain()) return;
  try {
    document.cookie = `${NAME}=${present ? '1' : ''}; Domain=mangahub.art; Path=/; Max-Age=${present ? 30 * 86400 : 0}; Secure; SameSite=Lax`;
  } catch { /* Storage restrictions must not prevent login/logout. */ }
}
