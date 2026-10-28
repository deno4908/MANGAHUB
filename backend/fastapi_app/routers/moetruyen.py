"""MangaHub source routes, protected by the existing site access middleware."""
from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi_app.dependencies import get_optional_user, get_supabase_public
from fastapi_app.services import moetruyen_service as moe

router = APIRouter()


@router.get("/moetruyen-filtered")
async def listing(page: int = Query(1, ge=1, le=100000), limit: int = Query(24, ge=1, le=100),
                  sort: str = Query("latest", pattern="^(latest|popular|favorites|alphabetical)$"),
                  status: str = Query("", pattern="^(|ongoing|completed|hiatus)$"),
                  genre_slugs: str = Query("", max_length=1000), keyword: str = Query("", max_length=200),
                  show_mature: bool = Query(False), attach_ratings: bool = Query(False),
                  db=Depends(get_supabase_public), user=Depends(get_optional_user)):
    from fastapi_app.routers.manga import _get_hidden_slugs, _filter_hidden, _attach_overrides_to_otruyen_payload, _async_attach_ratings_to_items
    from copy import deepcopy
    hidden = await _get_hidden_slugs(db)
    genres = tuple(dict.fromkeys(g.strip() for g in genre_slugs.split(",") if g.strip()))
    if sort == "popular" and not keyword:
        from fastapi_app.services.local_popular import qq_popular
        payload = await qq_popular(page=page, limit=limit, genres=genres, status=status,
            show_mature=show_mature, hidden=hidden, db=db, source_name="moetruyen")
    else:
        payload = deepcopy(await moe.get_filtered(page, limit, sort, status, genres, keyword, show_mature))
    payload["data"]["items"] = _filter_hidden(payload["data"]["items"], hidden)
    await _attach_overrides_to_otruyen_payload(payload, db, attach_views=sort != "popular" or bool(keyword))
    if attach_ratings:
        await _async_attach_ratings_to_items(payload, db, user)
    return payload


@router.get("/moetruyen/categories")
async def categories():
    return {"data": {"items": await moe.get_categories()}}


@router.get("/moetruyen/cover/{identifier}")
async def cover(identifier: str, request: Request):
    from fastapi_app.routers.truyenqq import _serve_image
    async def load():
        return await moe.get_cover(identifier)
    return await _serve_image("moetruyen:cover:" + identifier, request, load, ttl=86400)


@router.get("/moetruyen/image/{identifier}/{number}/{index}")
async def image(identifier: str, number: str, index: int = Path(ge=0, le=10000)):
    content, mime = await moe.get_image(identifier, number, index)
    return Response(content, media_type=mime, headers={"Cache-Control": "private, max-age=300",
        "Vercel-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
