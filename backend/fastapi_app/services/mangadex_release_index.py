"""A shared index of each title's latest Vietnamese chapter release.

Only public catalog metadata is cached here. Access checks and hidden-title
filters still run on every API request. Refresh work runs after response body.
"""
import asyncio
import base64
import contextvars
import gzip
import hashlib
import json
import logging
import re
import time
import uuid
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

from redis.exceptions import RedisError
from redis_runtime import client_for, security_url
from serverless_runtime import create_task
from fastapi_app.services.mangadex_index_mirror import read_blob

logger = logging.getLogger(__name__)
PREFIX = "mh:mangadex-release-index:v1:vi:"
SEED = Path(__file__).with_name("mangadex_release_seed.json.gz")
TTL = 7 * 86400
SNAPSHOT_TTL = 1800
REFRESH_PAUSE_SECONDS = 0.7
_pending = contextvars.ContextVar("mangadex_index_refresh", default=None)
_local = OrderedDict()
_prepared = OrderedDict()
_selections = OrderedDict()
_selection_lock = RLock()


def _client():
    return client_for(security_url(), socket_timeout_seconds=3)


class IndexBuilding(RuntimeError):
    def __init__(self, scanned=0, total=0):
        super().__init__("Vietnamese release index is being prepared")
        self.scanned, self.total = scanned, total


def _now_stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _pack(state):
    raw = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode()
    return base64.b64encode(gzip.compress(raw, compresslevel=6)).decode()


def _unpack(value):
    if not value:
        return None
    state = json.loads(gzip.decompress(base64.b64decode(value)))
    if state.get("schema") != 1 or state.get("language") != "vi" or not (
            isinstance(state.get("rows"), dict) or re.fullmatch(r"[a-f0-9]{32}", str(state.get("base_version", "")))):
        raise ValueError("Invalid release index schema")
    return state


def _remember(key, value, seconds=10):
    with _selection_lock:
        _local[key] = (time.monotonic() + seconds, value)
        _local.move_to_end(key)
        while len(_local) > 4:
            _local.popitem(last=False)
    return value


def _seed():
    try:
        state = json.loads(gzip.decompress(SEED.read_bytes()))
        if state.get("schema") != 1 or state.get("language") != "vi" or not isinstance(state.get("rows"), dict):
            return None
        state.setdefault("last_full_sync", datetime.fromisoformat(state["watermark"]).replace(tzinfo=timezone.utc).timestamp())
        return state
    except (OSError, ValueError, KeyError, TypeError):
        return None


def invalidate_active():
    # Existing browser snapshots keep their order; a new first page can adopt
    # the shared live probe without waiting for the full incremental scan.
    _local.pop("active", None)


def _with_live_probe(state):
    from fastapi_app.services import cache_service
    try:
        raw = cache_service.cache.get("catalog:probe:mangadex")
        rows = (json.loads(raw).get("data") or []) if isinstance(raw, str) else []
    except (RedisError, ValueError, TypeError):
        return state
    changes = {}
    for row in rows:
        if (row.get("attributes") or {}).get("translatedLanguage") != "vi":
            continue
        mid = manga_relation(row).get("id")
        current = changes.get(mid) or state["rows"].get(mid)
        if mid and (current is None or release_order(row) >= release_order(current)):
            value = compact(row)
            if value != current:
                changes[mid] = value
    if not changes:
        return state
    version = uuid.uuid5(uuid.NAMESPACE_URL, state["version"] + json.dumps(changes, sort_keys=True)).hex
    return {**state, "rows": {**state["rows"], **changes}, "version": version}


def _state(snapshot=""):
    key = "snapshot:" + snapshot if re.fullmatch(r"[a-f0-9]{32}", snapshot or "") else "active"
    entry = _local.get(key)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    active = _local.get("active")
    if active and active[0] > time.monotonic() and active[1].get("version") == snapshot:
        return active[1]
    client = _client()
    try:
        if key != "active":
            old = _unpack(read_blob(client, PREFIX + key))
            if old and old.get("ready"):
                if "rows" not in old:
                    base_key = "snapshot:" + old["base_version"]
                    base_entry = _local.get(base_key)
                    base = base_entry[1] if base_entry and base_entry[0] > time.monotonic() else _unpack(read_blob(client, PREFIX + base_key))
                    if base and isinstance(base.get("rows"), dict):
                        _remember(base_key, base, SNAPSHOT_TTL)
                        old = {**base, **old, "rows": base["rows"]}
                    else:
                        old = None
            if old and old.get("ready") and "rows" in old:
                return _remember(key, old)
        state = _unpack(read_blob(client, PREFIX + "state"))
    except (RedisError, ValueError, OSError):
        state = None
    if not state or not state.get("ready"):
        state = _seed()
    if state and state.get("ready"):
        state = _with_live_probe(state)
        version = state["version"]
        try:
            snapshot_key = PREFIX + "snapshot:" + version
            # Most cold workers adopt an existing shared snapshot. A tiny
            # existence read avoids re-uploading megabytes with SET NX.
            if not client.exists(snapshot_key):
                client.set(snapshot_key, _pack(state), nx=True, ex=SNAPSHOT_TTL + 60)
        except RedisError:
            pass
        _remember("snapshot:" + version, state, SNAPSHOT_TTL)
        return _remember("active", state)
    return None


def request_refresh():
    pending = _pending.get()
    if pending is not None:
        pending.add("vi")


def _mature_marker(value):
    text = str(value or "").lower()
    if re.search(r"(^|[^0-9a-z])(18\+|\+18|18\s*plus|18[-_\s]*plus|r[-_\s]*18|x[-_\s]*18)([^0-9a-z]|$)", text):
        return True
    text = "".join(ch for ch in unicodedata.normalize("NFD", text) if not unicodedata.combining(ch)).replace("đ", "d")
    text = re.sub(r"[^a-z0-9+\s-]+", " ", text)
    return any(term in text for term in ("adult", "mature", "erotica", "pornographic", "explicit", "hentai", "ecchi", "smut", "nsfw", "r18",
        "nguoi lon", "noi dung nguoi lon", "noi dung nhay cam", "tinh duc", "bao luc tinh duc", "sexual violence", "sexual-violence",
        "sexual assault", "sexual-assault", "sexual abuse", "sexual-abuse", "truong thanh", "adults only", "adult only", "for adults", "18 plus", "18-plus", "+18", "r-18"))


def manga_relation(row):
    return next((rel for rel in row.get("relationships", []) if rel.get("type") == "manga"), {})


def release_order(row):
    attrs = row.get("attributes") or {}
    return (attrs.get("readableAt") or attrs.get("publishAt") or attrs.get("createdAt") or "", row.get("id", ""))


def compact(row):
    fields = ("chapter", "title", "translatedLanguage", "publishAt", "readableAt", "createdAt", "updatedAt")
    manga_fields = ("title", "altTitles", "status", "contentRating", "tags", "originalLanguage", "year", "lastChapter", "lastVolume", "demographic")
    relations = []
    for rel in row.get("relationships", []):
        attrs = rel.get("attributes") or {}
        if rel.get("type") == "manga":
            relations.append({"id": rel["id"], "type": "manga", "attributes": {k: attrs[k] for k in manga_fields if k in attrs}})
        elif rel.get("type") == "scanlation_group":
            relations.append({"id": rel.get("id", ""), "type": "scanlation_group", "attributes": {"name": attrs.get("name", "")}})
    return {"id": row["id"], "attributes": {k: (row.get("attributes") or {}).get(k, "") for k in fields}, "relationships": relations}


async def page_rows(*, page, limit, ratings, excluded, tags, statuses, keyword, snapshot="",
                    sort="latest", year=None, min_rating=0, statistics=None, original_languages=None,
                    release_state=None):
    # A fresh first page can adopt new releases; later pages stay on the
    # immutable version they started browsing so their titles do not overlap.
    state = release_state if release_state is not None else await asyncio.to_thread(_state, "" if page == 1 else snapshot)
    if not state:
        request_refresh()
        raise IndexBuilding()
    if time.time() - state.get("last_checked", 0) >= 60:
        request_refresh()
    if statistics is not None and "statistics" not in state:
        version = uuid.uuid5(uuid.NAMESPACE_URL, state["version"] + hashlib.sha256(
            json.dumps(statistics, sort_keys=True).encode()).hexdigest()).hex
        key = "snapshot:" + version
        entry = _local.get(key)
        if entry and entry[0] > time.monotonic():
            state = entry[1]
        else:
            state = {**state, "base_version": state["version"], "version": version, "statistics": statistics}
            # The base release snapshot already persists the large metadata.
            # Store only aggregate statistics and its reference for this view.
            manifest = {k: state[k] for k in ("schema", "language", "ready", "base_version", "version", "statistics")}
            try:
                def publish():
                    client = _client()
                    # A reader snapshot cannot outlive the base it references.
                    base_key = PREFIX + "snapshot:" + state["base_version"]
                    if not client.expire(base_key, SNAPSHOT_TTL + 60):
                        base = {k: v for k, v in state.items() if k not in {"statistics", "base_version"}}
                        base["version"] = state["base_version"]
                        client.set(base_key, _pack(base), nx=True, ex=SNAPSHOT_TTL + 60)
                    client.set(PREFIX + key, _pack(manifest), nx=True, ex=SNAPSHOT_TTL)
                await asyncio.to_thread(publish)
            except RedisError:
                pass
            _remember(key, state, SNAPSHOT_TTL)
    statistics = state["statistics"] if "statistics" in state else (statistics or {})
    return await asyncio.to_thread(_select_page, state, page, limit, ratings, excluded, tags,
        statuses, keyword, sort, year, min_rating, statistics, original_languages)


def warm_index():
    """Prepare the public index once during native startup, without HTTP reads."""
    state = _state()
    if not state:
        return False
    with _selection_lock:
        _prepared_rows(state)
    return True


def _prepared_rows(state):
    from fastapi_app.services import mangadex_service as mdx
    version = state.get("base_version") or state["version"]
    cached = _prepared.get(version)
    if cached is not None:
        _prepared.move_to_end(version)
        return cached
    prepared = []
    for row in state["rows"].values():
        if (row.get("attributes") or {}).get("translatedLanguage") != "vi":
            continue
        relation = manga_relation(row)
        attrs = relation.get("attributes") or {}
        names = [*(attrs.get("title") or {}).values(), *(name for entry in attrs.get("altTitles", []) for name in entry.values())]
        title = mdx._pick_title(attrs)
        if not title or not any(str(name or "").strip() for name in names):
            continue
        prepared.append((row, relation["id"], attrs, title.casefold(),
            frozenset(tag.get("id") for tag in attrs.get("tags", [])),
            tuple(mdx._slugify_tag(name) for name in names),
            any(_mature_marker(value) for value in [title, *mdx._extract_genres(attrs)])))
    _prepared[version] = prepared
    while len(_prepared) > 2:
        _prepared.popitem(last=False)
    return prepared


def _select_page(state, page, limit, ratings, excluded, tags, statuses, keyword, sort, year,
                 min_rating, statistics, original_languages):
    key = (state["version"], tuple(sorted(ratings)), tuple(sorted(excluded)), tuple(sorted(tags)),
           tuple(sorted(statuses)), keyword, sort, year, min_rating, tuple(sorted(original_languages or [])))
    with _selection_lock:
        selected = _selections.get(key)
        if selected is None:
            selected = _filter_and_sort(state, ratings, excluded, tags, statuses, keyword, sort,
                                        year, min_rating, statistics, original_languages)
            _selections[key] = selected
            while len(_selections) > 64:
                _selections.popitem(last=False)
        else:
            _selections.move_to_end(key)
    total = len(selected)
    page = min(max(1, page), max(1, (total + limit - 1) // limit))
    return [{**row, "browse_statistics": statistics.get(manga_relation(row)["id"], {})}
            for row in selected[(page - 1) * limit:page * limit]], total, page, state["version"]


def _filter_and_sort(state, ratings, excluded, tags, statuses, keyword, sort, year, min_rating,
                     statistics, original_languages):
    from fastapi_app.services import mangadex_service as mdx
    title_query = mdx._slugify_tag(keyword)
    required_tags = frozenset(tags)
    exclude_mature = set(ratings).issubset({"safe", "suggestive"})
    selected = []
    for row, mid, attrs, title, tag_ids, names, mature in _prepared_rows(state):
        if mid in excluded or attrs.get("contentRating", "safe") not in ratings:
            continue
        if statuses and attrs.get("status") not in statuses:
            continue
        if original_languages and attrs.get("originalLanguage") not in original_languages:
            continue
        if year and str(attrs.get("year") or "") != str(year):
            continue
        if float((statistics.get(mid) or {}).get("rating_average", 0)) < min_rating:
            continue
        if exclude_mature and mature:
            continue
        if not required_tags.issubset(tag_ids):
            continue
        if title_query and not any(title_query in name for name in names):
            continue
        selected.append(row)
    selected.sort(key=release_order, reverse=True)
    if sort in {"title", "alphabetical"}:
        selected.sort(key=lambda row: (mdx._pick_title(manga_relation(row).get("attributes") or {}).casefold(), manga_relation(row)["id"]))
    elif sort == "popular":
        selected.sort(key=lambda row: int((statistics.get(manga_relation(row)["id"]) or {}).get("views", 0)), reverse=True)
    elif sort == "rating":
        selected.sort(key=lambda row: (
            float((statistics.get(manga_relation(row)["id"]) or {}).get("rating_average", 0)),
            int((statistics.get(manga_relation(row)["id"]) or {}).get("rating_count", 0)),
            int((statistics.get(manga_relation(row)["id"]) or {}).get("views", 0))), reverse=True)
    return tuple(selected)


_SAVE = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('expire', KEYS[1], 45)
return 1
"""
_DONE = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('del', KEYS[3])
return 1
"""
_UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"


async def refresh_step(budget=20):
    """One leased, bounded incremental scan; never runs in the response path."""
    from fastapi_app.services import mangadex_service as mdx
    client, token = _client(), uuid.uuid4().hex
    lock = PREFIX + "lease"
    acquired = await asyncio.to_thread(client.set, lock, token, nx=True, ex=45)
    if not acquired:
        return
    work = None
    try:
        active = _unpack(await asyncio.to_thread(client.get, PREFIX + "state")) or _seed()
        if active and active.get("ready") and time.time() - active.get("last_checked", 0) < 60:
            return
        work = _unpack(await asyncio.to_thread(client.get, PREFIX + "working"))
        if not work:
            full_due = not active or time.time() - active.get("last_full_sync", 0) >= 86400
            if active and active.get("ready") and not full_due:
                work = {**active, "rows": dict(active["rows"]), "mode": "updatedAt", "cursor": active["watermark"], "skip": 0}
            else:
                work = {"schema": 1, "language": "vi", "rows": {}, "mode": "createdAt", "cursor": "", "skip": 0,
                        "scanned": 0, "ready": False, "watermark": _now_stamp(), "version": uuid.uuid4().hex}
            work.update(started=_now_stamp(), changed=False)
        deadline = time.monotonic() + budget
        pages = 0
        while time.monotonic() < deadline:
            field = work["mode"]
            params = {"translatedLanguage[]": "vi", "includes[]": ["manga", "scanlation_group"],
                      "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
                      "includeFuturePublishAt": 0, "order[" + field + "]": "asc", "limit": 100, "offset": work["skip"]}
            if work["cursor"]:
                params[field + "Since"] = work["cursor"]
            if params["offset"] + 100 > 10000:
                raise RuntimeError("Index timestamp group exceeds the upstream window")
            response = await mdx._request_json("/chapter", params)
            rows = response.get("data") or []
            pages += 1
            for row in rows:
                if (row.get("attributes") or {}).get("translatedLanguage") != "vi":
                    continue
                mid = manga_relation(row).get("id")
                if mid and (mid not in work["rows"] or release_order(row) >= release_order(work["rows"][mid])):
                    value = compact(row)
                    if work["rows"].get(mid) != value:
                        work["changed"] = True
                        work["rows"][mid] = value
            work["scanned"] = work.get("scanned", 0) + len(rows)
            if len(rows) < 100:
                if active and active.get("ready") and active["rows"] and not work["rows"]:
                    raise RuntimeError("Refusing an empty replacement for a known release index")
                done = {"schema": 1, "language": "vi", "rows": work["rows"], "ready": True,
                        "watermark": work["started"], "last_checked": time.time(),
                        "last_full_sync": time.time() if field == "createdAt" else work.get("last_full_sync", 0),
                        "version": uuid.uuid4().hex if work["changed"] else work["version"]}
                saved = await asyncio.to_thread(client.eval, _DONE, 3, lock, PREFIX + "state", PREFIX + "working", token, _pack(done), TTL)
                if saved:
                    _remember("active", done)
                work = None
                return
            stamp = str((rows[-1].get("attributes") or {}).get(field, ""))[:19]
            if not stamp:
                raise RuntimeError("Missing source index cursor")
            if stamp == work["cursor"]:
                work["skip"] += len(rows)
            else:
                work["cursor"], work["skip"] = stamp, sum(str((row.get("attributes") or {}).get(field, ""))[:19] == stamp for row in rows)
            if pages % 10 == 0:
                saved = await asyncio.to_thread(client.eval, _SAVE, 2, lock, PREFIX + "working", token, _pack(work), TTL)
                if not saved:
                    return
            await asyncio.sleep(REFRESH_PAUSE_SECONDS)
    finally:
        if work:
            await asyncio.to_thread(client.eval, _SAVE, 2, lock, PREFIX + "working", token, _pack(work), TTL)
        await asyncio.to_thread(client.eval, _UNLOCK, 1, lock, token)


class ReleaseIndexMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        jobs = set()
        token = _pending.set(jobs)
        started = False

        async def run():
            try:
                await refresh_step()
            except Exception as error:
                logger.warning("MangaDex index refresh deferred: %s", type(error).__name__)

        async def wrapped_send(message):
            nonlocal started
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False) and jobs and not started:
                started = True
                # The outer RequestTasksMiddleware keeps this finite task alive
                # on Vercel even when inner HTTP middleware finishes its scope.
                create_task(run())

        try:
            await self.app(scope, receive, wrapped_send)
        finally:
            _pending.reset(token)
