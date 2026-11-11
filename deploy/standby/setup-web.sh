#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq certbot > /var/log/mangahub-certbot-install.log 2>&1
install -d -m 755 /var/www/letsencrypt
cat > /etc/nginx/sites-available/mangahub-standby <<'CONF'
server {
 listen 80;
 server_name standby.mangahub.art;
 location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
 location / { return 404; }
}
CONF
if [[ -L /etc/nginx/sites-enabled/default ]]; then unlink /etc/nginx/sites-enabled/default; fi
ln -sfn /etc/nginx/sites-available/mangahub-standby /etc/nginx/sites-enabled/mangahub-standby
nginx -t
systemctl start nginx
certbot certonly --webroot -w /var/www/letsencrypt -d standby.mangahub.art --keep-until-expiring --non-interactive --agree-tos --register-unsafely-without-email
python3 - <<'PY'
from pathlib import Path
secret=Path('/etc/mangahub/origin-secret').read_text().strip()
template=Path('/opt/mangahub/current/deploy/standby/nginx.conf.template').read_text()
assert len(secret)==64 and all(c in '0123456789abcdef' for c in secret)
Path('/etc/nginx/sites-available/mangahub-standby').write_text(template.replace('ORIGIN_SECRET_PLACEHOLDER',secret))
PY
nginx -t
systemctl reload nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/mangahub-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mangahub-nginx
printf 'HTTPS origin ready.\n'
