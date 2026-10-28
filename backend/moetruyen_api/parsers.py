import re
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup


def soup(html):
    return BeautifulSoup(html, "lxml")


def text(node):
    return node.get_text(" ", strip=True) if node else None


def number(value):
    if not value:
        return None
    match = re.search(r"[\d][\d.,\s]*", str(value))
    return int(re.sub(r"\D", "", match[0])) if match else None


def media(value, base):
    if not value or value.startswith(("data:", "blob:")):
        return None, []
    parsed = urlsplit(urljoin(base, value))
    if parsed.scheme not in ("http", "https"):
        return None, []
    fallbacks = parse_qs(parsed.fragment).get("media-fallback", [])
    fallbacks = [u for u in fallbacks if urlsplit(u).scheme in ("http", "https")]
    return urlunsplit(parsed._replace(fragment="")), fallbacks


def identity(url):
    match = re.fullmatch(r"/manga/(\d+(?:-[^/]+)?)/?", urlsplit(url).path)
    if not match:
        raise ValueError("Source did not provide a valid manga URL")
    slug = match[1]
    return {"id": slug.split("-", 1)[0], "slug": slug, "url": url}


def metric(node, icon):
    found = node.select_one("." + icon)
    return number(text(found.parent)) if found else None


def parse_cards(html, base):
    doc = soup(html)
    cards = []
    for node in doc.select("article.manga-card"):
        link = node.select_one('a[href^="/manga/"]')
        heading = node.select_one("h3")
        if not link or not heading:
            raise ValueError("Source manga card has no title or link")
        image = node.select_one(".cover img")
        cover, fallbacks = media(image.get("data-src") or image.get("src"), base) if image else (None, [])
        chapter_label = text(node.select_one(".manga-chapter-label"))
        chapter_number = re.search(r"\d+(?:\.\d+)?", chapter_label or "")
        genres_more = text(node.select_one(".manga-hover-popup__genre-more"))
        teams = []
        for row in node.select(".manga-hover-popup__meta-row"):
            if text(row.select_one("dt")) == "Nhóm dịch":
                teams.append({"name": text(row.select_one("dd")), "url": None})
        description = text(node.select_one(".manga-hover-popup__description"))
        cards.append({**identity(urljoin(base, link["href"])),
                      "title": heading.get("title") or text(node.select_one(".manga-hover-popup__title")) or text(heading),
                      "thumbnail_url": cover, "cover_urls": [cover] if cover else [],
                      "thumbnail_fallback_urls": fallbacks,
                      "status": text(node.select_one(".manga-badge")),
                      "latest_chapter": {"label": chapter_label, "number": chapter_number[0] if chapter_number else None} if chapter_label else None,
                      "genres": [text(g) for g in node.select(".manga-hover-popup__genre")],
                      "genres_complete": not bool(genres_more), "additional_genres": number(genres_more) or 0,
                      "translation_teams": teams,
                      "description": description,
                      "description_complete": bool(description and not description.endswith(("...", "…"))),
                      "views": metric(node, "fa-eye"), "followers": metric(node, "fa-bookmark"),
                      "comments_count": metric(node, "fa-comments"),
                      "adult": node.select_one("[data-adult-cover-reveal-on-click]") is not None})
    return cards


def pagination(doc, page, key="page", selector=".admin-pagination"):
    navs = doc.select(selector)
    pages = [page]
    for nav in navs:
        for a in nav.select("a[href]"):
            value = parse_qs(urlsplit(a["href"]).query).get(key, [])
            if value and value[0].isdigit():
                pages.append(int(value[0]))
    last = max(pages)
    return {"page": page, "total_pages": last, "has_next": last > page, "has_previous": page > 1}


def parse_options(html):
    doc = soup(html)
    form = doc.select_one("form[data-manga-catalog-form]")
    if not form:
        raise ValueError("Source catalogue form not found; source may have changed")
    return {"sorts": [{"value": o["value"], "label": text(o)} for o in form.select('select[name="sort"] option[value]')],
            "statuses": [{"value": o["value"], "label": text(o)} for o in form.select('select[name="status"] option[value]')],
            "genres": [{"id": g["data-genre"], "name": text(g.select_one(".filter-name"))} for g in form.select("[data-genre]")],
            "include_modes": ["all", "any"]}


def parse_chapters(html, url, page=1):
    doc = soup(html)
    container = doc.select_one("[data-chapter-page-content]")
    if not container:
        raise ValueError("Source chapter list not found")
    chapters = []
    for a in container.select("a.chapter-link[href]"):
        time = a.select_one(".chapter-time")
        chapters.append({"id": a.get("data-chapter-id"), "number": a.get("data-chapter-number"),
                         "title": text(a.select_one(".chapter-title")), "label": text(a.select_one(".chapter-num")),
                         "url": urljoin(url, a["href"]), "team": text(a.select_one(".chapter-sub-text")),
                         "updated_at": text(time), "updated_date_label": time.get("title") if time else None,
                         "views": number(text(a.select_one(".chapter-views")))})
    return {"items": chapters, "count": len(chapters), "total": None,
            **pagination(container, page, "chapterPage"), "source_url": url}


def parse_detail(html, url, page=1):
    doc = soup(html)
    heading = doc.select_one("h1.manga-detail-title")
    if not heading:
        raise ValueError("Source manga detail not found; login or source changes may be required")
    canonical = doc.select_one('link[rel="canonical"]')
    manga_url = urljoin(url, canonical["href"]) if canonical else urlunsplit(urlsplit(url)._replace(query="", fragment=""))
    cover_node = doc.select_one(".detail-cover img")
    cover, fallbacks = media(cover_node.get("src"), url) if cover_node else (None, [])
    stats = doc.select_one(".manga-detail-stats")
    teams = doc.select(".manga-translation-team-card__name-anchor")
    chapter_page = parse_chapters(html, url, page)
    return {**identity(manga_url), "title": text(heading), "thumbnail_url": cover,
            "cover_urls": [cover] if cover else [], "thumbnail_fallback_urls": fallbacks,
            "authors": [text(a) for a in doc.select(".manga-detail-meta-line--author a")],
            "genres": [text(a) for a in doc.select(".manga-detail-genre-chips a")],
            "genres_complete": True, "status": text(doc.select_one(".manga-status-pill")),
            "description": text(doc.select_one("[data-description-content]")), "description_complete": True,
            "views": metric(stats, "fa-eye") if stats else None,
            "followers": metric(stats, "fa-bookmark") if stats else None,
            "comments_count": metric(stats, "fa-comments") if stats else None,
            "translation_teams": [{"name": text(a), "url": urljoin(url, a["href"])} for a in teams],
            "adult": doc.select_one("[data-adult-warning], [data-adult-cover-reveal-on-click]") is not None,
            "chapters": chapter_page["items"], "chapter_pagination": {k: v for k, v in chapter_page.items() if k not in ("items", "source_url")}}


def parse_reader(html, url):
    doc = soup(html)
    main = doc.select_one("main[data-reading-chapter-id]")
    pages = doc.select_one(".reader-pages[data-reader-total-pages]") or doc.select_one(".reader-pages")
    if not main or not pages:
        raise ValueError("Source reader unavailable; chapter may require login, password or purchase")
    images = []
    for i, img in enumerate(pages.select("img.page-media")):
        image_url, fallbacks = media(img.get("data-src") or img.get("src"), url)
        protected = img.has_attr("data-imgx-page-index")
        images.append({"index": i, "url": image_url, "fallback_urls": fallbacks,
                       "width": number(img.get("width")), "height": number(img.get("height")),
                       "protected": protected, "source_page_index": number(img.get("data-imgx-page-index")) if protected else None})
    if not images:
        raise ValueError("Source reader has no pages")
    def nav(label):
        a = doc.select_one(f'a[aria-label="{label}"][href]')
        return urljoin(url, a["href"]) if a else None
    return {"id": main.get("data-reading-chapter-id"), "number": main.get("data-reading-chapter-number"),
            "title": main.get("data-reading-chapter-title"), "comic_slug": main.get("data-reading-manga-slug"),
            "comic_title": main.get("data-reading-manga-title"), "source_url": url, "official_reader_url": url,
            "images": images, "count": len(images), "total_pages": number(pages.get("data-reader-total-pages")) or len(images),
            "direct_images_available": all(x["url"] is not None and not x["protected"] for x in images),
            "image_delivery": "imgx_protected" if any(x["protected"] for x in images) else "direct",
            "previous_url": nav("Chương trước"), "next_url": nav("Chương sau")}
