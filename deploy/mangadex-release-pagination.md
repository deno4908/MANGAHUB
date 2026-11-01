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

Latest browsing with genre/status/title filters also uses the Vietnamese index.
Other sort orders retain their existing native search or local ranking rules.

Homepage image failures remain local to their cards. The previous valid source
snapshot is retained during a transient refresh failure.

Official API schema:
https://api.mangadex.org/docs/static/api.yaml
