from fastapi_app.routers.bookmarks import _thumb_from_slug
from fastapi_app.routers.manga import _decode_otruyen_route_id


def test_saved_library_covers_use_the_real_source_for_prefixed_ids():
    mdx = "5272da37-6c69-4ecc-a1e0-d25db7b3e80f"
    for identifier in (mdx, "mdx-" + mdx, "mangadex-" + mdx, "mangadex:" + mdx):
        assert _thumb_from_slug(identifier) == "/api/manga/mangadex-cover/" + mdx
    encoded = "07e0aa65-b123-5456-8789-0abcdef12345"
    assert _decode_otruyen_route_id(encoded)
    assert _thumb_from_slug(encoded) == "/api/manga/truyenqq/cover/" + encoded
    assert _thumb_from_slug("old-book") == "/api/manga/truyenqq/cover/old-book"


def test_stored_cover_is_not_rewritten_in_the_library_database_response():
    assert _thumb_from_slug("old-book", "stored.jpg") == "stored.jpg"
