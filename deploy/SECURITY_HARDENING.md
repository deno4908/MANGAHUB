# Production security setup

Apply these steps before restarting the hardened backend. HTTPS deployments now
fail closed when Redis is unavailable.

## 1. Backend environment

Set these values in `backend/.env`:

```env
FRONTEND_URL=https://mangahub.art
BACKEND_BIND_HOST=127.0.0.1
REDIS_URL=redis://127.0.0.1:6379/0
SECURITY_REQUIRE_REDIS=true
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
```

Only Nginx is trusted by the application. Do not add `0.0.0.0/0` or broad
private networks to `TRUSTED_PROXY_CIDRS`.

The bundled `run.py` and `run2.py` launch Uvicorn with proxy-header parsing
disabled so the application can validate the immediate peer itself. If the VPS
starts Uvicorn directly, include `--no-proxy-headers` in `ExecStart`, for
example:

```ini
ExecStart=/opt/mangahub/venv/bin/uvicorn fastapi_app.main:app \
  --host 127.0.0.1 --port 8000 --no-proxy-headers
```

## 2. Install and lock down Redis

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping
```

`redis-cli ping` must return `PONG`. In `/etc/redis/redis.conf`, keep Redis local:

```conf
bind 127.0.0.1 ::1
protected-mode yes
```

Then restart it:

```bash
sudo systemctl restart redis-server
```

Do not expose TCP port `6379` through the VPS firewall.

## 3. Let Nginx resolve Cloudflare's real client IP

Create `/etc/nginx/snippets/cloudflare-real-ip.conf` from Cloudflare's current
official ranges. Refresh this file periodically because the ranges can change.

```bash
tmp_file="$(mktemp)"
curl -fsS https://www.cloudflare.com/ips-v4 | sed 's#^#set_real_ip_from #; s#$#;#' > "$tmp_file"
curl -fsS https://www.cloudflare.com/ips-v6 | sed 's#^#set_real_ip_from #; s#$#;#' >> "$tmp_file"
printf '%s\n' 'real_ip_header CF-Connecting-IP;' 'real_ip_recursive on;' >> "$tmp_file"
sudo install -m 0644 "$tmp_file" /etc/nginx/snippets/cloudflare-real-ip.conf
rm -f "$tmp_file"
```

Include it inside the MangaHub `server` block before the proxy locations:

```nginx
include /etc/nginx/snippets/cloudflare-real-ip.conf;
```

Use the `/api/` and `/auth/` proxy settings from
`deploy/nginx-social-preview.conf`; they overwrite `X-Real-IP` and append
`X-Forwarded-For` before forwarding to the loopback-only backend.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

For complete origin protection, allow SSH first, then restrict public ports
`80/443` to Cloudflare IP ranges or use Cloudflare Tunnel. Binding ports
`5000/8000` to `127.0.0.1` already prevents direct access to those services.

## 4. Apply the Supabase security migration

Run `backend/database/migration_v22_view_proxy_rls_security.sql` in the Supabase
SQL Editor, or with a direct database connection. Migrations v6, v15, v19, and
v21 must already be applied first:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/database/migration_v22_view_proxy_rls_security.sql
```

The migration removes direct `anon`/`authenticated` writes for comments,
reports, groups, group membership, and upload queues. The frontend already uses
FastAPI for these operations, so normal website behavior remains unchanged.

## 5. Verify after deployment

```bash
redis-cli ping
ss -lntp | grep -E ':(5000|8000)\b'
curl -fsS https://mangahub.art/api/maintenance
```

The `ss` output for ports `5000` and `8000` must show `127.0.0.1`, never
`0.0.0.0` or `[::]`.
