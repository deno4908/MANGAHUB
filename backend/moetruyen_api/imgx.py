"""Serve PNG captures of pages rendered by the source's normal IMGX reader.

Playwright and all browser objects belong to one worker thread. The official
reader obtains its own grants and renders normally; no key extraction or
canvas readback is used. Captures are taken from the browser compositor.
"""
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError as FutureTimeout
from copy import deepcopy
from dataclasses import dataclass, field
from hashlib import sha256
from queue import PriorityQueue
from itertools import count
import struct
import threading
import time
from urllib.parse import quote, urlsplit

from .source import SourceFailure
from .parsers import parse_reader


def identity(url, cookie):
    return url, sha256(cookie.encode()).hexdigest()


@dataclass
class Frame:
    content: bytes = field(repr=False)
    width: int
    height: int
    mime: str = "image/png"


@dataclass
class Task:
    key: tuple
    url: str
    cookie: str = field(repr=False)
    index: int
    future: Future = field(repr=False)
    image_format: str = "png"
    priority: int = 0


@dataclass
class ReaderPage:
    context: object = field(repr=False)
    page: object = field(repr=False)
    used_at: float
    html: str = field(repr=False)
    url: str


class BrowserRenderer:
    def __init__(self, settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.queue = PriorityQueue()
        self.sequence = count()
        self.pending = {}
        self.read_ahead = OrderedDict()
        self.frames = OrderedDict()
        self.cache_bytes = 0
        self.thread = None
        self.closed = False

    def _submit(self, url, cookie, index, *, browser_cookie=None, image_format="png", priority=0):
        key = (*identity(url, cookie), index, image_format)
        with self.lock:
            if self.closed:
                raise SourceFailure("Trình đọc IMGX đã dừng.", 503)
            cached = self.frames.get(key)
            if cached and cached[0] > time.monotonic():
                self.frames.move_to_end(key)
                future = Future()
                future.set_result(cached[1])
                return future
            if cached:
                self.cache_bytes -= len(self.frames.pop(key)[1].content)
            task = self.pending.get(key)
            if task is not None and task.future.done():
                self.pending.pop(key, None)
                task = None
            if task is None:
                future = Future()
                task = Task(key, url, cookie if browser_cookie is None else browser_cookie, index, future, image_format, priority)
                self.pending[key] = task
                self.queue.put((priority, next(self.sequence), task))
            elif priority < task.priority and not task.future.running() and not task.future.done():
                task.priority = priority
                self.queue.put((priority, next(self.sequence), task))
            if self.thread is None:
                self.thread = threading.Thread(target=self._worker, name="imgx-reader", daemon=True)
                self.thread.start()
            return task.future

    def render(self, url, cookie, index, *, browser_cookie=None, image_format="png", priority=0):
        future = self._submit(url, cookie, index, browser_cookie=browser_cookie, image_format=image_format, priority=priority)
        try:
            return future.result(timeout=self.settings.imgx_timeout + 15)
        except FutureTimeout:
            future.cancel()
            raise SourceFailure("Chờ ảnh IMGX quá lâu; thử lại trang ảnh này.", 504) from None

    def prefetch(self, url, cookie, index, *, browser_cookie=None, image_format="jpeg"):
        return self._submit(url, cookie, index, browser_cookie=browser_cookie, image_format=image_format, priority=10)

    def prepare_chapter(self, url, cookie, indices, *, browser_cookie=None):
        """Fill the bounded RAM cache while the reader is idle, one page at a time."""
        scope = identity(url, cookie)[1]
        plan = (url, iter(indices))
        with self.lock:
            self.read_ahead[scope] = plan
            self.read_ahead.move_to_end(scope)
            while len(self.read_ahead) > self.settings.imgx_contexts:
                self.read_ahead.popitem(last=False)

        def advance(completed=None):
            if completed is not None and (completed.cancelled() or completed.exception()):
                return
            while True:
                with self.lock:
                    if self.closed or self.read_ahead.get(scope) is not plan:
                        return
                    index = next(plan[1], None)
                    if index is None:
                        self.read_ahead.pop(scope, None)
                        return
                try:
                    future = self._submit(url, cookie, index, browser_cookie=browser_cookie, image_format="jpeg", priority=20)
                except SourceFailure:
                    return  # Shutdown can race with an in-flight capture's callback.
                if not future.done():
                    future.add_done_callback(advance)
                    return
                if future.cancelled() or future.exception():
                    return

        advance()

    def describe(self, url, cookie):
        future = self._submit(url, cookie, -2)
        try:
            return future.result(timeout=self.settings.imgx_timeout + 15)
        except FutureTimeout:
            future.cancel()
            raise SourceFailure("Chờ trang IMGX quá lâu; thử lại sau.", 504) from None

    def warm_start(self):
        self._submit("", "", -1, priority=-10)

    def _forget(self, task):
        with self.lock:
            if self.pending.get(task.key) is task:
                self.pending.pop(task.key, None)

    def _remember(self, key, frame):
        budget = self.settings.imgx_cache_bytes
        if len(frame.content) > budget or not self.settings.imgx_cache_ttl:
            return
        with self.lock:
            if self.closed:
                return
            old = self.frames.pop(key, None)
            if old:
                self.cache_bytes -= len(old[1].content)
            self.frames[key] = (time.monotonic() + self.settings.imgx_cache_ttl, frame)
            self.cache_bytes += len(frame.content)
            while self.cache_bytes > budget:
                _, (_, removed) = self.frames.popitem(last=False)
                self.cache_bytes -= len(removed.content)

    def _worker(self):
        playwright = browser = None
        pages = OrderedDict()
        try:
            while True:
                _, _, task = self.queue.get()
                if task is None:
                    break
                if task.future.done():
                    self._forget(task)
                    continue  # An upgraded prefetch may leave its old queue entry behind.
                if not task.future.set_running_or_notify_cancel():
                    self._forget(task)
                    continue
                try:
                    if browser is None or not browser.is_connected():
                        try:
                            from playwright.sync_api import sync_playwright
                            if playwright is None:
                                playwright = sync_playwright().start()
                            channel = self.settings.imgx_browser_channel
                            browser = playwright.chromium.launch(headless=True, channel=None if channel == "chromium" else channel)
                        except Exception:
                            raise SourceFailure("Không khởi động được trình duyệt IMGX. Cài Playwright và Microsoft Edge, hoặc chọn chromium rồi chạy python -m playwright install chromium.", 503) from None
                    if task.index == -1:
                        task.future.set_result(None)
                        continue
                    if task.index == -2:
                        entry = self._open_page(browser, pages, task)
                        task.future.set_result(parse_reader(entry.html, entry.url))
                        continue
                    frame = self._capture(browser, pages, task)
                    self._remember(task.key, frame)
                    task.future.set_result(frame)
                except SourceFailure as error:
                    self._drop_page(pages, task.key[:2])
                    task.future.set_exception(error)
                except Exception as error:
                    self._drop_page(pages, task.key[:2])
                    status = 504 if error.__class__.__name__ == "TimeoutError" else 502
                    task.future.set_exception(SourceFailure("Không render được ảnh IMGX trong phiên nguồn hiện tại; thử lại hoặc kiểm tra cookie/quyền đọc chương.", status))
                finally:
                    self._forget(task)
        finally:
            for key in list(pages):
                self._drop_page(pages, key)
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            if playwright:
                try:
                    playwright.stop()
                except Exception:
                    pass

    @staticmethod
    def _drop_page(pages, key):
        entry = pages.pop(key, None)
        if entry:
            try:
                if any(other.context is entry.context for other in pages.values()):
                    entry.page.close()
                else:
                    entry.context.close()
            except Exception:
                pass

    def _open_page(self, browser, pages, task):
        key = task.key[:2]
        now = time.monotonic()
        for old_key, old_entry in list(pages.items()):
            if now - old_entry.used_at > max(60, self.settings.imgx_cache_ttl):
                self._drop_page(pages, old_key)
        entry = pages.get(key)
        if entry is None or entry.page.is_closed():
            self._drop_page(pages, key)
            # A normal reader keeps its script/CDN cache and connections when
            # switching chapters; preserve these within the same cookie identity.
            context = next((other.context for old_key, other in pages.items() if old_key[1] == key[1]), None)
            fresh_context = context is None
            if fresh_context:
                context = browser.new_context(viewport={"width": 1440, "height": 2048}, device_scale_factor=1, locale="vi-VN")
            cookies = []
            for part in task.cookie.split("; ") if task.cookie else []:
                name, _, value = part.partition("=")
                cookies.append({"name": name, "value": value, "url": self.settings.base_url})
            if cookies and fresh_context:
                context.add_cookies(cookies)
            page = context.new_page()
            entry = pages[key] = ReaderPage(context, page, now, "", task.url)
            while len(pages) > self.settings.imgx_contexts:
                self._drop_page(pages, next(iter(pages)))
            response = page.goto(task.url, wait_until="domcontentloaded", timeout=self.settings.imgx_timeout * 1000)
            if response is None or response.status >= 400:
                status = response.status if response else 502
                raise SourceFailure("Nguồn không cho mở chương trong trình đọc IMGX.", status if status in (401, 403, 404) else 502)
            if urlsplit(page.url).netloc != urlsplit(task.url).netloc or not page.locator("main[data-reading-chapter-id]").count():
                raise SourceFailure("Phiên nguồn chưa có quyền mở chương này.", 403)
            entry.html = response.text()
            entry.url = page.url
            # Hide floating navigation so it cannot cover a tall page during capture.
            page.add_style_tag(content=".site-header,.reader-mobile-top,.reader-float,.reader-dock,[data-reader-fixed]{visibility:hidden!important}")
        entry.used_at = now
        pages.move_to_end(key)
        return entry

    def _capture(self, browser, pages, task):
        entry = self._open_page(browser, pages, task)
        page = entry.page
        page.bring_to_front()
        selector = f'img.page-media[data-page-index="{task.index}"][data-imgx-page-index]'
        target = page.locator(selector).first
        target.wait_for(state="attached", timeout=self.settings.imgx_timeout * 1000)
        target.scroll_into_view_if_needed(timeout=10000)
        page.locator(selector + '[data-imgx-rendered="1"]').first.wait_for(state="attached", timeout=self.settings.imgx_timeout * 1000)
        shell = target.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' page-protected-shell ')][1]")
        box = shell.bounding_box()
        if not box or box["width"] < 16 or box["height"] < 16 or box["width"] * box["height"] > 32_000_000:
            raise SourceFailure("Kích thước trang IMGX không hợp lệ hoặc vượt giới hạn render.", 502)
        options = {"type": task.image_format, "animations": "disabled", "timeout": 15000}
        if task.image_format == "jpeg":
            options["quality"] = self.settings.imgx_jpeg_quality
        content = shell.screenshot(**options)
        width, height = dimensions(content, task.image_format)
        return Frame(content, width, height, "image/jpeg" if task.image_format == "jpeg" else "image/png")

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.read_ahead.clear()
            for task in self.pending.values():
                task.future.cancel()
            self.queue.put((-100, next(self.sequence), None))
            thread = self.thread
            self.frames.clear()
            self.cache_bytes = 0
        if thread:
            thread.join(timeout=self.settings.imgx_timeout + 20)
        with self.lock:
            self.pending.clear()


def dimensions(content, image_format):
    if image_format == "png" and content.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", content[16:24])
    if image_format == "jpeg" and content.startswith(b"\xff\xd8"):
        position = 2
        sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while position + 8 < len(content):
            if content[position] != 0xFF:
                break
            while content[position] == 0xFF:
                position += 1
            marker = content[position]
            position += 1
            length = int.from_bytes(content[position:position + 2], "big")
            if marker in sof:
                height, width = struct.unpack(">HH", content[position + 3:position + 7])
                return width, height
            if length < 2:
                break
            position += length
    raise SourceFailure("Trình đọc không tạo được ảnh hợp lệ.", 502)


class ReaderImages:
    def __init__(self, settings, renderer=None):
        self.settings = settings
        self.renderer = renderer or BrowserRenderer(settings)
        self.manifests = OrderedDict()
        self.lock = threading.Lock()

    def describe(self, source, slug, number, warm=False):
        requested_url = f"{source.base}/manga/{slug}/chapters/{number}"
        if warm:
            value = self.renderer.describe(requested_url, source.cookie)
            browser_cookie = source.cookie
            render_url = requested_url
        else:
            value = source.chapter(slug, number)
            browser_cookie = source.http.build_request("GET", value["source_url"]).headers.get("cookie", "")
            render_url = value["source_url"]
        if value["image_delivery"] != "imgx_protected":
            return value
        key = identity(requested_url, source.cookie)
        with self.lock:
            self.manifests[key] = (time.monotonic() + self.settings.imgx_cache_ttl, deepcopy(value), browser_cookie, render_url)
            self.manifests.move_to_end(key)
            while len(self.manifests) > 64:
                self.manifests.popitem(last=False)
        result = deepcopy(value)
        result["image_delivery"] = "imgx_browser"
        result["reader_images_available"] = True
        result["image_format"] = "jpeg"
        result["image_capture"] = "browser_rendered_page"
        for image in result["images"]:
            if image["protected"]:
                image["url"] = f"/api/v1/comics/{quote(slug, safe='')}/chapters/{quote(number, safe='')}/images/{image['index']}?format=jpeg"
                image["delivery"] = "browser_capture"
        if warm:
            for image in result["images"][:2]:
                if image["protected"]:
                    self.renderer.prefetch(render_url, source.cookie, image["index"], browser_cookie=browser_cookie, image_format="jpeg")
            if self.settings.imgx_prepare_chapter and self.settings.imgx_cache_bytes and self.settings.imgx_cache_ttl:
                self.renderer.prepare_chapter(render_url, source.cookie,
                    [image["index"] for image in result["images"] if image["protected"]], browser_cookie=browser_cookie)
        return result

    def image(self, source, slug, number, index, image_format="png", priority=0):
        url = f"{source.base}/manga/{slug}/chapters/{number}"
        key = identity(url, source.cookie)
        with self.lock:
            entry = self.manifests.get(key)
        if entry is None or entry[0] <= time.monotonic():
            self.describe(source, slug, number)
            with self.lock:
                entry = self.manifests.get(key)
        if entry is None:
            raise SourceFailure("Chương này dùng ảnh trực tiếp; lấy URL từ endpoint chương.", 404)
        value, browser_cookie, render_url = entry[1:]
        if index < 0 or index >= len(value["images"]):
            raise SourceFailure("Số trang vượt quá số ảnh của chương.", 404)
        if not value["images"][index]["protected"]:
            raise SourceFailure("Trang này có URL ảnh trực tiếp trong metadata chương.", 404)
        frame = self.renderer.render(render_url, source.cookie, index, browser_cookie=browser_cookie, image_format=image_format, priority=priority)
        for following in value["images"][index + 1:index + 1 + self.settings.imgx_prefetch_pages]:
            if following["protected"]:
                self.renderer.prefetch(render_url, source.cookie, following["index"], browser_cookie=browser_cookie, image_format=image_format)
        return frame

    def start(self):
        if self.settings.imgx_prestart:
            self.renderer.warm_start()

    def close(self):
        self.renderer.close()
        with self.lock:
            self.manifests.clear()
