-- ============================================================
-- v4: Manga local view tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS manga_views (
    manga_slug VARCHAR(255) PRIMARY KEY,
    views BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS manga_view_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    manga_slug VARCHAR(255) NOT NULL,
    chapter_id VARCHAR(100),
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manga_view_events_slug_created
    ON manga_view_events(manga_slug, created_at DESC);

CREATE OR REPLACE FUNCTION increment_manga_view(p_manga_slug TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    new_count BIGINT;
BEGIN
    INSERT INTO manga_views (manga_slug, views, updated_at)
    VALUES (p_manga_slug, 1, NOW())
    ON CONFLICT (manga_slug)
    DO UPDATE SET
        views = manga_views.views + 1,
        updated_at = NOW()
    RETURNING views INTO new_count;

    RETURN new_count;
END;
$$;
