# Website access sessions

`GET /api/site-access` verifies a signed login JWT, reads the current profile and
whitelist, then registers a random access session in the existing shared Redis.
It returns an expiry timestamp and sets a Secure, HttpOnly, host-only
`__Host-mh_access_v2` cookie on the API host. The frontend does not receive the
ticket in JSON, localStorage or JavaScript.

The ticket has a separate, server-generated signing key stored in Redis. Its
signature alone does not grant access: account ID, Supabase login session ID,
random ticket ID and expiry must match a registered Redis session. Client role
claims are never used to assign website roles. Forged, altered, unregistered,
expired or revoked tickets are rejected.

The access session lasts at most 24 hours. Normal reads and image requests check
Redis instead of repeatedly loading the Supabase profile and whitelist. JWTs
supplied with requests still undergo signature and lifetime validation. Refreshing
a Supabase JWT within the same login does not require another permission grant.
The frontend stops its ten-second permission polling and renews shortly before
expiry, with fresh profile and whitelist checks. Public anonymous visits and
legacy tokens without a login session ID keep the existing short-check flow.

Cookie tickets authorize reads only. Writes and privileged role dependencies
require a valid login bearer and a fresh profile/role check. Whitelist changes,
role changes and bans made through the application's admin routes invalidate
registered grants before the database write. Logout and password changes revoke
the appropriate login sessions. Revocation survives JWT refresh by retaining the
original login age/session ID; a revoked login cannot exempt itself by requesting
logout of other sessions. Active update streams stop on revocation.

Redis is required and must be shared by every backend instance. A Redis failure
returns an error; there is no local allow-list or signature-only fallback. Keep
this Redis database persistent and private, without eviction of session/security
keys. The signing key and session state are sensitive server credentials. No new
Vercel environment variables or SQL migration are needed; the existing
`REDIS_URL` is used. Deploy both frontend and backend from the same commit.

Use the application's admin routes for access changes. Direct SQL or Supabase
dashboard edits bypass these Redis invalidation hooks; existing ordinary read
grants can remain valid until renewal/expiry. Privileged operations still read
the current profile. If direct database administration must revoke ordinary read
grants immediately, add a trusted database webhook or explicitly invalidate the
affected user's grants with `access_tickets.security_change(user_id)` in the
backend administration process. Rotating the dedicated Redis signing key
invalidates all existing cookie tickets; clearing only a browser cookie is not
server-side logout.

Validation: install `backend/requirements-test.txt`, run `python -m pytest tests`,
then `npm test`, `npx tsc --noEmit` and `npm run build`. Ticket regression tests
cover issuance, forgery, session isolation, expiry, logout scopes, JWT refresh,
admin revocation, concurrent security changes, Redis failures and authenticated
streams. Frontend tests cover polling removal, renewal, deadline failure and
account changes.
