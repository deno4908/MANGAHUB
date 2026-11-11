# Separate VPS test web

Use `https://standby.mangahub.art:8443`. Production Vercel routes, DNS and source Worker stay unchanged. This branch deploys only `mangahub-qq-lab`, with no public zone routes. Do not merge or deploy its frontend to the production Vercel project.

The backend is the complete combined app on loopback port 8001, with its local TLS Redis content cache. Preserve production Supabase and security-Redis settings, secrets and reCAPTCHA; set `FRONTEND_URL=https://standby.mangahub.art:8443`, `TRUYENQQ_EDGE_URL=https://mangahub-qq-lab.vinhytb3010.workers.dev/api/truyenqq-edge` and `TRUYENQQ_PREFER_EDGE=true`. Never copy secrets into Git. Register `https://standby.mangahub.art:8443/auth/callback` in Supabase's allowed redirect URLs before using OAuth. Keep the existing production Site URL.

Build the full frontend with `VITE_API_URL` and `VITE_AUTH_URL` set to the test web origin, the same QQ Worker URL as the backend, `VITE_MANGADEX_EDGE_URL=https://mangahub-qq-lab.vinhytb3010.workers.dev/api/mangadex-edge`, and the matching public reCAPTCHA key. Install backend and built dist at `/opt/mangahub/lab`. Use the included systemd unit and Nginx site; public traffic remains Cloudflare-only. Open AWS TCP 8443, keep the DNS record proxied, and do not expose Redis or Uvicorn. Cloudflare proxies HTTPS 8443 but does not cache that port by default; browser, app and source caches remain available.

Two distinct issues were verified:

- A fresh QQ source fetch through the Worker from the Sydney caller returned 403; a local Vietnamese caller fetched the same public page successfully. After warming the same Worker cache, the Sydney caller read valid content with HIT. Keep frontend and backend on the same isolated source relay and retain bounded browser recovery; do not treat a working Vercel cache as proof that Sydney's cold source egress works.
- Native startup warmups run without reader authorization. The previous shared-read key allowed an approved reader to join that anonymous request and inherit its failure. `test_qq_background_scope.py` failed against the old code and passes after grouping QQ requests by authorization presence. Approved readers still share one public source read; no reader tokens enter the coalescing key, and public source caches and website access checks retain their existing behavior.

The private `/internal/qq-probe` Worker route requires `VPS_LAB_RELAY_SECRET`. It fetches only the fixed public latest listing and returns status/cache metadata, never page content or credentials. Keep the secret out of frontend builds and browser tests. It is an operator diagnostic, not evidence that an authenticated end-to-end chapter read has passed.
