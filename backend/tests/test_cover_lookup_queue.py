import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi_app.services import mangadex_service as mdx


def test_a_cached_saved_cover_is_not_queued_behind_catalog_database_work(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    workers = []
    cover = 'https://uploads.mangadex.org/covers/test/cover.jpg.256.jpg'

    def cached(identifier):
        workers.append(threading.current_thread().name)
        return cover

    monkeypatch.setattr(mdx, '_cached_cover_url', cached)

    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        def busy_catalog():
            entered.set()
            release.wait(3)
        busy = loop.run_in_executor(None, busy_catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            result = await asyncio.wait_for(mdx.get_cover_url('cached-cover'), .5)
            assert result == cover and not busy.done()
        finally:
            release.set()
            await busy

    asyncio.run(run())
    assert workers and all(name.startswith('cover-lookup') for name in workers)
