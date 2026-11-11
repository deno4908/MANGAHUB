# MangaHub VPS standby

This runs the full combined FastAPI + Flask application and the same production SPA. Vercel stays the primary origin for all three public hostnames. A separate Worker can route `mangahub.art`, `api.mangahub.art`, and `auth.mangahub.art` to `standby.mangahub.art` without changing browser URLs or cookies. Keep the more specific MangaDex source Worker route unchanged.

## Current deployment and activation boundary

The initial Sydney machine has native Nginx, a single Python 3.12/Uvicorn process, a local TLS Redis content cache and 1 GiB swap. No Docker daemon or on-VPS frontend build is needed. Redis binds only loopback and has a 96 MiB disposable content limit; the systemd service has memory limits. These are starting budgets for a 1 GiB machine, not a guarantee of Vercel-equivalent traffic capacity.

The checked-in Worker configuration has **no public routes and `FAILOVER_ENABLED=false`**. The VPS private readiness endpoint also rejects activation until `STANDBY_READY=true`. A running health endpoint alone does not prove full login and feature parity. The deployment workflow attaches the router in Vercel pass-through mode while activation is false; the frontend country restriction remains enforced.

## State that must remain shared

Use the same Supabase database/storage, Flask/JWT secrets, authentication JWK, frontend/auth URLs and integration credentials as production. The VPS uses its own Redis for content caching. `REDIS_SECURITY_URL` must point at the SAME Redis security authority used by Vercel; do not create independent revocation, refresh, nonce or access-ticket ledgers. Preserve the production fallback/cutover setting. This protects against a logged-out or revoked session becoming valid again on the other host.

This setup survives a Vercel origin outage. It does not independently recover a shared Supabase or security-Redis outage, a Cloudflare outage, an upstream source outage, or an overloaded VPS. Changing those dependencies requires a separate data/identity recovery design.

## Provisioning

`bootstrap.sh` is for a new, empty Ubuntu VPS with root access. It installs Nginx and Redis, installs managed Python 3.12 with uv for the pinned application dependencies, generates local Redis certificates/passwords, and adds swap only if none exists. Redis is TLS-only with hostname verification. Bootstrap creates a backup of the distribution Redis configuration. Do not print or commit `/etc/mangahub/backend.env`, `/etc/mangahub/origin-secret`, the Redis password or private TLS keys.

AWS inbound: TCP 22 from the administrator's IP; TCP 80 and 443 for web/ACME. Never expose 6379, 8000 or 5000. Create a DNS-only `standby.mangahub.art` A record for the server and obtain a valid HTTPS certificate. Run `setup-web.sh` after the first release exists; it obtains HTTPS and configures automatic renewal plus Nginx reload.

After HTTPS provisioning, proxy the standby DNS record through Cloudflare and include its hostname alongside API/auth in the Configuration Rule that disables Under Attack for service traffic. Run `protect-origin.sh` to allow only Cloudflare and loopback web ingress. It checks the published Cloudflare network list and proxied DNS before reloading Nginx; SSH rules are untouched. Public responses do not contain `X-MangaHub-Origin`. Previously published IP addresses may remain in historical DNS records, so DNS proxying is not a promise to erase past disclosure.

Private readiness paths still require the origin secret and can be reached directly by CI if Cloudflare challenges its datacenter IP. This exception does not include application routes or routing control. Store the address only in the encrypted `STANDBY_ORIGIN_ADDRESS` Actions secret, never in frontend assets or repository configuration; HTTPS must still verify `standby.mangahub.art`.

Keep private environment settings in `/etc/mangahub/backend.env` (root:mangahub, 0640). See `backend.env.example`. Copy ALL current production settings and override only the VPS-local paths, bind settings and content Redis URL. Do not import old cached env as proof that current production secrets match. Preserve reCAPTCHA/SMTP/OpenRouter and all enabled integrations.

Build the frontend in CI with the production public env. For the initial deployment, the exact currently deployed production HTML and its 94 public asset files were mirrored, retaining production API/auth URLs and the public reCAPTCHA site key. Local developer builds point at localhost and are unsuitable. Future releases must install matching frontend and backend revisions before declaring readiness.

Place a release under `/opt/mangahub/releases/<revision>/` with `backend`, `dist`, and `deploy/standby`, excluding venvs, `.env*`, keys and runtime caches. Run `install-release.sh /opt/mangahub/releases/<revision>`. Keep `/opt/mangahub/assets` as a retained archive of old hashed public assets so already-open tabs can load their chunks after an update. No credentials or private cache may go into this archive.

Use `nginx.conf.template`, replacing only `ORIGIN_SECRET_PLACEHOLDER` with the generated Worker/VPS secret. Run `nginx -t` before reload. It serves the SPA, preserves crawler previews, proxies API/auth/SSE, sanitizes client-IP forwarding, and rejects direct origin access without the secret. The application trusts only the local Nginx hop.

## Worker behavior

The healthy request path streams directly to Vercel. A bounded background routing-state read does not delay that response. Cron probes the primary origins every minute, checks the VPS including Redis reads/writes, and records private routing state on the VPS disk, outside the evictable content cache. The frontend retains public Under Attack, and the deployment aliases can require Vercel Authentication. To avoid mistaking either protection for an outage, the router requests a private frontend probe from the VPS. It connects to Vercel's public ingress (default `76.76.21.21`) with the real `mangahub.art` TLS hostname, full certificate verification and a fixed credential-free GET `/`; it accepts only HTTP 200 HTML. This endpoint is origin-secret protected, cannot select an arbitrary URL, never proxies user traffic and remains behind Cloudflare-only ingress. If Vercel changes the project's ingress, update `STANDBY_PRIMARY_FRONTEND_ADDRESS` after verifying its certificate and production HTML. See [Vercel's direct TLS verification example](https://vercel.com/docs/domains/pre-generating-ssl-certs).

Three successful probes are required before returning a failed origin to primary. During an active client drill, the same monitor runs using the private drill-readiness gate so its real origin checks and recovery can be verified before global activation. Its recorded state cannot divert other readers while `FAILOVER_ENABLED=false`.

The deployment workflow's `monitor_only=true` option runs the same readiness and scheduled probes without a client drill or global activation. It is mutually exclusive with activation and a drill IP. This allows observing recovery on the live Cron without diverting any readers. Leave it false to stop monitoring while failover is disabled.

The source relay uses a service binding to the router for site-access checks. This avoids same-zone network fetches bypassing the router and depending on Vercel during an outage. It preserves the caller's authorization and never forwards it to QQ. The optional `standby-source.yml` workflow deploys an isolated relay without primary placement settings for testing the Sydney backend's source egress; deploy it and verify authorized content before changing the standby's `TRUYENQQ_EDGE_URL`. Deploying a relay is not evidence that QQ accepts its network egress.

GET/HEAD can retry a failed origin on the other host. POST/PUT/PATCH/DELETE are NEVER replayed after any error because they may already have committed. Once the health monitor selects the standby, new writes start there. An in-flight write at the beginning of an outage can still fail and require the client's normal retry. HTTP 401/403/404/429 are preserved. Country restrictions on the frontend keep the existing denial page; API/auth keep the application access checks.

Cloudflare Workers Free has a daily request quota shared with the account's other Workers; it is not unlimited failover capacity. See https://developers.cloudflare.com/workers/platform/limits/ . No KV or paid load-balancer subscription is required by this design.

## Checks before activation

1. Compare current production environment settings and frontend build values. Complete missing reCAPTCHA and integration configuration.
2. Verify TLS/private-origin rejection, both Redis stores, full SPA chunks and no localhost URLs in active configuration.
3. Use the workflow's optional `drill_client_ip` input with `activate=false` to test the live VPS from one public client IP for one hour. Its private `/internal/standby-drill-health` gate requires reCAPTCHA configuration and both Redis stores, without declaring global activation ready. The client uses the real public hostnames, login cookies and complete application; other clients stay on Vercel. The drill never hides a VPS error with a Vercel retry, and never retries writes. It expires automatically, does not activate global failover, and can be cleared early by dispatching with an empty drill IP. Sign in as a normal approved reader; check MangaDex and QQ lists, filters, chapter images, progress, Follow, History and Bookmark. Check uploads/editor/admin and configured email/AI integrations with appropriate accounts. Never relax whitelist, role, CSRF or rate-limit checks for this drill.
4. Run unit checks: `node --test cloudflare/standby-worker.test.mjs`; from `backend`, `python -m pytest tests/test_standby_app.py tests/test_vercel_runtime.py tests/test_redis_failover.py -q`.
5. Run a controlled failure drill against the private origin before switching public traffic. Confirm no write replay and recovery behavior.
6. Set `STANDBY_READY=true` ONLY after these checks. Restart `mangahub` and verify private readiness is 200.
7. Dispatch `standby-worker.yml` with `activate=true`; its full readiness gate must pass before automatic failover is enabled. The workflow uses the existing Cloudflare Actions credentials and encrypted origin secret. All three public routes are attached; the more specific source Worker route remains untouched. The standalone `vn-only-worker.js` source file is not modified by this setup.

## Operations

To restore the pre-standby public serving path, dispatch `restore-vercel.yml`. It restores the existing `mangahub-vn-only` frontend route without replacing that script, detaches API/auth from the standby router, redeploys the source relay without its standby binding, and removes all standby Cron schedules and drills. Other source routes are verified unchanged. It restores API/auth to DNS-only Vercel CNAMEs if the token permits DNS edits; otherwise it reports the two dashboard changes required. The standby record remains proxied to protect its origin address. Keep standby app services stopped after rollback if no longer testing, without deleting their configuration or data.

- Status: `sudo systemctl status mangahub redis-server nginx`.
- Resource use: `free -m`; `sudo systemctl show mangahub -p MemoryCurrent -p NRestarts`.
- Logs: `sudo journalctl -u mangahub --since '10 minutes ago'` (redact before sharing).
- Readiness/control are private and require `X-MangaHub-Origin-Secret` and an allowed `X-MangaHub-Public-Host` at Nginx.
- Pause failover by deploying the router with activation false and an empty drill IP. This keeps the frontend country restriction, leaves Vercel as origin and does not stop the VPS.
- Keep frontend/backend updates synchronized; do not use stale secrets or an old SPA as a permanent backup.

Do not mark failover operational until the activation checks and a real failure drill have passed. Full functionality is the completion condition; installing services alone is preparation.
