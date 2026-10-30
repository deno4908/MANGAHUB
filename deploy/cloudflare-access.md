# Cloudflare Access: deployment checklist for MangaHub

This is a staged setup, not evidence that Access is enabled. Do not call the site
private until the anonymous and authenticated checks below pass against every
public deployment address. DNS, certificate history, external source sites,
content previously downloaded, and hosting/Cloudflare operators remain outside
this access boundary. Access is a second gate; MangaHub authentication and its
whitelist still apply after Access login.

## 1. Create the browser Access application

1. In Cloudflare DNS, keep the existing origin targets and enable the orange
   **Proxied** setting for the frontend, API and auth DNS records.
2. Open **Zero Trust**. Choose a neutral team name. In **Integrations → Identity
   providers → Add new identity provider**, add **One-time PIN**.
3. Go to **Access controls → Applications → Create new application → Self-hosted
   and private**. Name it `Private Portal`; choose an eight-hour session.
4. Initially add concrete public hostnames `mangahub.art` and, if used,
   `www.mangahub.art`. Leave Path empty, including for assets/metadata routes.
5. Create one **Allow** policy: **Include → Emails → each exact approved email**.
   Do not use Everyone, a whole public email domain, or an application Bypass.
6. Select **One-time PIN** as the login method. Save. Keep the Cloudflare
   management dashboard session open independently of the protected site.
7. Verify a fresh, unauthenticated browser sees Access before any MangaHub page;
   verify an approved browser can enter with its emailed OTP.
8. Record Team domain (`name.cloudflareaccess.com`) and the application's
   **Application Audience (AUD) Tag** from its application detail/configuration.
   These values are configuration, not the OTP or API credentials.

Official instructions:
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/

## 2. Prepare server-to-server access before protecting the API

1. Create an Access **Service Token** in **Access controls → Service credentials
   → Service tokens** (the navigation can vary). Record its Client ID and Client
   Secret in a password manager. Never put these in frontend build variables,
   Git, browser storage, URLs, or chat.
2. Add a **Service Auth** policy to the same application, including only this
   service token. It is machine authorization, not a public Bypass. The service
   can reach the application; use it only on trusted servers.
3. In the source Worker's Settings, add the Client ID and Client Secret as
   **Secrets** named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Also add
   them to backend runtime environment variables, not to the frontend project.
4. Deploy the updated Worker with Wrangler from `cloudflare/`:
   `npx wrangler deploy --config wrangler.toml`. It now imports `access-gate.js`
   and `jose`; pasting just the old single-file Worker is insufficient.
5. Verify both same-origin Worker routes are installed:
   `mangahub.art/api/mangadex-edge/*` and
   `mangahub.art/api/truyenqq-edge/*`.
6. In the frontend set
   `VITE_TRUYENQQ_EDGE_URL=https://mangahub.art/api/truyenqq-edge`.
   Keep `VITE_MANGADEX_EDGE_URL=https://mangahub.art/api/mangadex-edge`.
7. In the backend set
   `TRUYENQQ_EDGE_URL=https://mangahub.art/api/truyenqq-edge`.
8. Rebuild/redeploy the frontend and restart/redeploy the backend. Verify QQ
   listing, search, chapter loading, and MangaDex chapter loading. This move
   avoids third-party Worker cookies and puts browser source requests behind
   the already protected frontend hostname.

The backend sends service credentials only on requests to its configured owned
relay. The Worker sends its credentials only to the fixed website `/api/site-access`
endpoint; no Cloudflare credentials are forwarded to the QQ/MangaDex source.
MangaHub's user bearer is still checked separately for whitelist authorization.

## 3. Add API and auth to the browser application

1. Add `api.mangahub.art` and `auth.mangahub.art` as concrete hostnames to the
   **same** application. Leave their paths empty.
2. Under **Advanced settings → Cookie settings**, enable **Eager redirect
   cookie** and HttpOnly. Concrete hostnames allow Access to establish each
   domain cookie during login; a wildcard does not do this automatically.
3. Configure **CORS** in Access so Cloudflare answers preflights, rather than
   bypassing all API paths. Match the backend CORS configuration:
   - Allow origin: `https://mangahub.art` (any other actual frontend origin must
     also be explicitly configured at the backend).
   - Allow credentials: true.
   - Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS.
   - Request headers: Authorization, Content-Type, X-MangaHub-CSRF, plus any
     actual application header reported by browser preflight.
4. The origin gate rejects anonymous OPTIONS. Configure Cloudflare to answer
   preflights itself; do not enable **Bypass OPTIONS requests to origin** with
   this gate. Actual requests must still carry a valid Access session.
5. Sign out of Access, sign in again, then verify login, API requests and images
   in a normal browser profile. A private profile can test denial; third-party
   cookie restrictions can complicate authenticated cross-origin testing.

References:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## 4. Enable validation at origins and the source Worker

Set these **server-side** environment variables in the frontend Vercel project,
backend deployment, and Worker. Values must refer to the exact application
created above. No `VITE_` prefix:

```dotenv
CF_ACCESS_REQUIRED=true
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CF_ACCESS_AUD=your-real-application-audience-tag
```

Multiple known audience tags may be comma-separated during a deliberate
transition; do not add arbitrary apps. Missing/invalid configuration when the
gate is required refuses requests instead of falling back to public access.

- Frontend `middleware.ts` runs for all paths, including static bundles, icons,
  legal pages, robots and social-preview images. It uses the existing `jose`
  dependency and `@vercel/functions` continuation helper.
- Backend must run the combined entrypoint **`app:app`**, which covers both API
  and Flask auth. Running `fastapi_app.main:app` or Flask separately does not
  install this outer gate. Example: `python -m uvicorn app:app --host 0.0.0.0
  --port <allocated-port> --workers 1` from `backend/`.
- Worker verifies the assertion before policy checks, source requests or cache
  reads on every path/method. Its internal cached source payloads are never
  served before authorization.
- The gate validates RS256 signatures, exact issuer, configured audience and
  expiry. It does not trust email/Host/CF-Ray headers, a Supabase token in place
  of Access, or just the existence of the assertion header.
- Successful gated responses and denials are private/no-store. Purge existing
  Cloudflare cache and check there are no Cache Rules overriding this boundary.
- Enabling the frontend middleware adds a server-side check to static requests.
  Public signing keys are cached; do not fetch user profiles or Supabase here.

Health checks and scheduled jobs also require Access. The Vercel built-in cron
does not automatically acquire an Access assertion. Before enabling the gate,
move the maintenance schedule to an authenticated caller through Cloudflare,
sending the Service Token headers AND the existing `Authorization: Bearer
<CRON_SECRET>` expected by `/internal/maintenance-tasks`. That path has no public
exception. Do not log or commit either credential. Configure hosting health
probes with authenticated requests or platform-level process checks.

After all callers have moved, disable the source Worker's `workers.dev` and
preview URLs in dashboard AND deployment configuration (set `workers_dev=false`
and `preview_urls=false` in `wrangler.toml`). Keep origin validation enabled even
if an alternate Worker hostname accidentally remains reachable.

JWT validation guidance:
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

## 5. Close old deployments and independent public storage

Updating the current deployment does not rewrite previous immutable Vercel
deployments. Inspect Deployment Protection on both projects and every deployment
URL, including branch aliases. Protect, disable or remove old public deployments
after preserving any required rollback artifacts. Do not assume Standard
Protection covers every production alias; verify each actual hostname.

Do the same for any Render URL, app hosting IP, old domain and alternate port.
Serving the same app with another unprotected entrypoint reopens the origin.
Public Supabase storage buckets, public repositories, source CDNs and already
cached search results require their own access/retention decisions; Cloudflare
Access on MangaHub does not make those third-party resources private.

## 6. Acceptance checks (required before calling isolation complete)

Use actual known URLs, not nonexistent example assets. Test without cookies and
without assertion headers; use GET as well as HEAD and try deep links:

- Root/www `/`, `/manga`, one actual `/assets/<hash>.js`, `/favicon.ico`,
  `/og-logo.png`, `/robots.txt`, `/privacy` and any sitemap/social-preview route.
- API/auth hosts: `/health`, `/auth/health`, `/api/site-access`, one detail,
  image, chapter and user endpoint.
- The same resources on direct current/previous Vercel URLs and other origins.
- All source Worker hostnames/routes, including cached reads and preview URLs.
- A forged Cloudflare email/CF-Ray/Host header must not grant access. An expired,
  wrong-team, wrong-audience or unsigned JWT must also fail.

An anonymous caller may receive Cloudflare's generic login/denial, or the
origin's generic `Unavailable` response. It must never receive application HTML,
bundles, source payloads or branding. A 200 on an actual asset or JSON endpoint
is a failed gate check; a temporary outage alone is not proof of protection.

Then verify an approved email can sign in and use frontend, login, QQ/MDX lists,
images/chapters, and logout normally. Verify machine calls and maintenance jobs
still work only with their own credentials. Confirm logs contain no tokens.

If anything fails, keep the dashboard session and diagnose that layer. Do not
add a broad Bypass policy to restore access. `CF_ACCESS_REQUIRED=false` is an
explicit removal of origin protection, not a privacy-preserving fix.

## Status

Code can be prepared and tested without private credentials. Actual activation
and acceptance checks need the real Team domain/AUD and dashboard settings.
Until all items above are verified, complete isolation is unproven.
