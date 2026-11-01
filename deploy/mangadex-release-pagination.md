# MangaDex browse pagination

Unfiltered Latest Updates follows MangaDex's chapter feed: /chapter, ordered
by readableAt DESC, with the selected translated language and content ratings.
The backend requests (page - 1) * limit directly and groups manga within that
page. A title can appear on another page when it has another release there.
This matches the source feed instead of scanning every earlier chapter to
construct globally unique title pages.

The upstream window is 10,000 entries. At 24 entries per page, the final page
is 417 and requests 16 entries (offset=9984). The source website can show 313
pages when using 32 entries per page. Grouping releases or removing hidden
titles can leave fewer cards on a page. Totals count chapter entries here.

Genre, status and title selections in Browse use /manga search with
includedTags[], status[], title, and availableTranslatedLanguage[]. MangaDex
applies these filters before paging. Latest in title search uses
latestUploadedChapter: the latest upload of a title that has the selected
translation language, rather than a globally unique language-specific chapter
history. Alphabetical and popularity searches also use direct source offsets.
MangaHub's existing local view/rating ranking rules remain in place; displayed
local counts are not replaced with upstream follows.

Search totals are capped to the accessible 10,000-entry window. The last request
cannot exceed that limit. Query keys and adjacent-page prefetch keep the same
filters, ordering, language and thumbnail size as the visible page.

Homepage sources recover independently. An image failure stays on that card
instead of disabling every MangaDex section. Transient source refresh failures
retain previously loaded sections. MangaDex home responses also retain a last
good server snapshot for one hour, keyed by the complete content/hidden-ID
selection. Stale source responses are marked unavailable for recovery;
authentication and hidden-title checks still run normally.

Legacy explicit filtered chapter-feed calls retain their unique-title window;
Browse's native title filters do not use that expensive scan path.

Official references:
- https://api.mangadex.org/docs/static/api.yaml
- https://gitlab.com/mangadex-pub/mangadex-api-docs/-/blob/main/2-limitations.md
