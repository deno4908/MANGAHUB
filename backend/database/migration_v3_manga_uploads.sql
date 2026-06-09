-- ============================================================
-- Migration V3: Manga Upload Submissions
-- ============================================================

CREATE TABLE IF NOT EXISTS manga_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    uploader_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE SET NULL,
    manga_slug VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(500) NOT NULL,
    author VARCHAR(255) NOT NULL,
    artist VARCHAR(255) DEFAULT '',
    manga_type VARCHAR(20) DEFAULT 'manga'
        CHECK (manga_type IN ('manga', 'manhwa', 'webtoon')),
    publish_status VARCHAR(20) DEFAULT 'ongoing'
        CHECK (publish_status IN ('ongoing', 'completed')),
    description TEXT DEFAULT '',
    genres JSONB DEFAULT '[]',
    cover_url TEXT DEFAULT '',
    language VARCHAR(10) DEFAULT 'vi',
    status VARCHAR(20) DEFAULT 'draft'
        CHECK (status IN ('draft','pending','published','rejected')),
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manga_uploads_uploader ON manga_uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_manga_uploads_status ON manga_uploads(status);
CREATE INDEX IF NOT EXISTS idx_manga_uploads_group ON manga_uploads(group_id);
CREATE INDEX IF NOT EXISTS idx_manga_uploads_slug ON manga_uploads(manga_slug);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'tr_manga_uploads_updated'
    ) THEN
        CREATE TRIGGER tr_manga_uploads_updated
            BEFORE UPDATE ON manga_uploads
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;
