-- ============================================================
-- Migration V6: Consolidated — ensure all tables, RPCs, and
-- constraints exist for a fresh Supabase database.
-- Safe to run multiple times (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- === Extension ===
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Site settings (key-value config, used by uploads for max file size)
-- ============================================================
CREATE TABLE IF NOT EXISTS site_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO site_settings (key, value) VALUES ('max_upload_size_mb', '10')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Tables from migration_v2 (groups, uploads, audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS scanlation_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    logo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    total_uploads INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner','admin','uploader','member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS chapter_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    uploader_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE SET NULL,
    manga_slug VARCHAR(255) NOT NULL,
    manga_title VARCHAR(500) DEFAULT '',
    chapter_number INTEGER NOT NULL,
    chapter_title VARCHAR(255) DEFAULT '',
    language VARCHAR(10) DEFAULT 'vi',
    pages JSONB DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'draft'
        CHECK (status IN ('draft','pending','published','rejected')),
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    admin_name VARCHAR(100) DEFAULT '',
    action VARCHAR(100) NOT NULL,
    target VARCHAR(500) DEFAULT '',
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploads_uploader ON chapter_uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON chapter_uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_group ON chapter_uploads(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC);

-- ============================================================
-- Tables from migration_v3 (manga uploads)
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

-- ============================================================
-- Tables from migration_v4 (manga views)
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

-- ============================================================
-- Tables from migration_v5 (chapter first seen)
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

-- ============================================================
-- Missing RPC: get_manga_rating_aggregate
-- Used by ratings.py to efficiently get avg+count
-- ============================================================
CREATE OR REPLACE FUNCTION get_manga_rating_aggregate(p_slug TEXT)
RETURNS TABLE(average NUMERIC, total BIGINT)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(ROUND(AVG(score)::NUMERIC, 1), 0) AS average,
        COUNT(*)::BIGINT AS total
    FROM ratings
    WHERE manga_slug = p_slug;
END;
$$;

-- ============================================================
-- Missing RPC: get_admin_stats
-- Used by admin.py for dashboard stats
-- ============================================================
CREATE OR REPLACE FUNCTION get_admin_stats()
RETURNS JSON
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'total_users', (SELECT COUNT(*) FROM profiles),
        'total_comments', (SELECT COUNT(*) FROM comments WHERE is_deleted = FALSE),
        'total_bookmarks', (SELECT COUNT(*) FROM bookmarks),
        'total_follows', (SELECT COUNT(*) FROM follows),
        'total_ratings', (SELECT COUNT(*) FROM ratings),
        'total_reports', (SELECT COUNT(*) FROM reports),
        'pending_reports', (SELECT COUNT(*) FROM reports WHERE status = 'pending'),
        'total_chapter_uploads', (SELECT COUNT(*) FROM chapter_uploads),
        'pending_chapter_uploads', (SELECT COUNT(*) FROM chapter_uploads WHERE status = 'pending'),
        'total_manga_uploads', (SELECT COUNT(*) FROM manga_uploads),
        'pending_manga_uploads', (SELECT COUNT(*) FROM manga_uploads WHERE status = 'pending'),
        'active_readers', (SELECT COUNT(*) FROM profiles WHERE chapters_read > 0),
        'banned_users', (SELECT COUNT(*) FROM profiles WHERE is_banned = TRUE)
    ) INTO result;
    RETURN result;
END;
$$;

-- ============================================================
-- Fix reports CHECK constraint to match Pydantic ReportType enum
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'reports' AND constraint_type = 'CHECK'
        AND constraint_name LIKE '%report_type%'
    ) THEN
        ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_report_type_check;
    END IF;

    ALTER TABLE reports
        ADD CONSTRAINT reports_report_type_check
        CHECK (report_type IN (
            'manga', 'chapter', 'comment', 'user', 'bug',
            'account', 'content', 'missing_pages', 'wrong_order',
            'wrong_chapter', 'translation', 'other'
        ));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Triggers (safe: only create if not exists)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_uploads_updated') THEN
        CREATE TRIGGER tr_uploads_updated
            BEFORE UPDATE ON chapter_uploads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_manga_uploads_updated') THEN
        CREATE TRIGGER tr_manga_uploads_updated
            BEFORE UPDATE ON manga_uploads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;
