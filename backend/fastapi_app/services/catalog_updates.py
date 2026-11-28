"""Shared source probes and revision events for live catalog updates.

Only one worker probes each source per interval. Browsers share the result;
opening more tabs never multiplies source crawling.
"""
import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

from config import config
from fastapi_app.services import cache_service, mangadex_service as mdx, truyenqq_service as qq

logger = logging.getLogger(__name__)
try:
    POLL_SECONDS = max(5, int(os.getenv("CATALOG_POLL_SECONDS", "8")))
except ValueError:
    POLL_SECONDS = 8
SOURCES = ("truyenqq", "mangadex")
STATE_PREFIX = "catalog:revision:v1:"


def qq_listing_entries(payload):
    """Use chapter identities from a verified source listing, without a probe."""
    items = (payload.get("data") or {}).get("items") or []
    return {item["slug"]: {"slug": item["slug"], "chapter_id":
            ((item.get("chaptersLatest") or [{}])[0].get("chapter_api_data") or "").rsplit("/", 1)[-1],
            "chapter_name": (item.get("chaptersLatest") or [{}])[0].get("chapter_name", "")}
            for item in items if item.get("slug")}


class CatalogUpdates:
    def __init__(self):
        self.current = {}
        self._warm_qq = None

    def _redis(self):
        return getattr(cache_service.cache, "_client", None)

    def _claim(self, source):
        client = self._redis()
        if client is None:
            return not config.SECURITY_REQUIRE_REDIS
        token = uuid.uuid4().hex
        if not client.set(f"catalog:probe-active:{source}", token, nx=True, ex=120):
            return False
        bucket = int(time.time() // POLL_SECONDS)
        if client.set(f"catalog:probe-lock:{source}:{bucket}", "1", nx=True, ex=max(60, POLL_SECONDS * 3)):
            return token
        self._release(source, token)
        return False

    def _release(self, source, token):
        if not isinstance(token, str):
            return
        client = self._redis()
        if client is not None:
            client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        1, f"catalog:probe-active:{source}", token)

    async def probe(self, source):
        if source == "truyenqq":
            value = await qq.run_live("collection", "latest", 1, refresh=True)
            if not value.get("items"):
                raise ValueError("Empty QQ update probe")
            self._warm_qq = await asyncio.to_thread(qq._page, value)
            return qq_listing_entries(self._warm_qq)
        payload = await mdx._request_json("/chapter", {
            "translatedLanguage[]": "vi", "includes[]": ["user", "scanlation_group", "manga"],
            "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
            "order[readableAt]": "desc", "limit": 100, "offset": 0,
        })
        rows = payload.get("data")
        if not isinstance(rows, list) or not rows:
            raise ValueError("Empty MangaDex update probe")
        await asyncio.to_thread(cache_service.cache.set, "catalog:probe:mangadex", json.dumps(payload), ttl=max(1800, POLL_SECONDS * 2))
        entries = {}
        for chapter in rows:
            slug = mdx._extract_manga_id_from_chapter(chapter)
            attributes = chapter.get("attributes") or {}
            if slug and slug not in entries:
                entries[slug] = {"slug": slug, "chapter_id": chapter.get("id", ""),
                    "chapter_name": str(attributes.get("chapter") or "0"),
                    "updated_at": attributes.get("updatedAt", "")}
        if not entries:
            raise ValueError("MangaDex probe has no manga relationships")
        return entries

    def _read_state(self, source):
        raw = cache_service.cache.get(STATE_PREFIX + source)
        if not isinstance(raw, str):
            return None
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else None
        except ValueError:
            return None

    def _invalidate(self, event, shared, preserve_latest=False):
        source = event["source"]
        changes = event["changes"]
        slugs = [change["slug"] for change in changes]
        if source == "truyenqq":
            qq.invalidate_live_catalog(slugs, preserve_latest=preserve_latest)
        else:
            mdx._vi_catalog_lookup_index.clear()
            mdx._vi_catalog_lookup_index_at = 0
            from fastapi_app.services import mangadex_release_index
            mangadex_release_index.invalidate_active()
        # These snapshots are small, source-dependent display caches.
        if shared:
            cache_service.cache.set(f"catalog:source-version:{source}", event["revision"], ttl=86400)
            patterns = ["manga:list-combined:*", "manga:trending:*", "manga:sitemap:*"]
            if source == "truyenqq":
                patterns += ["truyenqq:live-list:*", "truyenqq:list:*", "truyenqq:home", "manga:truyenqq-filtered:*",
                             "qq:browse-source:*"]
                patterns += [f"truyenqq:detail:{slug}*" for slug in slugs]
            else:
                patterns += ["mangadex:latest-vi-feed:*", "mangadex:search:*", "mangadex:vi-catalog:public:*",
                             "manga:mangadex-popular*"]
                for change in changes:
                    slug = change["slug"]
                    patterns += [f"mangadex:detail:v*:{slug}:*", f"mangadex:lookup:*{slug}*",
                                 f"mangadex:metadata:{slug}*", f"mangadex:detail-chapter-page:{slug}:*",
                                 f"mangadex:latest-chapter:*{slug}*",
                                 f"mangadex:chapter-pages:{change['chapter_id']}:*"]
            cache_service.cache.flush_patterns(patterns)
            for slug in slugs:
                cache_service.cache.set(f"catalog:book-version:{source}:{slug}", event["revision"], ttl=86400)
            if source == "mangadex":
                for change in changes:
                    info = {"id": change["chapter_id"], "chapter_name": change["chapter_name"],
                            "chapter_title": "", "publish_at": change.get("updated_at", "")}
                    cache_service.cache.set(mdx._latest_chapter_cache_key(change["slug"], "vi"),
                                            json.dumps(info), ttl=mdx.VI_CATALOG_TTL)
        # Rankings have a separate, process-local display cache.
        from fastapi_app.routers import manga
        manga._trending_memory_cache.clear()

    async def publish(self, source, entries, *, qq_payload=None):
        latest = qq_payload if qq_payload is not None else self._warm_qq
        previous = await asyncio.to_thread(self._read_state, source)
        fingerprint = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
        if previous and previous.get("fingerprint") == fingerprint:
            if source == "truyenqq" and latest:
                await asyncio.to_thread(self._remember_qq, latest)
            return None
        before = (previous or {}).get("entries") or {}
        changes = [entry for slug, entry in entries.items() if before.get(slug) != entry]
        event = {"source": source, "revision": uuid.uuid4().hex,
                 "observed_at": datetime.now(timezone.utc).isoformat(), "changes": changes}
        await asyncio.to_thread(self._invalidate, event, True, source == "truyenqq")
        if source == "truyenqq" and latest:
            await asyncio.to_thread(self._remember_qq, latest)
        state = {"event": event, "entries": entries, "fingerprint": fingerprint}
        await asyncio.to_thread(cache_service.cache.set, STATE_PREFIX + source, json.dumps(state), 86400)
        self.current[source] = event
        return event

    def _remember_qq(self, payload=None):
        qq.remember_list('truyen-moi', 1, payload if payload is not None else self._warm_qq,
                         fresh_seconds=max(15, POLL_SECONDS * 2))

    async def observe_qq_listing(self, payload):
        """Publish the result of an existing reader fetch, never fetch it again.

        Native startup probes cannot borrow a logged-in reader's credentials.
        Successful interactive reads must still reach the revision stream.
        Only the unfiltered first latest page represents this source snapshot.
        """
        entries = qq_listing_entries(payload)
        if not entries:
            return None
        return await self.publish("truyenqq", entries, qq_payload=payload)

    async def sync(self):
        for source in SOURCES:
            state = await asyncio.to_thread(self._read_state, source)
            event = (state or {}).get("event")
            if not isinstance(event, dict) or not event.get("revision"):
                continue
            if self.current.get(source, {}).get("revision") == event["revision"]:
                continue
            await asyncio.to_thread(self._invalidate, event, False)
            self.current[source] = event

    async def _source_loop(self, source):
        failures = 0
        while True:
            started = time.monotonic()
            claim = None
            try:
                claim = await asyncio.to_thread(self._claim, source)
                if claim:
                    entries = await self.probe(source)
                    await self.publish(source, entries)
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failures = min(failures + 1, 3)
                logger.warning("Catalog probe %s unavailable (%s)", source, type(error).__name__)
            finally:
                if claim:
                    try:
                        await asyncio.to_thread(self._release, source, claim)
                    except Exception:
                        logger.debug("Catalog probe lease will expire for %s", source)
            delay = min(60, POLL_SECONDS * (2 ** failures))
            await asyncio.sleep(max(1, delay - (time.monotonic() - started)))

    async def refresh_once(self):
        """A finite, distributed-lock-protected probe for serverless requests."""
        async def refresh(source):
            claim = None
            try:
                claim = await asyncio.to_thread(self._claim, source)
                if claim:
                    await self.publish(source, await self.probe(source))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("Catalog probe %s unavailable (%s)", source, type(error).__name__)
            finally:
                if claim:
                    try:
                        await asyncio.to_thread(self._release, source, claim)
                    except Exception:
                        logger.debug("Catalog probe lease will expire for %s", source)

        await asyncio.gather(*(refresh(source) for source in SOURCES))
        await self.sync()

    async def _sync_loop(self):
        while True:
            try:
                await self.sync()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.debug("Catalog revision sync unavailable (%s)", type(error).__name__)
            await asyncio.sleep(1)

    async def run(self):
        tasks = [asyncio.create_task(self._source_loop(source)) for source in SOURCES]
        tasks.append(asyncio.create_task(self._sync_loop()))
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


catalog_updates = CatalogUpdates()
