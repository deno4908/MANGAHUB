# MangaDex release pagination

`/api/manga/mangadex/latest-feed` orders chapter releases by `readableAt DESC`.
Genre IDs (AND), status, title, language, content rating and hidden IDs are applied
before deduplicating manga IDs and slicing title pages. A backfilled chapter can
be the newest release even when its chapter number is lower. Its release date
and ID stay attached to the card; highest-chapter hydration cannot replace it.

The browser sends `genre_slugs`, `status`, `keyword`, `translated_language` and
`feed_snapshot` on subsequent pages. Query cache keys include the complete
selection. Returning from a detail page recovers the snapshot from cached pages.
Snapshots expire after 30 minutes; a replacement invalidates sibling cached pages.

Redis holds immutable source chunks and an incremental filtered title window.
Previously scanned chapters are reused on next/back navigation. Newly inserted
head releases are excluded from later chunks of an existing window. This is a
bounded browsing window, not an upstream database transaction: deletion or
editing of not-yet-read upstream chapters can still move offsets.

The source `/chapter` endpoint has no genre/status filters and no readableAt
"until" cursor. It limits `offset + limit` to 10,000. Very deep pages or rare
genres can exhaust that source window. The backend reports a source error in
that case rather than silently returning a `/manga` metadata page ordered by
updates in another language. Complete historical ordering beyond this limit
would require a maintained chapter index; the `/manga` total remains a title
count, not a claim that all historical chapter pages are available.

Official references:
- https://gitlab.com/mangadex-pub/mangadex-api-docs/-/blob/main/04-chapter/search.md
- https://gitlab.com/mangadex-pub/mangadex-api-docs/-/blob/main/2-limitations.md

Year/minimum-rating filters and the "non Vietnamese" catalog mode retain their
existing catalog path. This release-feed change covers the source-queryable
genre/status/title/language selection.
