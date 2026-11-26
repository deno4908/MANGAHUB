# Vercel primary and VPS standby

Users normally enter `https://mangahub.art`. A failed frontend navigation is
redirected temporarily (307) to `https://standby.mangahub.art`, preserving its
path and query. The old `:8443` lab redirects to the standard HTTPS port.
Direct standby navigation also returns to the primary when it is healthy and
the standby offers no measured latency advantage. An outage takes precedence;
proactive standby selection additionally requires available VPS capacity.

HTML document POSTs reaching the standby during a browser handoff are served
through an internal GET of the SPA entry point. This avoids Nginx's static-file
405 without another browser redirect or Worker call. Only frontend documents
qualify; API/auth writes, static files and origin-access gates keep their normal
method handling. Run `python3 deploy/standby/test_nginx_navigation.py` on Linux
with Nginx installed to verify the template against disposable loopback fixtures.

The standby serves the same deployed frontend assets. Its frontend still calls
the canonical `api` and `auth` hosts, retaining their secure cookies. OAuth
returns to the frontend where login began; both callback URLs must be allowed
in Supabase. A shared, noncredential cookie hints that the frontend should
restore a session from the canonical auth host's HttpOnly cookie. The router
recognizes only the two exact, application-owned frontend
origins when adapting credentialed CORS and CSRF origin headers. It does not
trust arbitrary subdomains. Application authentication, whitelist checks,
reCAPTCHA, rate limits and the Vietnam frontend policy remain enabled.

The VPS runs the complete combined app with its local Redis cache and the
same security Redis, Supabase project, JWK and signing secrets as production.
The source Worker uses an `ACCESS_ROUTER` service binding: a same-zone HTTP
fetch alone would skip the router and break source access during Vercel outages.
QQ source failures preserve browser recovery hints and do not count as host
outages. Never publish secrets in frontend variables, logs or headers.

## Selection and recovery

With `DAILY_HEALTH_SHARED=true`, one persisted health snapshot is refreshed
at most once per 24 hours. Active isolates read that saved file at most once a
minute; this does not probe both origins for every reader. See
[DAILY_HEALTH.md](DAILY_HEALTH.md) for the timer, private file and route setup.
Distance estimates use timings observed at the reader's Cloudflare location,
not country alone or the daily job's location. Ordinary reads do not wait for
background snapshot reads. Actual safe-read failures can try the other origin
once without waiting for tomorrow's snapshot.

While both origins are healthy, the standby receives at most a 10% API share,
increasing to 25% when measured faster or when the primary reports congestion.
Frontend navigation only moves proactively when the standby is measured
faster, or the primary is congested. Shares are intentionally bounded for a
1 GB machine. No extra share is assigned with low memory, excessive load or
more than eight active app requests. Actual primary outages take precedence.
A new daily snapshot can restore a previously failed origin; rereading the
same snapshot does not erase an observed failure. The optional legacy probe
mode uses its own recovery sampling rules.
Images retain the healthy Vercel origin to avoid fragmenting its warm cache;
they still fall back to the VPS on a Vercel failure. Image quality is unchanged.

GET/HEAD can be retried once at the other origin. Submitted writes are never
automatically replayed: a lost response might follow an already committed
write. A request already in flight during an outage can still fail.

## Deployment and rollback

`Manage adaptive standby router` is manual, with `inspect`, `prepare`,
`activate`, `update` and `rollback` operations. Inspect does not change routing. Prepare
deploys detached and verifies both origins. Prepare refuses to detach an already
active router. Activate retains its current routes while deploying, then verifies
that all four hostnames are Cloudflare proxied and preserves the more-specific
MangaDex source route. Rollback restores the existing country Worker on the
primary frontend and removes this router's other public routes.

Before activation, deploy the backend QQ recovery fixes to Vercel, install the
VPS service and private Nginx configuration, and verify that the VPS frontend
matches the current deployed Vercel frontend. Retain old hashed assets across
frontend updates. Update the VPS release whenever deploying application changes.
Never copy `.env` files or virtual environments into a release archive.

During a primary-provider incident, `update` deploys the tested router on its
existing routes and preserves their failure policies, then verifies the saved
daily snapshot and standby frontend/API/auth. It does not require the primary
to be healthy or attach additional routes. A Vercel 402 carrying its explicit
deployment-disabled marker counts as an origin outage; an application's normal
402 does not. Safe reads may fail over once; submitted writes are not replayed.

VPS origin requests require both the Cloudflare address allowlist and a private
origin credential injected by the Worker. The public standby frontend is also
served through that Worker, so Redis and the backend port stay private. Fixed
operator probes require the origin credential; they never accept arbitrary
destination URLs or return account responses. A temporary single-IP test pin,
if configured, is valid for at most 15 minutes and grants no application access.

The two frontends have separate browser storage. Unsynced local-only data does
not automatically cross domains, and a previously established login may need
restoring from the canonical auth cookie. Hosted service failures, source
blocking and Cloudflare plan quotas are independent of the two host machines;
this configuration does not provide unlimited capacity or guaranteed uptime.


## Free-plan image routing

The `quota-relief` operation installs explicit no-script routes for image
endpoints on `api`/`standby` and static assets on the two frontend hosts. This
keeps their high-volume downloads out of the Workers invocation quota. JSON
API, auth, navigation and the more-specific source Worker remain unchanged.
The router still handles their existing host selection and mutations.

The browser downloads healthy images from the original primary host with no
additional health request. A fixed owned image GET/HEAD may retry once at the
standby after a network/host error; a successful fallback selects that image
origin for 60 seconds. Permission errors, missing images, rate limits and QQ
source errors retain the existing recovery behavior. No writes are replayed.

Nginx accepts only image/static public paths without the private Worker header,
from the existing Cloudflare IP allowlist. It derives their client IP from
Cloudflare's overwritten header, not a caller's private routing headers.
Internal, JSON and auth endpoints still require the private hop. No shared
image caches or Redis/public origins are introduced.

API/auth routes use request-limit fail-open: when Workers quota is exhausted,
their primary origin still validates authentication, site policy, rate limits
and CSRF. Frontend fail-open is enabled only after an independent Cloudflare
WAF country rule is installed; if the token lacks Rulesets permissions, the
operation reports the exact rule and retains frontend fail-closed. The rule
preserves the Vietnam frontend policy independently of the Worker budget.

Quota relief reduces invocations; it does not make the free plan unlimited.
Source relay calls still consume the same account-wide free budget. While
quota is exhausted, no new Worker-based routing decision or source relay can
run; origin image fallback and primary API/auth bypass do not require it.
