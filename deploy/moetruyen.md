# Mòe Truyện on MangaHub

MangaHub uses the bundled `backend/moetruyen_api` for catalogues and the updated
`ReaderImages` API for IMGX pages. No source cookie, renderer API key or browser
grant is returned to the frontend. Existing QQ and MangaDex Workers are unchanged.

## Application routes

- Browse: `/manga?source=moetruyen` (sort, status, genre and page are URL state).
- Home: the three source requests run concurrently and are published in one
  snapshot after they settle. Failed sources do not remove successful sources.
- Detail: `/manga/moe-1048` — stable source ID, separate from QQ/MangaDex saves.
- Reader: `/chapter/moe--1048--9.5` — fractional and oneshot chapters are retained.
- Existing bookmarks, follows, history, comments and ratings use the `moe-` key.
- Moe's “Phổ biến” promotes local viewed titles, then preserves source popularity
  without repeating or dropping displaced titles. “Được lưu nhiều” follows source bookmarks.
  Website view counters and ratings remain local MangaHub statistics.

The source listing omits chapter timestamps; visible cards use the existing
latest-chapter batch endpoint to recover the source's real timestamp. Fetch time
is not presented as chapter publication time.

## Local API or a backend with Chromium

From `backend`, using the same Python environment as the API:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-moe-reader.txt
```

On Windows the source module defaults to installed Microsoft Edge. Alternatively,
set `MOE_IMGX_BROWSER_CHANNEL=chromium` and install the managed browser:

```powershell
.\venv\Scripts\python.exe -m playwright install chromium
```

On Linux install browser system dependencies too:

```sh
python -m playwright install --with-deps chromium
```

The normal MangaHub API starts the renderer lazily on image requests, not during
homepage/catalogue browsing. Keep one application worker so browser and RAM image
cache can be reused. Cached captures are private and bounded by
`MOE_IMGX_CACHE_BYTES` (default 64 MiB).

## Vercel API with a separate renderer

The Vercel dependency bundle deliberately does not include Playwright/Chromium.
Configure an external renderer for IMGX images when the main API runs on Vercel.
The browser still requests MangaHub's protected image endpoint; the backend calls
the renderer with a server-side key.

For a Render Docker web service:

1. Connect this repository and the deployment branch.
2. Set Root Directory to `backend`.
3. Select Docker, Dockerfile Path `./Dockerfile.moe-reader`, build context `.`.
4. Set a random `MOE_API_KEY` of at least 32 characters. Do not copy website auth
   or Supabase keys into this renderer. They are not required.
5. Set Health Check Path to `/health`.
6. After deployment, use the HTTPS service origin below.

On the **MangaHub backend** (Vercel or another host), set:

```dotenv
MOE_READER_API_URL=https://YOUR-MOE-RENDERER.onrender.com
MOE_READER_API_KEY=THE_SAME_RANDOM_SECRET_AS_MOE_API_KEY
```

These are backend variables, without a `VITE_` prefix. Use the origin only,
without `/api/v1` or a trailing endpoint path. Redeploy the backend after setting
them, and deploy the frontend changes too.

The renderer needs enough memory to run Chromium in addition to Python; a sleeping
host also adds a cold-start delay. No claim of instant image loading is made for
sleeping/free instances. The public `/health` checks the service process; it does
not launch Chromium or fetch a source chapter.

## Verification

- `/api/manga/moetruyen-filtered?page=1&limit=24&sort=latest` returns real source
  pagination, without crawling all earlier pages for a random page jump.
- `/api/manga/detail/moe-1048` returns the complete chapter list or an error,
  never a silently truncated chapter list.
- `/api/manga/chapter/moe--1048--9.5` rebases protected image URLs onto MangaHub.
- `/api/manga/moetruyen/image/moe-1048/9.5/0` returns the rendered JPEG at index 0.
- All MangaHub routes remain behind the existing whitelist/maintenance middleware.
- Source/API errors retain the existing sanitized public error responses.

No database migration is required. Existing QQ/MangaDex records are not rewritten.
