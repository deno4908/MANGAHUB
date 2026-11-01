# MangaDex API compatibility

The backend calls `https://api.mangadex.org` as
`MangaHub/1.0 (MangaDex API client)`. It does not copy a browser's MangaDex
cookies or claim to be Chrome.

On 2026-11-01, live requests using the previous Chrome/131 User-Agent were
redirected to `https://mangadex.org/edge/challenge`. The same API requests with
the MangaHub client identity returned JSON successfully, using both HTTPX and
curl_cffi. This was reproduced from the development environment; it is not a
guarantee that every hosting IP will always be accepted.

Keep the existing `MANGADEX_TRANSPORT` setting (`curl_cffi`, `httpx`, or `auto`).
The header fix applies to both clients. No new environment variable, browser
cookie, challenge solver, or frontend setting is required. Deploy the updated
backend to apply the fix. Do not put `MD-Edge-ID` into frontend configuration
or into a shared backend cookie.

Both API clients stop at redirects. An interactive HTML response or redirect
becomes a source error instead of being followed, parsed as catalog JSON, or
cached as an empty result. Existing source outage snapshots can still be used.
JSON rate-limit responses retain their status and Retry-After handling.

After deployment, verify a live MangaDex search, title detail, and chapter.
If Vercel is still blocked, inspect the backend source error log (without
copying cookies or challenge query strings). A successful local API request
does not prove that Vercel's outbound address is accepted. A persistent upstream
verification requirement needs an access method supported by MangaDex.

The same identity is used for MangaDex image proxy requests. Catalog cards and
saved covers route MangaDex CDN URLs through the authenticated image proxy
immediately, rather than waiting for a direct browser image to fail first.
The private in-memory cover cache still shares downloads; image host validation,
payload validation, and access policy checks remain enabled.

Small catalog cards request the CDN's 256px variant when the metadata supplies
a 512px cover. Adjacent-page prefetch uses the same variant and proxy URL so
the card can reuse it. Large detail/hero covers and reader pages retain their
existing size. A sample cover was 32,856 bytes at 256px versus 100,871 bytes at
512px; download time still depends on the source, proxy, and reader's network.
