#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
release=${1:?release directory required}
[[ $release =~ ^/opt/mangahub/releases/[a-zA-Z0-9._-]+$ && -f $release/backend/standby_app.py && -f $release/dist/index.html ]] || exit 1
export UV_PYTHON_INSTALL_DIR=/opt/mangahub/python
export UV_CONCURRENT_DOWNLOADS=2 UV_CONCURRENT_INSTALLS=1 UV_CONCURRENT_BUILDS=1
if [[ ! -x /opt/mangahub/venv/bin/python ]]; then
    uv venv --python 3.12 /opt/mangahub/venv
fi
uv pip install --python /opt/mangahub/venv/bin/python --only-binary :all: -r "$release/backend/requirements.txt"
# Keep content writable for bounded local snapshots and image files.
chown -R mangahub:mangahub "$release/backend"
# Preserve old hashed assets so already-open browsers survive a standby update.
cp -an "$release/dist/assets/." /opt/mangahub/assets/
ln -sfn "$release" /opt/mangahub/current.new
mv -Tf /opt/mangahub/current.new /opt/mangahub/current
install -m 644 "$release/deploy/standby/mangahub.service" /etc/systemd/system/mangahub.service
systemctl daemon-reload
systemctl enable mangahub >/dev/null
systemctl restart mangahub
