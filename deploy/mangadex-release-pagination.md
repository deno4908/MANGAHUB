# Vietnamese release pagination

Latest Updates uses the chapter API with translatedLanguage[]=vi and tracks
the largest readableAt for each manga. Chapters in other languages and higher
chapter numbers cannot replace that release. Filtering and hidden IDs apply
before sorting/slicing; each full page contains 24 distinct titles. Only the
last page can be shorter when fewer than 24 matching titles remain.

The chapter API's 10,000-offset window cannot represent all unique Vietnamese
titles when a title has many chapters. A one-time seed indexes the full public
history using order[createdAt]=asc plus an inclusive createdAtSince cursor and
a within-timestamp offset. No request exceeds the source pagination window.
The bundled gzip seed contains public catalog metadata only, without uploader
profiles, descriptions, image bytes, cookies or application secrets.

Rebuild the seed from the repository root with:

    backend/venv/Scripts/python.exe backend/scripts/build_mangadex_release_index.py .

The bootstrap reads at a bounded rate and resumes from .codex-artifacts in the
parent workspace. The generated file is
backend/fastapi_app/services/mangadex_release_seed.json.gz.

After deployment, the seed serves initial pages immediately. The primary
Redis stores the shared active index, resumable work and immutable browsing
snapshots under mh:mangadex-release-index:v1:vi:. These survive ordinary content
cache purges. A separate TLS-validated Redis pool with a bounded three-second
socket timeout isolates large index I/O from the authentication pool/circuit.
No new environment variables are required.

Workers prepare title/tag/mature-content metadata once per catalog version,
then cache up to 64 exact filtered/sorted selections. Cache keys include the
catalog/statistics version and every filter, including the current hidden IDs.
Only the requested 24 rows are copied for callers. Processing runs off the ASGI
event loop, and the prepared-version cache is bounded to two versions.

Refresh work starts after the response body and uses a shared expiring lease.
Finite 20-second steps resume an updatedAtSince scan, selecting Vietnamese
readableAt when merging. A periodic full rebuild handles source deletions and
metadata changes; the previous completed index remains available until its
replacement is complete. Compare-and-set Lua guards prevent expired owners
from overwriting a newer worker. Snapshots last 30 minutes; later pages use the
same version, while page one can adopt fresh releases.

The existing shared live chapter probe also overlays newer Vietnamese releases
on fresh first pages, without another source crawl or a wait for a full scan.
Catalog revision events expire only the active in-process view; previously
issued browsing snapshots retain their page boundaries.

If a seed is absent and initialization is incomplete, the API returns 202 with
index_pending and the browser shows preparation with automatic retry instead
of pretending an incomplete chapter batch is a full title page. Authentication,
site-access policy and hidden-title checks remain active.

Vietnamese browsing uses /api/manga/mangadex/browse for all four sort orders.
The legacy /search endpoint delegates Vietnamese requests to the same catalog.
Title search, AND-combined genres, publication status/year, hidden IDs, mature
visibility and minimum internal rating apply before sorting and slicing. The
eligible total is independent of the chosen ordering. A-Z orders title names;
popular ranks local MangaHub views; rating ranks internal average/count, with
unrated eligible titles retained after rated titles. Latest uses readableAt.

Public aggregate views/ratings are loaded in paged DB reads, merging UUID and
mdx-UUID aliases and the latest score per user. Shared cache and concurrent-read
coalescing avoid repeating those reads for each page/tab. Old aggregates remain
usable during a temporary DB failure; missing statistics return a retryable
service error instead of silently applying a zero-score filter. Browsing
snapshots freeze aggregate rankings as well as release metadata for 30 minutes.
Ranking snapshots store a small statistics manifest referencing the immutable
base catalog, instead of duplicating its megabytes for every statistics change.
Base expiry is extended before publishing each manifest; old full snapshots
remain readable across deployment. Warm first pages reuse the same snapshot.
Cold workers skip re-uploading a base snapshot that Redis already contains.

Views and ratings read in parallel using a bounded two-thread pool. Metadata
and statistics load concurrently on cold workers. An expired successful
statistics value is served while one coalesced, Vercel-tracked task refreshes
it; a first read with no known statistics still waits for authoritative data.
Cover batches coalesce concurrent readers, and fully cached cover URLs require
no upstream call or cache writes. None of these caches covers authentication,
moderation decisions or image access policy.
The client keeps server membership/order, including unrated items, and sends
year/minimum score to the server instead of filtering a partial local catalog.

The eligible set requires a published, available Vietnamese release. The title
API's availableTranslatedLanguage flag alone can include manga whose Vietnamese
chapters are all unavailable; those no longer inflate popular/A-Z page counts.

Homepage image failures remain local to their cards. The previous valid source
snapshot is retained during a transient refresh failure.

Official API schema:
https://api.mangadex.org/docs/static/api.yaml
