"""Read legacy statistics through exact, already-verified QQ identities.

No source requests, fuzzy matching, database scans, or data migrations. The
normal QQ listing already stores these cover hints in one batch.
"""
import json
import re

from fastapi_app.services.cache_service import cache
from truyenapi.truyenapi.parsers import identity

_NATIVE = re.compile(r"[a-z0-9][a-z0-9-]*-\d+\Z")
_MDX = re.compile(r"(?:(?:mdx-|mangadex[-:]))?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")


def item_slugs(item):
    slug = str(item.get("slug") or "").strip().lower()
    canonical = str(item.get("source_slug") or slug).strip().lower()
    if item.get("source") != "truyenqq" or not _NATIVE.fullmatch(canonical):
        return [slug] if slug else []
    stem = canonical.rsplit("-", 1)[0]
    # OTruyen used the title slug, while QQ appends its numeric comic ID.
    aliases = [slug, canonical, stem]
    return list(dict.fromkeys(aliases))


def cached_aliases(identifiers):
    identifiers = list(dict.fromkeys(str(value).strip().lower() for value in identifiers if value))
    identifiers = [identifier for identifier in identifiers if not _MDX.fullmatch(identifier)]
    if not identifiers:
        return {}
    keys = {identifier: f"truyenqq:cover-hint:{identifier}" for identifier in identifiers}
    try:
        values = cache.get_many(keys.values())
    except Exception:
        return {}  # Optional compatibility must not fail a ratings request.
    result = {}
    for identifier, key in keys.items():
        try:
            hint = json.loads(values.get(key) or "null")
            card = hint.get("card") if isinstance(hint, dict) else None
            if not isinstance(card, dict):
                continue
            stem, number, chapter = identity(hint["url"])
            canonical = f"{stem}-{number}"
            if chapter is not None or card.get("slug") != canonical:
                continue
            aliases = item_slugs({**card, "source": "truyenqq"})
            # Do not associate an unrelated cache key or guess a numeric suffix.
            if identifier in aliases:
                result[identifier] = aliases
        except (ValueError, TypeError, KeyError):
            continue
    return result
