#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
apt-get update -qq
apt-get install -y -qq nginx redis-server openssl ca-certificates curl libgomp1 > /var/log/mangahub-bootstrap.log 2>&1
# This installer is for an empty standby machine, not an existing production host.
systemctl stop nginx
if ! id mangahub >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /opt/mangahub --shell /usr/sbin/nologin mangahub
fi
install -d -m 755 /opt/mangahub /opt/mangahub/releases /opt/mangahub/assets
install -d -o mangahub -g mangahub -m 750 /var/lib/mangahub
install -d -o root -g mangahub -m 750 /etc/mangahub
if [[ ! -x /usr/local/bin/uv ]]; then
  curl -fsSL https://astral.sh/uv/install.sh -o /tmp/mangahub-uv-install.sh
  UV_UNMANAGED_INSTALL=/usr/local/bin sh /tmp/mangahub-uv-install.sh >/var/log/mangahub-uv-install.log 2>&1
fi
export UV_PYTHON_INSTALL_DIR=/opt/mangahub/python
uv python install 3.12
if [[ $(swapon --noheadings --show | wc -l) == 0 && ! -e /swapfile-mangahub ]]; then
  fallocate -l 1G /swapfile-mangahub
  chmod 600 /swapfile-mangahub
  mkswap /swapfile-mangahub >/dev/null
  swapon /swapfile-mangahub
  printf '/swapfile-mangahub none swap sw 0 0\n' >> /etc/fstab
fi
install -d -o redis -g redis -m 750 /etc/redis/mangahub-tls
if [[ ! -f /etc/redis/mangahub-tls/server.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj /CN=MangaHub-local-Redis-CA \
    -keyout /etc/redis/mangahub-tls/ca.key -out /etc/redis/mangahub-tls/ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj /CN=localhost \
    -keyout /etc/redis/mangahub-tls/server.key -out /etc/redis/mangahub-tls/server.csr 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n' > /etc/redis/mangahub-tls/extensions
  openssl x509 -req -days 825 -in /etc/redis/mangahub-tls/server.csr \
    -CA /etc/redis/mangahub-tls/ca.crt -CAkey /etc/redis/mangahub-tls/ca.key -CAcreateserial \
    -extfile /etc/redis/mangahub-tls/extensions -out /etc/redis/mangahub-tls/server.crt 2>/dev/null
  chown -R redis:redis /etc/redis/mangahub-tls
  chmod 600 /etc/redis/mangahub-tls/*.key
fi
install -m 644 /etc/redis/mangahub-tls/ca.crt /etc/mangahub/redis-ca.crt
if [[ ! -f /etc/mangahub/redis.password ]]; then
  (umask 077; openssl rand -hex 32 > /etc/mangahub/redis.password)
fi
if [[ ! -f /etc/redis/redis.conf.before-mangahub ]]; then
  cp -p /etc/redis/redis.conf /etc/redis/redis.conf.before-mangahub
fi
python3 - <<'PY'
from pathlib import Path
password=Path('/etc/mangahub/redis.password').read_text().strip()
Path('/etc/redis/redis.conf').write_text(f"""bind 127.0.0.1 ::1
protected-mode yes
port 0
tls-port 6379
tls-cert-file /etc/redis/mangahub-tls/server.crt
tls-key-file /etc/redis/mangahub-tls/server.key
tls-ca-cert-file /etc/redis/mangahub-tls/ca.crt
tls-auth-clients no
requirepass {password}
maxmemory 96mb
maxmemory-policy allkeys-lru
save ""
appendonly no
daemonize no
supervised systemd
logfile ""
dir /var/lib/redis
""")
PY
chown redis:redis /etc/redis/redis.conf
chmod 640 /etc/redis/redis.conf
install -d /etc/systemd/system/redis-server.service.d
printf '[Service]\nMemoryHigh=128M\nMemoryMax=160M\n' > /etc/systemd/system/redis-server.service.d/mangahub-memory.conf
systemctl daemon-reload
systemctl enable redis-server >/dev/null
systemctl restart redis-server
printf 'Bootstrap complete; Redis is local TLS only.\n'
free -m
