import json
import re
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup


COMIC = re.compile(r"/truyen-tranh/([^/?#]+?)-(\d+)(?:-chap-([^/?#]+))?/?$")


def identity(url: str) -> tuple[str, str, str | None]:
    match = COMIC.search(urlsplit(url).path)
    if not match:
        raise ValueError(f"Invalid comic/chapter URL: {url}")
    return match[1], match[2], match[3]


def text(node) -> str:
    return node.get_text(" ", strip=True) if node else ""


def integer(value: str) -> int:
    return int(re.sub(r"\D", "", value) or "0")


def optional_integer(value: str | None) -> int | None:
    return integer(value) if value and re.search(r"\d", value) else None


def thumbnail_fields(urls):
    return {"thumbnail_url": urls[0] if urls else None, "thumbnail_fallback_urls": urls[1:]}


def chapter_reference(a, base):
    if a is None:
        return None
    url = urljoin(base, a["href"])
    try:
        _, cid, number = identity(url)
    except ValueError:
        return None
    try:
        if identity(base)[1] != cid:
            return None
    except ValueError:
        pass
    if number is None:
        return None
    return {"number": number, "title": text(a), "url": url}


def image_urls(node, base: str) -> list[str]:
    if node is None:
        return []
    urls = []
    for attr in ("data-original", "data-src", "data-lazy-src", "src", "data-cdn", "data-fb"):
        value = node.get(attr, "").strip()
        if value and not value.startswith(("data:", "javascript:")):
            url = urljoin(base, value)
            if urlsplit(url).scheme in ("http", "https") and url not in urls:
                urls.append(url)
    return urls


def context(soup) -> dict:
    result = {name: (soup.select_one(f"#{name}").get("value", "0") if soup.select_one(f"#{name}") else "0")
              for name in ("book_id", "episode_id", "team_id", "total_page")}
    pages = [int(n) for node in soup.select('[onclick*="loadComment("]')
             for n in re.findall(r"loadComment\((\d+)\)", node.get("onclick", ""))]
    result["total_page"] = max(1, integer(result["total_page"]), *pages)
    return result


def parse_comments(html: str | BeautifulSoup, base: str) -> list[dict]:
    soup = html if isinstance(html, BeautifulSoup) else BeautifulSoup(html, "lxml")
    comments = []
    for node in soup.select("article.info-comment"):
        classes = " ".join(node.get("class", []))
        cid, parent = re.search(r"\bchild_(\d+)", classes), re.search(r"\bparent_(\d+)", classes)
        if not cid:
            continue
        body = node.select_one(".content-comment")
        comments.append({
            "id": cid[1], "parent_id": parent[1] if parent else "0",
            "author": text(node.select_one("strong.level")),
            "level": text(node.select_one(".title-user-comment")),
            "content": text(body), "content_html": str(body) if body else "",
            "likes": integer(text(node.select_one(".total-like-comment"))),
            "time": text(node.select_one(".action-comment .time")),
            "avatar_urls": image_urls(node.select_one(".avartar-comment img"), base),
            "image_urls": [u for img in (body.select("img") if body else []) for u in image_urls(img, base)[:1]],
            "has_replies": node.select_one('[href*="loadReply("]') is not None,
        })
    return comments


def validate_book(soup, expected_id):
    node = soup.find("input", id="book_id")
    actual = str(node.get("value", "")).strip() if node else ""
    if actual not in ("", "0", expected_id):
        raise ValueError("Source comic ID does not match the requested comic")


def parse_comic(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    slug, cid, _ = identity(url)
    validate_book(soup, cid)
    title = text(soup.select_one(".book_info h1, .book_other h1"))
    if not title:
        raise ValueError("Missing comic title; source may be blocked or layout changed")
    metadata = {}
    for row in soup.select(".list-info li"):
        label = row.select_one(".name")
        values = row.find_all("p", recursive=False)
        if label and len(values) >= 2:
            metadata[text(label)] = text(values[-1])
    chapters = {}
    for a in soup.select('.works-chapter-list a[href], .list_chapter a[href]'):
        target = urljoin(url, a["href"])
        try:
            _, book, number = identity(target)
        except ValueError:
            continue
        if book == cid and number is not None:
            row = a.find_parent(class_="works-chapter-item")
            chapters[number] = {"number": number, "url": target, "title": text(a),
                                "updated_at": text(row.select_one(".time-chap")) if row else ""}
    description = soup.select_one(".story-detail-info, .detail-content")
    structured = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            structured.append(json.loads(script.string or script.get_text()))
        except (ValueError, TypeError):
            pass
    genres = [{"name": text(a), "url": urljoin(url, a["href"])}
              for a in soup.select('.book_other a[href*="/the-loai/"]')]
    authors = [{"name": text(a), "url": urljoin(url, a["href"])}
               for a in soup.select('.author a[href]')]
    related = []
    for a in soup.select('a[href*="/truyen-tranh/"]'):
        target = urljoin(url, a["href"])
        try:
            _, other, chapter = identity(target)
            if other != cid and chapter is None and target not in related:
                related.append(target)
        except ValueError:
            pass
    meta = {x.get("property", x.get("name", x.get("itemprop", ""))): x.get("content", "")
            for x in soup.select("meta[content]")}
    return {"id": cid, "slug": slug, "url": url, "title": title,
            "alternative_names": metadata.get("Tên khác", ""),
            "status": metadata.get("Tình trạng", ""), "metadata": metadata,
            "authors": authors, "genres": genres,
            "description": text(description), "description_html": str(description) if description else "",
            "cover_urls": list(dict.fromkeys(image_urls(soup.select_one(".book_avatar img"), url) +
                              ([meta["og:image"]] if meta.get("og:image") else []))),
            "meta": meta, "structured_data": structured, "related_urls": related,
            "chapters": list(chapters.values()), "context": context(soup),
            "comments": parse_comments(soup, url)}


def basic_from_comic(value):
    """Project a previously cached full detail without retaining chapter/comment payloads."""
    covers = value["cover_urls"]
    metadata = value["metadata"]
    description = BeautifulSoup(value["description_html"], "lxml")
    paragraph = description.select_one("p")
    latest = value["chapters"][0] if value["chapters"] else None
    return {"id": value["id"], "slug": value["slug"], "url": value["url"], "title": value["title"],
            "cover_urls": covers, **thumbnail_fields(covers), "latest_chapter": latest,
            "alternative_names": value["alternative_names"] or None,
            "description": (text(paragraph) or value["description"])[:300] or None,
            "status": value["status"] or None, "genres": [g["name"] for g in value["genres"]],
            "views": optional_integer(metadata.get("Lượt xem")), "followers": optional_integer(metadata.get("Lượt theo dõi")),
            "updated_at": latest.get("updated_at") if latest else None, "labels": []}


def parse_basic(html: str, url: str) -> dict:
    """Read card fields only; skip parsing chapter lists, comments and structured data."""
    soup = BeautifulSoup(html, "lxml")
    slug, cid, _ = identity(url)
    validate_book(soup, cid)
    title = text(soup.select_one(".book_info h1, .book_other h1"))
    if not title:
        raise ValueError("Missing comic title; source may be blocked or layout changed")
    metadata = {}
    for row in soup.select(".list-info li"):
        values = row.find_all("p", recursive=False)
        if row.select_one(".name") and len(values) >= 2:
            metadata[text(row.select_one(".name"))] = text(values[-1])
    covers = image_urls(soup.select_one(".book_avatar img"), url)
    if not covers:
        image = soup.select_one('meta[property="og:image"]')
        if image and image.get("content"):
            covers = [urljoin(url, image["content"])]
    latest_node = soup.select_one('.works-chapter-list a[href], .list_chapter a[href]')
    latest = chapter_reference(latest_node, url)
    row = latest_node.find_parent(class_="works-chapter-item") if latest_node else None
    description = soup.select_one(".story-detail-info, .detail-content")
    paragraph = description.select_one("p") if description else None
    return {"id": cid, "slug": slug, "url": url, "title": title,
            "cover_urls": covers, **thumbnail_fields(covers), "latest_chapter": latest,
            "alternative_names": metadata.get("Tên khác") or None,
            "description": text(paragraph or description)[:300] or None, "status": metadata.get("Tình trạng") or None,
            "genres": [text(a) for a in soup.select('.book_other a[href*="/the-loai/"]')],
            "views": optional_integer(metadata.get("Lượt xem")), "followers": optional_integer(metadata.get("Lượt theo dõi")),
            "updated_at": text(row.select_one(".time-chap")) if row else None, "labels": []}


def parse_chapter(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    slug, cid, number = identity(url)
    validate_book(soup, cid)
    images = []
    for img in soup.select(".chapter_content img"):
        # Ignore advertisement images outside the reader's numbered pages.
        if not (img.has_attr("data-original") or img.has_attr("data-cdn") or img.find_parent(id=re.compile(r"^page_\d+$"))):
            continue
        urls = image_urls(img, url)
        if urls:
            images.append({"index": len(images) + 1, "url": urls[0], "fallback_urls": urls[1:], "alt": img.get("alt", "")})
    if not images:
        raise ValueError("No reader images found; source may require JavaScript or layout changed")
    def nav(selector):
        a = soup.select_one(selector)
        reference = chapter_reference(a, url)
        return reference["url"] if reference else None
    return {"comic_id": cid, "slug": slug, "number": number, "url": url,
            "title": text(soup.select_one("h1")) or text(soup.title),
            "previous_url": nav('.chapter_control a.prev[href*="-chap-"]'),
            "next_url": nav('a.link-next-chap[href], .chapter_control a.next[href*="-chap-"]'),
            "images": images, "context": context(soup), "comments": parse_comments(soup, url)}


def listing_items(grid, url: str) -> list[dict]:
    items = {}
    for card in grid.select("li"):
        classes = {}
        for node in card.find_all(class_=True):
            for cls in node.get("class", []):
                classes.setdefault(cls, []).append(node)
        def first(cls):
            nodes = classes.get(cls)
            return nodes[0] if nodes else None
        name = first("book_name")
        a = name.find("a", href=True) if name else None
        if not a:
            continue
        target = urljoin(url, a["href"])
        try:
            slug, cid, chapter = identity(target)
        except ValueError:
            continue
        if chapter is not None:
            continue
        chapter = first("last_chapter")
        latest = chapter.find("a", href=True) if chapter else None
        avatar = first("book_avatar")
        covers = image_urls(avatar.find("img") if avatar else None, url)
        info = {}
        more = first("more-info")
        for node in (more.find_all("p", class_="info") if more else []):
            label, separator, value = text(node).partition(":")
            if separator:
                info[label.strip()] = value.strip()
        def counter(icon):
            node = first(icon)
            return optional_integer(text(node.parent)) if node else None
        other = text(first("title-more-other"))
        tags = first("list-tags")
        items[cid] = {"id": cid, "slug": slug, "url": target, "title": text(a),
                      "cover_urls": covers, **thumbnail_fields(covers), "latest_chapter": chapter_reference(latest, url),
                      "updated_at": text(first("time-ago")) or None,
                      "alternative_names": other.removeprefix("Tên khác:").strip() or None,
                      "description": text(first("excerpt"))[:300] or None,
                      "status": info.get("Tình trạng"), "genres": [text(t) for t in tags.find_all(class_="blue")] if tags else [],
                      "views": optional_integer(info.get("Lượt xem")) if "Lượt xem" in info else counter("fa-eye"),
                      "followers": optional_integer(info.get("Lượt theo dõi")) if "Lượt theo dõi" in info else counter("fa-bookmark"),
                      "labels": [text(label) for label in classes.get("type-label", [])]}
    return list(items.values())


def parse_listing(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    grid = soup.select_one(".list_grid")
    if grid is None:
        raise ValueError("Missing comic listing; source may be blocked or layout changed")
    pagination = soup.select_one(".page_redirect") or soup
    pages = [int(n) for a in pagination.select("a[href]")
             for n in re.findall(r"/(?:trang|page)-(\d+)", a["href"])]
    active = text(pagination.select_one("p.active"))
    if active.isdigit():
        pages.append(int(active))
    description = soup.select_one('meta[name="description"]')
    return {"items": listing_items(grid, url), "total_pages": max(pages, default=1), "source_url": url,
            "title": text(soup.select_one("h1")), "description": description.get("content", "") if description else ""}


def parse_search(html: str, url: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    if soup.select_one(".no_result"):
        return []
    items = {}
    for a in soup.select('li a[href*="/truyen-tranh/"]'):
        info = a.select_one(".search_info")
        if info is None:
            continue
        target = urljoin(url, a["href"])
        slug, cid, number = identity(target)
        if number is not None:
            continue
        paragraphs = info.select("p")
        items[cid] = {"id": cid, "slug": slug, "url": target,
                      "title": text(info.select_one(".name")),
                      "alternative_names": text(info.select_one(".name_other")),
                      "cover_urls": image_urls(a.select_one(".search_avatar img"), url),
                      **thumbnail_fields(image_urls(a.select_one(".search_avatar img"), url)),
                      "latest_chapter": {"title": text(paragraphs[-1])} if len(paragraphs) > 2 else None}
    if not items:
        raise ValueError("Unexpected search response; source may be blocked or layout changed")
    return list(items.values())


def parse_home(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    sections = []
    for grid in soup.select(".list_grid"):
        heading = grid.find_previous(["h1", "h2", "h3"])
        name = text(heading)
        key = "exclusive" if "Độc Quyền" in name else "latest" if "Danh Sách" in name else "featured"
        sections.append({"key": key, "title": name, "items": listing_items(grid, url)})
    if not sections:
        raise ValueError("Source returned no home sections")
    return {"sections": sections, "source_url": url}
