-- ============================================================
-- Migration v5: Track first_seen_at per chapter_id
-- ============================================================

CREATE TABLE IF NOT EXISTS chapter_first_seen (
    chapter_id VARCHAR(100) PRIMARY KEY,
    manga_slug VARCHAR(255) NOT NULL,
    chapter_number VARCHAR(100) DEFAULT '',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(50) NOT NULL DEFAULT 'otruyen_detail'
);

CREATE INDEX IF NOT EXISTS idx_chapter_first_seen_manga
    ON chapter_first_seen(manga_slug, first_seen_at DESC);
