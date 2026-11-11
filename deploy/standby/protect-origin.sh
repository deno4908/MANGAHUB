#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
# Apply only after standby DNS is proxied and its Under Attack exception exists.
/opt/mangahub/venv/bin/python - <<'PY'
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import urllib.request
from pathlib import Path

with urllib.request.urlopen('https://api.cloudflare.com/client/v4/ips', timeout=15) as response:
    result = json.load(response)
assert result['success']
networks = []
for version in (4, 6):
    parsed = [ipaddress.ip_network(value, strict=True) for value in result['result'][f'ipv{version}_cidrs']]
    assert parsed and all(network.version == version and network.is_global for network in parsed)
    networks.extend(parsed)
assert 10 <= len(networks) <= 100
addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo('standby.mangahub.art', 443, type=socket.SOCK_STREAM)}
assert addresses and all(any(ip in network for network in networks if ip.version == network.version) for ip in addresses), 'Standby DNS must be proxied first'
directory = Path('/etc/nginx/mangahub-origin-rules')
directory.mkdir(mode=0o755, exist_ok=True)
target = directory / 'cloudflare-only.conf'
prior = target.read_bytes() if target.exists() else None
content = '# Origin web ingress from Cloudflare and local maintenance only.\nallow 127.0.0.1;\nallow ::1;\n'
content += ''.join(f'allow {network};\n' for network in networks) + 'deny all;\n'
temporary = target.with_suffix('.pending')
temporary.write_text(content)
os.replace(temporary, target)
try:
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    if prior is None:
        target.unlink(missing_ok=True)
    else:
        target.write_bytes(prior)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print('Cloudflare-only web origin ingress enabled; SSH configuration unchanged')
PY
