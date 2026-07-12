"""Resolve client IPs without trusting spoofable forwarding headers."""

from __future__ import annotations

import ipaddress
from functools import lru_cache
from typing import Any

from config import config


def _header_value(headers: Any, name: str) -> str:
    try:
        return str(headers.get(name) or headers.get(name.lower()) or "").strip()
    except Exception:
        return ""


def _parse_ip(value: Any) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.startswith("[") and "]" in raw:
        raw = raw[1 : raw.index("]")]
    elif raw.count(":") == 1 and "." in raw:
        host, port = raw.rsplit(":", 1)
        if port.isdigit():
            raw = host
    try:
        return ipaddress.ip_address(raw)
    except ValueError:
        return None


@lru_cache(maxsize=16)
def _trusted_networks(raw_value: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for raw_network in str(raw_value or "").split(","):
        value = raw_network.strip()
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def _is_trusted_proxy(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    networks: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...],
) -> bool:
    return any(address.version == network.version and address in network for network in networks)


def resolve_client_ip(
    peer_ip: Any,
    headers: Any,
    *,
    trusted_proxy_cidrs: str | None = None,
) -> str:
    """Use forwarding data only when the immediate peer is trusted.

    Nginx must overwrite X-Real-IP and append its peer to X-Forwarded-For.
    Walking X-Forwarded-For from right to left prevents a direct client from
    winning by prepending a forged address.
    """

    peer = _parse_ip(peer_ip)
    if peer is None:
        return "unknown"

    raw_networks = (
        str(trusted_proxy_cidrs)
        if trusted_proxy_cidrs is not None
        else str(getattr(config, "TRUSTED_PROXY_CIDRS", "") or "")
    )
    networks = _trusted_networks(raw_networks)
    if not networks or not _is_trusted_proxy(peer, networks):
        return str(peer)

    forwarded = _header_value(headers, "x-forwarded-for")
    if forwarded:
        candidates = [_parse_ip(part) for part in forwarded.split(",")]
        for candidate in reversed([item for item in candidates if item is not None]):
            if not _is_trusted_proxy(candidate, networks):
                return str(candidate)

    real_ip = _parse_ip(_header_value(headers, "x-real-ip"))
    if real_ip is not None:
        return str(real_ip)

    return str(peer)
