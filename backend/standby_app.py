"""Full VPS app with private readiness and bounded load-balancer telemetry.

Authentication, source access, data and public routes stay in the combined app.
The health loop does not add Redis work to an image or reader's request.
"""
import asyncio
import hmac
import json
import os
import time
from pathlib import Path
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

from config import config
from redis_runtime import client_for, security_client
from standby_primary import frontend_healthy


def capacity(active):
    try:
        memory = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                      if line.startswith('MemAvailable:'))
        load = os.getloadavg()[0]
        pressure = Path('/proc/pressure/memory').read_text().split('avg10=', 1)[1].split()[0]
        available = active <= 8 and memory >= 128 * 1024 and load < 3 and float(pressure) < 2
        return {'accept_extra': available, 'active_requests': active,
                'available_memory_mb': memory // 1024, 'load_one_minute': round(load, 2)}
    except (OSError, ValueError, StopIteration, IndexError, AttributeError):
        return {'accept_extra': False, 'active_requests': active}


def verify_ready():
    if os.getenv('STANDBY_READY', 'false').lower() != 'true':
        return False
    if not (config.RECAPTCHA_REQUIRED and config.RECAPTCHA_SECRET_KEY
            and config.REDIS_SECURITY_URL and os.getenv('AUTH_CREDENTIAL_PRIVATE_JWK')):
        return False
    from flask_app.auth.credentials import get_private_key
    get_private_key()
    for client in (security_client(), client_for(config.REDIS_URL)):
        key = 'mh:standby-probe:' + uuid4().hex
        with client.pipeline(transaction=False) as pipe:
            pipe.set(key, 'ready', ex=15)
            pipe.get(key)
            pipe.delete(key)
            result = pipe.execute()
        if not result[0] or result[1] not in ('ready', b'ready') or result[2] != 1:
            return False
    return True


class OriginStatusMiddleware:
    def __init__(self, app):
        self.app = app
        self.active = 0
        self.ready_at = 0
        self.monitor = None
        # Policy/database reads may fill the application's default I/O pool.
        # Redis readiness must still run and stop assigning excess traffic.
        self.probe_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='standby-readiness')

    async def _monitor(self):
        while True:
            try:
                future = asyncio.get_running_loop().run_in_executor(self.probe_pool, verify_ready)
                valid = await asyncio.wait_for(future, timeout=4)
                self.ready_at = time.monotonic() if valid else 0
            except Exception:
                self.ready_at = 0
            await asyncio.sleep(10)

    async def _status(self, scope, send):
        headers = dict(scope.get('headers', []))
        secret = os.getenv('STANDBY_ORIGIN_SECRET', '').encode()
        authorized = bool(secret) and hmac.compare_digest(secret, headers.get(b'x-mangahub-origin-secret', b''))
        status, value = 404, {'detail': 'Not found'}
        if authorized:
            if scope['method'] not in {'GET', 'HEAD'}:
                status, value = 405, {'detail': 'Method not allowed'}
            else:
                ready = self.ready_at > 0 and time.monotonic() - self.ready_at < 20
                status = 200 if ready else 503
                value = {'status': 'ready' if ready else 'unavailable', **capacity(self.active)}
                if scope.get('query_string') == b'check_frontend=1':
                    value['primary_frontend_ok'] = await asyncio.to_thread(frontend_healthy)
        body = json.dumps(value).encode()
        await send({'type': 'http.response.start', 'status': status, 'headers': [
            (b'content-type', b'application/json'), (b'cache-control', b'private, no-store'),
            (b'content-length', str(len(body)).encode())]})
        await send({'type': 'http.response.body', 'body': b'' if scope['method'] == 'HEAD' else body})

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'lifespan':
            async def lifecycle(message):
                if message['type'] == 'lifespan.startup.complete':
                    self.monitor = asyncio.create_task(self._monitor())
                elif message['type'].startswith('lifespan.shutdown') and self.monitor:
                    self.monitor.cancel()
                    await asyncio.gather(self.monitor, return_exceptions=True)
                    self.probe_pool.shutdown(wait=False, cancel_futures=True)
                await send(message)
            return await self.app(scope, receive, lifecycle)
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        if scope.get('path') == '/internal/origin-status':
            return await self._status(scope, send)
        counted = scope.get('path') not in {'/health', '/auth/health', '/api/manga/updates/stream'}
        if counted:
            self.active += 1
        try:
            return await self.app(scope, receive, send)
        finally:
            if counted:
                self.active -= 1


def build_app():
    from app import app as combined_app
    return OriginStatusMiddleware(combined_app)


app = build_app()
