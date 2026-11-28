"""Authenticated handoff of public QQ HTML fetched by the owned source Worker.

A reader can forward an HMAC-signed source response across cache regions. The
proof never authorizes a reader: normal API authorization runs before storage.
Only allowlisted public GET endpoints can use the handoff transport.
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from contextvars import ContextVar
from functools import wraps
from urllib.parse import parse_qs

from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

MAX_BYTES = 2 * 1024 * 1024
SOURCE_PAGES = re.compile(r'^/(?:doc-truyen|tim-kiem-nang-cao|truyen-moi-cap-nhat|truyen-tranh-moi|truyen-hoan-thanh|truyen-yeu-thich|truyen-dich-qq|top-ngay|top-tuan|top-thang|the-loai|tac-gia|truyen-tranh)(?:/[a-zA-Z0-9._-]+)*$')
API_READS = re.compile(r'^/api/manga/(?:homepage|categories|truyenqq-filtered|otruyen-filtered|search|trending|detail/[a-zA-Z0-9-]+|chapter/[a-zA-Z0-9._-]+|(?:list|category)/[a-zA-Z0-9-]+(?:/batch)?|truyenqq/(?:cover/[a-zA-Z0-9-]+|image/[a-zA-Z0-9-]+/[a-zA-Z0-9._-]+/[0-9]+))$')
response_hints = ContextVar('qq_response_hints', default=None)
recovered_source = ContextVar('qq_recovered_source', default=None)


def failure_hints(error):
    """Keep only public source-denial hints, never auth denials or error bodies."""
    headers = (error.headers or {}) if hasattr(error, 'headers') else error if isinstance(error, dict) else {}
    path = headers.get('X-TruyenQQ-Source-Path', '')
    if (headers.get('X-TruyenQQ-Transport') == 'edge-gateway'
            or headers.get('X-TruyenQQ-Error') != 'http-403' or not isinstance(path, str)
            or len(path) > 2048 or not SOURCE_PAGES.fullmatch(path.split('?', 1)[0])):
        return {}
    names = {'X-TruyenQQ-Error', 'X-TruyenQQ-Source-Path', 'X-TruyenQQ-Recovery',
             'X-TruyenQQ-Transport', 'X-TruyenQQ-Block', 'X-TruyenQQ-Colo'}
    return {key: value for key, value in headers.items()
            if key in names and isinstance(value, str) and len(value) <= 2048
            and '\r' not in value and '\n' not in value}


def source_matches(url):
    value = recovered_source.get()
    if not value or not isinstance(url, str):
        return False
    return url in {value['path'], 'https://truyenqqko.com' + value['path']}


def surface_stale_hints(function):
    @wraps(function)
    async def wrapped(*args, **kwargs):
        payload = await function(*args, **kwargs)
        # This wrapper must sit OUTSIDE a shared-read wrapper: every waiter
        # has a separate HTTP request context, including cache-only waiters.
        hints = response_hints.get()
        data = payload.get('data') if isinstance(payload, dict) else None
        if hints is not None and isinstance(data, dict):
            failure = failure_hints(data.get('source_stale'))
            if failure:
                hints.update(failure)
        return payload
    return wrapped


def enabled():
    return len(os.getenv('QQ_RECOVERY_SECRET', '')) >= 32


def _decode(value):
    return base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)


def verify(snapshot, *, now=None):
    if not enabled() or not isinstance(snapshot, dict):
        raise ValueError('Source recovery is unavailable')
    proof, html = snapshot.get('proof'), snapshot.get('html')
    if not isinstance(proof, str) or len(proof) > 8192 or not isinstance(html, str):
        raise ValueError('Invalid source snapshot')
    content = html.encode('utf-8')
    if not content or len(content) > MAX_BYTES:
        raise ValueError('Invalid source size')
    try:
        encoded, signature = proof.split('.')
        raw = _decode(encoded)
        expected = hmac.new(os.environ['QQ_RECOVERY_SECRET'].encode(), raw, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _decode(signature)):
            raise ValueError('Invalid source signature')
        data = json.loads(raw)
    except (KeyError, TypeError, UnicodeError, ValueError) as error:
        raise ValueError('Invalid source proof') from error
    if not isinstance(data, dict) or data.get('v') != 1:
        raise ValueError('Invalid source proof version')
    path, keyword = data.get('path'), data.get('keyword', '')
    observed, expires = data.get('observed'), data.get('expires')
    current = time.time() if now is None else now
    if (type(observed) is not int or type(expires) is not int or not 0 < expires - observed <= 120
            or observed > current + 30 or expires <= current):
        raise ValueError('Expired source proof')
    if not isinstance(path, str) or len(path) > 2048 or not path.startswith('/') or '#' in path:
        raise ValueError('Invalid source path')
    base = path.split('?', 1)[0]
    search = base == '/frontend/search/search'
    if not search and not SOURCE_PAGES.fullmatch(base):
        raise ValueError('Unapproved source path')
    if not isinstance(keyword, str) or len(keyword) > 200 or (search != bool(keyword)):
        raise ValueError('Invalid source search')
    if data.get('sha256') != hashlib.sha256(content).hexdigest():
        raise ValueError('Source body changed')
    # A proof is issued only for a successful public source page. Also reject
    # error/challenge HTML rather than converting it into persistent source data.
    valid = r'search_info|no_result' if search else r'list_grid|book_info|chapter_content'
    if not re.search(valid, html) or re.search(r'cf-chl-|challenge-platform|Just a moment', html, re.I):
        raise ValueError('Invalid source page')
    return data


def _key(path, keyword=''):
    identity = json.dumps([path, keyword], ensure_ascii=False, separators=(',', ':'))
    return 'qq:recovered-source:v1:' + hashlib.sha256(identity.encode()).hexdigest()


def accept(snapshot):
    """Called only after the original request's API access checks succeed."""
    data = verify(snapshot)
    from fastapi_app.services.cache_service import cache
    cache.set(_key(data['path'], data.get('keyword', '')), json.dumps(snapshot, ensure_ascii=False),
              ttl=max(1, data['expires'] - int(time.time())))
    logger.info('QQ verified source handoff accepted kind=%s bytes=%d',
                data['path'].split('/')[1].split('?')[0], len(snapshot['html'].encode()))
    # Replace an older in-process source snapshot, without changing any other
    # comic or manufacturing parsed metadata from a browser-supplied object.
    from fastapi_app.services import truyenqq_service as qq
    live = qq._live
    if live is not None and not data.get('keyword'):
        url = live.source_url(data['path'])
        live.html_cache.invalidate(url)
        live.cache.invalidate_matching(lambda key: isinstance(key, tuple) and len(key) > 1 and key[1] == url)
        if data['path'] == '/doc-truyen':
            live.cache.invalidate('home')
            live.cache.invalidate('genres')
    return data


def lookup(request):
    if not enabled() or request.url.host != 'truyenqqko.com':
        return None
    path = request.url.raw_path.decode('ascii')
    keyword = ''
    if request.method == 'POST' and request.url.path == '/frontend/search/search':
        keyword = (parse_qs(request.read().decode()).get('search') or [''])[0]
    elif request.method != 'GET':
        return None
    from fastapi_app.services.cache_service import cache
    try:
        raw = cache.get(_key(path, keyword))
    except Exception:
        return None  # A content-cache outage must not break the normal source transport.
    if not isinstance(raw, str):
        return None
    try:
        snapshot = json.loads(raw)
        data = verify(snapshot)
        if data['path'] != path or data.get('keyword', '') != keyword:
            return None
        request.extensions['qq_snapshot_expires'] = data['expires']
        return snapshot['html'].encode('utf-8')
    except (TypeError, ValueError, UnicodeError):
        return None


class QQRecoveryMiddleware:
    def __init__(self, app, allowed_origins=()):
        self.app = app
        self.allowed_origins = set(allowed_origins)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST' or not any(
                key.lower() == b'x-truyenqq-recovery' and value == b'1' for key, value in scope['headers']):
            return await self.app(scope, receive, send)
        async def reject(status=400):
            headers = {'Cache-Control': 'no-store'}
            origin = next((value.decode() for key, value in scope['headers'] if key.lower() == b'origin'), '')
            if origin in self.allowed_origins:
                headers.update({'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true'})
            await JSONResponse({'detail': 'Invalid source recovery'}, status_code=status,
                               headers=headers)(scope, receive, send)
        if not API_READS.fullmatch(scope['path']):
            return await reject()
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body.extend(message.get('body', b''))
            # JSON escaping can expand the signed UTF-8 HTML, still bounded.
            if len(body) > MAX_BYTES * 2 + 16384:
                return await reject(413)
            if not message.get('more_body', False):
                break
        try:
            snapshot = json.loads(body)
            verify(snapshot)
        except (ValueError, UnicodeError):
            return await reject()
        scope = dict(scope)
        scope['method'] = 'GET'
        scope['headers'] = [(key, value) for key, value in scope['headers']
                            if key.lower() not in {b'content-length', b'x-truyenqq-recovery'}]
        scope['state'] = {**scope.get('state', {}), 'qq_source_snapshot': snapshot}
        consumed = False
        async def empty_body():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {'type': 'http.request', 'body': b'', 'more_body': False}
            return await receive()
        return await self.app(scope, empty_body, send)
