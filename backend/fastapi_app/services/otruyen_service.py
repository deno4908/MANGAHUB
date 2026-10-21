"""Legacy import compatibility. Catalog data now comes exclusively from TruyenQQ."""
from fastapi_app.services.truyenqq_service import (
    get_home, get_list, get_categories, get_category_manga, resolve_slug_from_id,
    get_manga_detail, search_manga, get_chapter, get_image_url,
    refresh_random_pool, get_random_item,
)
