"""Hide verified, unmatched legacy QQ entries without deleting local history."""
import re

from fastapi import HTTPException

from fastapi_app.services.cache_service import cache
from fastapi_app.services.public_reads import cached_public_read

PREFIX = "catalog:qq-sync:v1:"


def legacy_qq_identifier(identifier):
    value = str(identifier or "").strip().lower()
    if value.startswith("mdx-") or re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value):
        return False
    return bool(value and not re.search(r"-\d+$", value))


def remember_matches(found):
    statuses = {PREFIX + identifier: "missing" if item is None else "available"
                for identifier, item in found.items() if legacy_qq_identifier(identifier)}
    if statuses:
        cache.set_many(statuses, ttl=1800)


def unmatched(identifiers, values=None):
    keys = {identifier: PREFIX + identifier for identifier in identifiers if legacy_qq_identifier(identifier)}
    values = cache.get_many(keys.values()) if values is None else values
    return {identifier for identifier, key in keys.items() if values.get(key) == "missing"}


async def published_uploads(db, identifiers):
    """Check local publications before asking a third-party catalog about them."""
    identifiers = tuple(sorted(set(identifiers)))
    if not identifiers:
        return {}

    def load():
        result = (db.table("manga_uploads").select("manga_slug,title,cover_url,genres,publish_status")
                  .in_("manga_slug", identifiers).eq("status", "published").execute())
        if not isinstance(getattr(result, "data", None), list):
            raise RuntimeError("Invalid local publication response")
        return result.data

    rows = await cached_public_read(("published-card-metadata", id(db), identifiers), load, None,
                                   ttl=30, wait_seconds=1.5)
    if rows is None:
        raise HTTPException(503, "Chưa thể kiểm tra dữ liệu truyện cục bộ. Vui lòng thử lại.")
    return {row["manga_slug"]: {"id": row["manga_slug"], "slug": row["manga_slug"],
            "source": "uploaded", "title": row.get("title") or "", "cover_url": row.get("cover_url") or "",
            "genres": row.get("genres") or [], "status": row.get("publish_status") or "ongoing"}
            for row in rows if row.get("manga_slug") in identifiers}
