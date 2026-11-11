# Vercel primary and VPS standby

Users normally enter `https://mangahub.art`. A failed frontend navigation is
redirected temporarily (307) to `https://standby.mangahub.art`, preserving its
path and query. The old `:8443` lab redirects to the primary domain.

The standby serves the same deployed frontend assets. Its frontend still calls
the canonical `api` and `auth` hosts, retaining their secure cookies and OAuth
callback. The router recognizes only the two exact, application-owned frontend
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

Health and response times are sampled at the Cloudflare location serving the
reader. This measures actual edge-to-origin latency, rather than guessing
from country or geographic distance. Samples are shared within an isolate for
30 seconds; ordinary reads do not wait for background probes.

While both origins are healthy, the standby receives at most a 10% API share,
increasing to 25% when measured faster or when the primary reports congestion.
Frontend navigation only moves proactively when the standby is measured
faster, or the primary is congested. Shares are intentionally bounded for a
1 GB machine. No extra share is assigned with low memory, excessive load or
more than eight active app requests. Actual primary outages take precedence.
Two healthy samples are required to restore an origin previously marked down.
Images retain the healthy Vercel origin to avoid fragmenting its warm cache;
they still fall back to the VPS on a Vercel failure. Image quality is unchanged.

GET/HEAD can be retried once at the other origin. Submitted writes are never
automatically replayed: a lost response might follow an already committed
write. A request already in flight during an outage can still fail.

## Deployment and rollback

`Manage adaptive standby router` is manual, with `inspect`, `prepare`,
`activate` and `rollback` operations. Inspect does not change routing. Prepare
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
