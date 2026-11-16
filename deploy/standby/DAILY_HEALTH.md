The router uses one shared health snapshot, refreshed at most once per 24 hours.
Install `daily-health.py` in `/opt/mangahub/router-health/`, and the matching
service/timer in `/etc/systemd/system/`. Create `/var/lib/mangahub-router-health`
before starting the service. It reads the existing private origin secret from
`/etc/mangahub/origin-secret`; no new credentials are needed.

The hourly timer only reads the saved timestamp until the snapshot is 24 hours
old. It then checks the fixed primary frontend/API/auth and native standby
readiness/frontend concurrently, and replaces the JSON atomically. Both host
groups share this file across Worker restarts and Cloudflare locations.

The Nginx configuration serves this JSON only to signed origin requests.
Apply the health route exceptions with `quota-relief` before deploying the
router with `DAILY_HEALTH_SHARED=true`. Verify anonymous access remains 404,
the private `daily-health` operator report is initialized, and the outage drill
recovers both origins. The independent country WAF rule must remain enabled.

Reading the saved file (at most once a minute per active isolate) does not run
origin probes and bypasses Workers. Ordinary GETs do not wait for this read.
Distance estimates use actual request timing from the caller's Cloudflare edge,
not timings collected by the daily job in Sydney. Actual safe read failures
still try the other origin once. Submitted writes are never replayed. A fresh
daily snapshot can restore a previously failed origin; local observed failures
are not overwritten by rereading yesterday's healthy snapshot.

If the private file is unavailable, healthy primary reads continue and actual
read failures can still try standby. This does not make the site independent of
the free Workers quota: application requests and the QQ source relay still count.
