-- MangaHub: consolidated Supabase database installer
-- Revision: schema + migrations v2-v22 (including both v22 migrations).
-- Intended for a NEW Supabase project; this is schema/setup, NOT a data backup.
-- Requires Supabase auth/storage schemas and anon/authenticated/service_role roles.
-- Run the COMPLETE file as the SQL Editor database owner, before starting the app.
-- Existing production databases: retain your migration history; do not blindly
-- replay this installer. No production database is modified by publishing it.
-- Historical SQL files are retained locally and in Git history.
-- All changes commit together; final RLS and backend-only RPC grants take effect
-- atomically. No user data is seeded and no tables are dropped or truncated.
-- Rerunning on an already initialized test project is supported.
-- Source order is deliberate: base tables, uploads, storage, RLS, then hardening.
-- Historical BEGIN/COMMIT boundaries are folded into this single transaction.
-- Two non-idempotent legacy trigger/storage policy creations get DROP IF EXISTS.
-- Source SHA-256 values below refer to the unchanged historical files.

BEGIN;
SET LOCAL search_path = public, extensions;

-- SECTION 01/25: schema.sql
-- Source SHA-256: eb1752eca061a6f0482d60ccf0286db95f30a117c1b860962cf559e6f12b9751

-- ============================================================
-- Manga-Bliss Database Schema for Supabase (PostgreSQL)
-- User-Data Only — Manga data comes from OTruyenAPI
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- 1. PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL DEFAULT '',
    email VARCHAR(255),
    avatar TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    role VARCHAR(20) NOT NULL DEFAULT 'reader'
        CHECK (role IN ('reader', 'uploader', 'moderator', 'admin')),
    is_vip BOOLEAN DEFAULT FALSE,
    vip_expiry TIMESTAMPTZ,
    name_color VARCHAR(20),
    name_font VARCHAR(50),
    name_effect VARCHAR(50),
    is_banned BOOLEAN DEFAULT FALSE,
    ban_reason TEXT,
    session_revoked_at TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ,
    -- Stats (denormalized for fast reads)
    chapters_read INTEGER DEFAULT 0,
    total_reading_time INTEGER DEFAULT 0,   -- minutes
    comments_posted INTEGER DEFAULT 0,
    reading_streak INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. USER SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    -- Reader
    reading_mode VARCHAR(20) DEFAULT 'vertical'
        CHECK (reading_mode IN ('vertical', 'horizontal', 'webtoon')),
    page_direction VARCHAR(5) DEFAULT 'ltr' CHECK (page_direction IN ('ltr', 'rtl')),
    image_fit VARCHAR(10) DEFAULT 'width' CHECK (image_fit IN ('width', 'height', 'original')),
    image_loading VARCHAR(15) DEFAULT 'preload'
        CHECK (image_loading IN ('standard', 'preload', 'aggressive')),
    auto_hide_toolbar BOOLEAN DEFAULT TRUE,
    show_page_number BOOLEAN DEFAULT TRUE,
    show_progress_bar BOOLEAN DEFAULT TRUE,
    auto_bookmark BOOLEAN DEFAULT TRUE,
    auto_follow BOOLEAN DEFAULT FALSE,
    -- Notifications
    notify_new_chapter BOOLEAN DEFAULT TRUE,
    notify_comment_reply BOOLEAN DEFAULT TRUE,
    notify_system BOOLEAN DEFAULT TRUE,
    notify_email BOOLEAN DEFAULT FALSE,
    -- Privacy
    profile_visibility VARCHAR(15) DEFAULT 'public'
        CHECK (profile_visibility IN ('public', 'private')),
    show_reading_history BOOLEAN DEFAULT TRUE,
    show_followed_manga BOOLEAN DEFAULT TRUE,
    show_comments BOOLEAN DEFAULT TRUE,
    show_mature_content BOOLEAN DEFAULT FALSE,
    silent_view_tracking BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP (Supabase Auth trigger)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, username, display_name, email, role)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || LEFT(NEW.id::text, 8)),
        COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'username', ''),
        NEW.email,
        'reader'
    );
    INSERT INTO public.user_settings (user_id) VALUES (NEW.id);
    RETURN NEW;
EXCEPTION WHEN unique_violation THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger: fires AFTER a new user is created in auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 3. BOOKMARKS (manga_slug references OTruyenAPI)
-- ============================================================
CREATE TABLE IF NOT EXISTS bookmarks (
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    manga_slug VARCHAR(255) NOT NULL,
    manga_title VARCHAR(500) DEFAULT '',
    manga_thumb TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, manga_slug)
);

-- ============================================================
-- 4. FOLLOWS
-- ============================================================
CREATE TABLE IF NOT EXISTS follows (
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    manga_slug VARCHAR(255) NOT NULL,
    manga_title VARCHAR(500) DEFAULT '',
    manga_thumb TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, manga_slug)
);

-- ============================================================
-- 5. READING HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS reading_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    manga_slug VARCHAR(255) NOT NULL,
    manga_title VARCHAR(500) DEFAULT '',
    manga_thumb TEXT DEFAULT '',
    chapter_id TEXT NOT NULL,              -- source chapter ID/token, including long QQ slugs
    chapter_name TEXT DEFAULT '',          -- e.g. "671", or a source chapter title
    page INTEGER DEFAULT 0,
    progress DECIMAL(5,2) DEFAULT 0,        -- 0-100
    read_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, manga_slug, chapter_id)
);

-- ============================================================
-- 6. COMMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    manga_slug VARCHAR(255) NOT NULL,
    chapter_id VARCHAR(100),                -- OTruyen chapter _id (optional)
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    image_url TEXT,
    likes INTEGER DEFAULT 0,
    reactions JSONB DEFAULT '{}',
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. COMMENT LIKES (prevent duplicate likes)
-- ============================================================
CREATE TABLE IF NOT EXISTS comment_likes (
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, comment_id)
);

-- ============================================================
-- 8. COMMENT REACTIONS (one reaction per user per comment)
-- ============================================================
CREATE TABLE IF NOT EXISTS comment_reactions (
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, comment_id)
);

-- ============================================================
-- 9. NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL
        CHECK (type IN ('new_chapter', 'reply', 'system', 'follow_update')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    manga_slug VARCHAR(255),
    chapter_id VARCHAR(100),
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 10. RATINGS (local user ratings)
-- ============================================================
CREATE TABLE IF NOT EXISTS ratings (
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    manga_slug VARCHAR(255) NOT NULL,
    score DECIMAL(2,1) NOT NULL CHECK (score >= 1 AND score <= 5),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, manga_slug)
);

-- ============================================================
-- 11. REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    report_type VARCHAR(20) NOT NULL
        CHECK (report_type IN ('manga', 'chapter', 'comment', 'user', 'bug', 'other')),
    target_id VARCHAR(255),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
    admin_note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_slug ON bookmarks(manga_slug);

CREATE INDEX IF NOT EXISTS idx_follows_user ON follows(user_id);
CREATE INDEX IF NOT EXISTS idx_follows_slug ON follows(manga_slug);

CREATE INDEX IF NOT EXISTS idx_history_user ON reading_history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_slug ON reading_history(manga_slug);
CREATE INDEX IF NOT EXISTS idx_history_read_at ON reading_history(user_id, read_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_manga ON comments(manga_slug);
CREATE INDEX IF NOT EXISTS idx_comments_chapter ON comments(chapter_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_user ON comment_reactions(user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_ratings_slug ON ratings(manga_slug);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_profiles_updated ON profiles;
CREATE TRIGGER tr_profiles_updated
    BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS tr_comments_updated ON comments;
CREATE TRIGGER tr_comments_updated
    BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS tr_settings_updated ON user_settings;
CREATE TRIGGER tr_settings_updated
    BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS tr_ratings_updated ON ratings;
CREATE TRIGGER tr_ratings_updated
    BEFORE UPDATE ON ratings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Admin-only setting guard for silent view tracking.
CREATE OR REPLACE FUNCTION public.enforce_silent_view_tracking_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
BEGIN
    IF COALESCE(NEW.silent_view_tracking, FALSE) IS TRUE THEN
        SELECT role INTO v_role
        FROM public.profiles
        WHERE id = NEW.user_id;

        IF LOWER(COALESCE(v_role, 'reader')) <> 'admin' THEN
            RAISE EXCEPTION 'silent_view_tracking is admin-only';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_user_settings_silent_view_admin ON user_settings;
CREATE TRIGGER tr_user_settings_silent_view_admin
    BEFORE INSERT OR UPDATE OF user_id, silent_view_tracking
    ON user_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_silent_view_tracking_admin();

CREATE OR REPLACE FUNCTION public.clear_silent_view_tracking_when_non_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF LOWER(COALESCE(NEW.role, 'reader')) <> 'admin' THEN
        UPDATE public.user_settings
        SET silent_view_tracking = FALSE
        WHERE user_id = NEW.id
          AND COALESCE(silent_view_tracking, FALSE) = TRUE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_profiles_clear_silent_view_tracking ON profiles;
CREATE TRIGGER tr_profiles_clear_silent_view_tracking
    AFTER INSERT OR UPDATE OF role
    ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.clear_silent_view_tracking_when_non_admin();

-- Update comment likes count
CREATE OR REPLACE FUNCTION update_comment_likes()
RETURNS TRIGGER AS $$
DECLARE target_comment_id UUID;
BEGIN
    target_comment_id := COALESCE(NEW.comment_id, OLD.comment_id);
    UPDATE comments SET likes = (
        SELECT COUNT(*) FROM comment_likes WHERE comment_id = target_comment_id
    ) WHERE id = target_comment_id;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_comment_likes_changed ON comment_likes;
CREATE TRIGGER tr_comment_likes_changed
    AFTER INSERT OR DELETE ON comment_likes
    FOR EACH ROW EXECUTE FUNCTION update_comment_likes();


-- SECTION 02/25: migration_v2.sql
-- Source SHA-256: 56061dab2f055fd7461cc6d3eca4b02a5bcc15cf345e4af3934671f64fe0ae49

-- ============================================================
-- Migration V2: Uploads, Groups, Audit Log
-- ============================================================

-- 11. SCANLATION GROUPS
CREATE TABLE IF NOT EXISTS scanlation_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    logo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    total_uploads INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. GROUP MEMBERS
CREATE TABLE IF NOT EXISTS group_members (
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner','admin','uploader','member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- 13. CHAPTER UPLOADS
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

-- 14. AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    admin_name VARCHAR(100) DEFAULT '',
    action VARCHAR(100) NOT NULL,
    target VARCHAR(500) DEFAULT '',
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_uploads_uploader ON chapter_uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON chapter_uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_group ON chapter_uploads(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC);

-- Trigger
DROP TRIGGER IF EXISTS tr_uploads_updated ON chapter_uploads;
CREATE TRIGGER tr_uploads_updated
    BEFORE UPDATE ON chapter_uploads FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- SECTION 03/25: migration_v3_manga_uploads.sql
-- Source SHA-256: 45858de8d881d7a16ad84886a7f676662d3d7776a335210940405db2fa93a4cf

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


-- SECTION 04/25: migration_v4_manga_views.sql
-- Source SHA-256: 216c0fd1e1b0a72f295cc474938fc3452b606e65a0c12d3b23abe66a351d1cad

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


-- SECTION 05/25: migration_v5_chapter_first_seen.sql
-- Source SHA-256: ba483ea9f2c92ff8a39dcab49972f6474cd33453830f33ac00f18360168a776c

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


-- SECTION 06/25: migration_v6_consolidated.sql
-- Source SHA-256: a284b419bb33e9ab98f16bcc47232ccd17988a346df60c65d30e288cffe9c9fe

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


-- SECTION 07/25: storage_setup.sql
-- Source SHA-256: b24cd44ce7e99994df4422d1045f0a55d347ce249168b65f26669f505e53f0fd

-- ============================================================
-- Supabase Storage: Manga Chapter Images Bucket
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Create public bucket for manga pages
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'manga-pages',
    'manga-pages',
    true,
    10485760,  -- 10MB per file (configurable via site_settings)
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- 1b. Site settings table (admin can change max upload size)
CREATE TABLE IF NOT EXISTS site_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO site_settings (key, value)
VALUES ('max_upload_size_mb', '10')
ON CONFLICT (key) DO NOTHING;

-- 2. Allow authenticated users with uploader+ role to upload
DROP POLICY IF EXISTS "Uploaders can upload manga pages" ON storage.objects;
CREATE POLICY "Uploaders can upload manga pages"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'manga-pages'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('uploader', 'moderator', 'admin')
        AND NOT is_banned
    )
);

-- 3. Anyone can view (public bucket)
DROP POLICY IF EXISTS "Anyone can view manga pages" ON storage.objects;
CREATE POLICY "Anyone can view manga pages"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'manga-pages');

-- 4. Uploaders can delete their own uploads, admins can delete any
DROP POLICY IF EXISTS "Uploaders can delete own manga pages" ON storage.objects;
CREATE POLICY "Uploaders can delete own manga pages"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'manga-pages'
    AND (
        auth.uid()::text = (storage.foldername(name))[2]
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);


-- SECTION 08/25: rls_policies.sql
-- Source SHA-256: 6984b8c79a2fc4dc3377d2c79e9ba26d4c049410eaf881c9b1c917e3d4882323

-- ============================================================
-- Row Level Security Policies for Supabase
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PROFILES
-- ============================================================
-- Anyone can read public profiles
DROP POLICY IF EXISTS "profiles_select_public" ON profiles;
CREATE POLICY "profiles_select_public" ON profiles
    FOR SELECT USING (
        is_banned = FALSE AND (
            COALESCE((SELECT profile_visibility FROM user_settings WHERE user_id = id), 'public') = 'public'
            OR id = auth.uid()
        )
    );

-- Profile updates go through backend service-role API only.
-- Do not allow direct browser clients to update sensitive columns
-- such as role, VIP flags, ban flags, auth revoke timestamps, or stats.
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_no_client_update" ON profiles;
CREATE POLICY "profiles_no_client_update" ON profiles
    FOR UPDATE USING (FALSE)
    WITH CHECK (FALSE);
REVOKE INSERT, UPDATE, DELETE ON TABLE profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE profiles TO service_role;

-- ============================================================
-- USER SETTINGS
-- ============================================================
DROP POLICY IF EXISTS "settings_select_own" ON user_settings;
CREATE POLICY "settings_select_own" ON user_settings
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "settings_update_own" ON user_settings;
CREATE POLICY "settings_update_own" ON user_settings
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ============================================================
-- BOOKMARKS
-- ============================================================
DROP POLICY IF EXISTS "bookmarks_select_own" ON bookmarks;
CREATE POLICY "bookmarks_select_own" ON bookmarks
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "bookmarks_insert_own" ON bookmarks;
CREATE POLICY "bookmarks_insert_own" ON bookmarks
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "bookmarks_delete_own" ON bookmarks;
CREATE POLICY "bookmarks_delete_own" ON bookmarks
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- FOLLOWS
-- ============================================================
DROP POLICY IF EXISTS "follows_select_own" ON follows;
CREATE POLICY "follows_select_own" ON follows
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "follows_insert_own" ON follows;
CREATE POLICY "follows_insert_own" ON follows
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "follows_delete_own" ON follows;
CREATE POLICY "follows_delete_own" ON follows
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- READING HISTORY
-- ============================================================
DROP POLICY IF EXISTS "history_select_own" ON reading_history;
CREATE POLICY "history_select_own" ON reading_history
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "history_insert_own" ON reading_history;
CREATE POLICY "history_insert_own" ON reading_history
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "history_update_own" ON reading_history;
CREATE POLICY "history_update_own" ON reading_history
    FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "history_delete_own" ON reading_history;
CREATE POLICY "history_delete_own" ON reading_history
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- COMMENTS
-- ============================================================
-- Anyone can read non-deleted comments
DROP POLICY IF EXISTS "comments_select_all" ON comments;
CREATE POLICY "comments_select_all" ON comments
    FOR SELECT USING (is_deleted = FALSE);

-- All comment mutations go through FastAPI so content validation, counters,
-- rate limits, and moderation checks cannot be bypassed through PostgREST.
DROP POLICY IF EXISTS "comments_insert_auth" ON comments;
DROP POLICY IF EXISTS "comments_update_own" ON comments;
DROP POLICY IF EXISTS "comments_delete_own" ON comments;
REVOKE INSERT, UPDATE, DELETE ON TABLE comments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE comments TO service_role;

-- ============================================================
-- COMMENT LIKES
-- ============================================================
DROP POLICY IF EXISTS "likes_select_all" ON comment_likes;
CREATE POLICY "likes_select_all" ON comment_likes
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "likes_insert_own" ON comment_likes;
DROP POLICY IF EXISTS "likes_delete_own" ON comment_likes;
REVOKE INSERT, UPDATE, DELETE ON TABLE comment_likes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE comment_likes TO service_role;

-- ============================================================
-- COMMENT REACTIONS
-- ============================================================
DROP POLICY IF EXISTS "reactions_select_all" ON comment_reactions;
CREATE POLICY "reactions_select_all" ON comment_reactions
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "reactions_insert_own" ON comment_reactions;
DROP POLICY IF EXISTS "reactions_update_own" ON comment_reactions;
DROP POLICY IF EXISTS "reactions_delete_own" ON comment_reactions;
REVOKE INSERT, UPDATE, DELETE ON TABLE comment_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE comment_reactions TO service_role;

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
DROP POLICY IF EXISTS "notifications_select_own" ON notifications;
CREATE POLICY "notifications_select_own" ON notifications
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_update_own" ON notifications;
CREATE POLICY "notifications_update_own" ON notifications
    FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_delete_own" ON notifications;
CREATE POLICY "notifications_delete_own" ON notifications
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- RATINGS
-- ============================================================
DROP POLICY IF EXISTS "ratings_select_all" ON ratings;
CREATE POLICY "ratings_select_all" ON ratings
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "ratings_insert_own" ON ratings;
CREATE POLICY "ratings_insert_own" ON ratings
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ratings_update_own" ON ratings;
CREATE POLICY "ratings_update_own" ON ratings
    FOR UPDATE USING (user_id = auth.uid());

-- ============================================================
-- REPORTS
-- ============================================================
DROP POLICY IF EXISTS "reports_insert_auth" ON reports;
REVOKE INSERT, UPDATE, DELETE ON TABLE reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reports TO service_role;

DROP POLICY IF EXISTS "reports_select_own" ON reports;
CREATE POLICY "reports_select_own" ON reports
    FOR SELECT USING (reporter_id = auth.uid());

-- ============================================================
-- SCANLATION GROUPS (public read, members manage)
-- ============================================================
ALTER TABLE scanlation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups_select_all" ON scanlation_groups;
CREATE POLICY "groups_select_all" ON scanlation_groups
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "groups_insert_auth" ON scanlation_groups;
DROP POLICY IF EXISTS "groups_update_owner" ON scanlation_groups;
DROP POLICY IF EXISTS "groups_delete_owner" ON scanlation_groups;
REVOKE INSERT, UPDATE, DELETE ON TABLE scanlation_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scanlation_groups TO service_role;

DROP POLICY IF EXISTS "group_members_select_all" ON group_members;
CREATE POLICY "group_members_select_all" ON group_members
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "group_members_insert_member" ON group_members;
-- Membership writes must go through the backend, which verifies group
-- owner/admin permissions before using the service role.
DROP POLICY IF EXISTS "group_members_delete_own" ON group_members;
REVOKE INSERT, UPDATE, DELETE ON TABLE group_members FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_members TO service_role;

-- ============================================================
-- CHAPTER UPLOADS (owner read/write, public read published)
-- ============================================================
ALTER TABLE chapter_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uploads_select_own_or_published" ON chapter_uploads;
CREATE POLICY "uploads_select_own_or_published" ON chapter_uploads
    FOR SELECT USING (uploader_id = auth.uid() OR status = 'published');

DROP POLICY IF EXISTS "uploads_insert_own" ON chapter_uploads;
DROP POLICY IF EXISTS "uploads_update_own" ON chapter_uploads;
DROP POLICY IF EXISTS "uploads_delete_own" ON chapter_uploads;
REVOKE INSERT, UPDATE, DELETE ON TABLE chapter_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE chapter_uploads TO service_role;

-- ============================================================
-- MANGA UPLOADS
-- ============================================================
ALTER TABLE manga_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manga_uploads_select_own_or_published" ON manga_uploads;
CREATE POLICY "manga_uploads_select_own_or_published" ON manga_uploads
    FOR SELECT USING (uploader_id = auth.uid() OR status = 'published');

DROP POLICY IF EXISTS "manga_uploads_insert_own" ON manga_uploads;
DROP POLICY IF EXISTS "manga_uploads_update_own" ON manga_uploads;
DROP POLICY IF EXISTS "manga_uploads_delete_own" ON manga_uploads;
REVOKE INSERT, UPDATE, DELETE ON TABLE manga_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE manga_uploads TO service_role;

-- ============================================================
-- AUDIT LOG (admin read only, service role writes)
-- ============================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_select_admin" ON audit_log;
CREATE POLICY "audit_log_select_admin" ON audit_log
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'moderator'))
    );

-- ============================================================
-- MANGA VIEWS (aggregate public read, raw events private)
-- ============================================================
ALTER TABLE manga_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE manga_view_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manga_views_select_all" ON manga_views;
CREATE POLICY "manga_views_select_all" ON manga_views
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "manga_view_events_select_all" ON manga_view_events;
DROP POLICY IF EXISTS "manga_view_events_no_client_access" ON manga_view_events;
CREATE POLICY "manga_view_events_no_client_access" ON manga_view_events
    FOR ALL
    USING (FALSE)
    WITH CHECK (FALSE);
REVOKE ALL ON TABLE manga_view_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE manga_view_events TO service_role;

-- ============================================================
-- CHAPTER FIRST SEEN (public read)
-- ============================================================
ALTER TABLE chapter_first_seen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chapter_first_seen_select_all" ON chapter_first_seen;
CREATE POLICY "chapter_first_seen_select_all" ON chapter_first_seen
    FOR SELECT USING (TRUE);

-- ============================================================
-- SITE SETTINGS (public read, admin write)
-- ============================================================
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_settings_select_all" ON site_settings;
CREATE POLICY "site_settings_select_all" ON site_settings
    FOR SELECT USING (TRUE);

-- ============================================================
-- NOTIFICATIONS INSERT (service role handles this)
-- ============================================================
DROP POLICY IF EXISTS "notifications_insert_service" ON notifications;
CREATE POLICY "notifications_insert_service" ON notifications
    FOR INSERT WITH CHECK (user_id = auth.uid());


-- SECTION 09/25: migration_v7_comment_images.sql
-- Source SHA-256: 530509b31e8dbffebca7dc5d5c51a1f22fa4895b6d29b8de8c2c7762a15887b9

ALTER TABLE comments
ADD COLUMN IF NOT EXISTS image_url TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'comment-images',
    'comment-images',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Comment images public read" ON storage.objects;
CREATE POLICY "Comment images public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'comment-images');

DROP POLICY IF EXISTS "Comment images authenticated upload" ON storage.objects;
CREATE POLICY "Comment images authenticated upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'comment-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND NOT is_banned
    )
);

DROP POLICY IF EXISTS "Comment images owner delete" ON storage.objects;
CREATE POLICY "Comment images owner delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'comment-images'
    AND owner = auth.uid()
);


-- SECTION 10/25: migration_v8_manga_overrides.sql
-- Source SHA-256: 5e39c00c3b598b5ef61a4f5999efe934b52a1723165429d81b91bc7911173e5d

-- ============================================================
-- Migration V8: Manga Overrides (Admin Control)
-- ============================================================
-- Allows admins to hide/feature/annotate any manga (including
-- external OTruyen/MangaDex slugs) without modifying the source.
-- Run this in Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS manga_overrides (
    manga_slug  TEXT PRIMARY KEY,
    is_hidden   BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_reason TEXT,
    hidden_at   TIMESTAMPTZ,
    hidden_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    featured_at TIMESTAMPTZ,
    featured_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    admin_notes TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manga_overrides_hidden   ON manga_overrides(is_hidden);
CREATE INDEX IF NOT EXISTS idx_manga_overrides_featured ON manga_overrides(is_featured);

-- Auto-update updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_manga_overrides_updated'
    ) THEN
        CREATE TRIGGER tr_manga_overrides_updated
            BEFORE UPDATE ON manga_overrides
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

-- RLS: only admins can read/write overrides
ALTER TABLE manga_overrides ENABLE ROW LEVEL SECURITY;

-- Service role (backend) bypasses RLS
-- Public read for is_hidden check (needed by manga router)
DROP POLICY IF EXISTS "manga_overrides_public_read" ON manga_overrides;
CREATE POLICY "manga_overrides_public_read"
    ON manga_overrides FOR SELECT
    USING (true);

-- Only service role can write (done via backend with service key)


-- SECTION 11/25: migration_v9_mature_content_setting.sql
-- Source SHA-256: c5ef2c20c7fcf24477d8ce86bb38c33c6fc89ac5a55619f777ca73ee75d37561

-- ============================================================
-- Migration V9: Mature content visibility setting
-- ============================================================

ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS show_mature_content BOOLEAN DEFAULT FALSE;

UPDATE user_settings
SET show_mature_content = FALSE
WHERE show_mature_content IS NULL;


-- SECTION 12/25: migration_v10_public_profiles.sql
-- Source SHA-256: ed2a0d8bf49db77ac1eebff3f6afdffd91c801e14542f6e3cfaa0eb6298b404d

-- ============================================================
-- Migration V10: Public profile privacy support
-- ============================================================
-- Safe to run multiple times. This keeps older databases aligned with
-- the public profile page and Settings > profile visibility controls.

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS profile_visibility VARCHAR(15) DEFAULT 'public';

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS show_reading_history BOOLEAN DEFAULT TRUE;

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS show_followed_manga BOOLEAN DEFAULT TRUE;

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS show_comments BOOLEAN DEFAULT TRUE;

UPDATE public.user_settings
SET profile_visibility = 'public'
WHERE profile_visibility IS NULL
   OR profile_visibility NOT IN ('public', 'private');

UPDATE public.user_settings
SET show_reading_history = TRUE
WHERE show_reading_history IS NULL;

UPDATE public.user_settings
SET show_followed_manga = TRUE
WHERE show_followed_manga IS NULL;

UPDATE public.user_settings
SET show_comments = TRUE
WHERE show_comments IS NULL;

ALTER TABLE public.user_settings
DROP CONSTRAINT IF EXISTS user_settings_profile_visibility_check;

ALTER TABLE public.user_settings
ADD CONSTRAINT user_settings_profile_visibility_check
CHECK (profile_visibility IN ('public', 'private'));

CREATE INDEX IF NOT EXISTS idx_user_settings_profile_visibility
ON public.user_settings (profile_visibility);

CREATE INDEX IF NOT EXISTS idx_follows_user_public_profile
ON public.follows (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reading_history_user_public_profile
ON public.reading_history (user_id, read_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_user_public_profile
ON public.comments (user_id, created_at DESC)
WHERE is_deleted = FALSE;

-- Match the frontend meaning:
-- public  = everyone can view profile shell
-- private = owner only
DROP POLICY IF EXISTS "profiles_select_public" ON public.profiles;
CREATE POLICY "profiles_select_public" ON public.profiles
    FOR SELECT USING (
        is_banned = FALSE
        AND (
            id = auth.uid()
            OR COALESCE(
                (SELECT us.profile_visibility FROM public.user_settings us WHERE us.user_id = profiles.id),
                'public'
            ) = 'public'
        )
    );


-- SECTION 13/25: migration_v11_site_announcements.sql
-- Source SHA-256: 071814cb52230b7f22d619bf969138567a718567b7f8ec45aafceb3d8d107e7d

-- ============================================================
-- Migration V11: Public site announcements / home popup
-- Safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS site_announcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    announcement_type VARCHAR(30) NOT NULL DEFAULT 'system'
        CHECK (announcement_type IN ('system', 'maintenance', 'event', 'warning')),
    target VARCHAR(30) NOT NULL DEFAULT 'all',
    show_popup BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_announcements_active
    ON site_announcements (is_active, show_popup, target, starts_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_site_announcements_created_at
    ON site_announcements (created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'tr_site_announcements_updated'
    ) THEN
        CREATE TRIGGER tr_site_announcements_updated
            BEFORE UPDATE ON site_announcements
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

ALTER TABLE site_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_announcements_public_active_read" ON site_announcements;
CREATE POLICY "site_announcements_public_active_read"
    ON site_announcements FOR SELECT
    USING (
        is_active = TRUE
        AND show_popup = TRUE
        AND target = 'all'
        AND starts_at <= NOW()
        AND expires_at > NOW()
    );


-- SECTION 14/25: migration_v12_announcement_options.sql
-- Source SHA-256: c5dc4dedebff56e819766b92d2d378de5f20b0f8e4b1d094f7fcdd39e12336df

-- ============================================================
-- Migration V12: Rich site announcement options
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE site_announcements
    ADD COLUMN IF NOT EXISTS image_url TEXT,
    ADD COLUMN IF NOT EXISTS cta_label VARCHAR(80),
    ADD COLUMN IF NOT EXISTS cta_url TEXT,
    ADD COLUMN IF NOT EXISTS popup_size VARCHAR(20) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS popup_dismissible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'site_announcements_popup_size_check'
    ) THEN
        ALTER TABLE site_announcements
            ADD CONSTRAINT site_announcements_popup_size_check
            CHECK (popup_size IN ('compact', 'standard', 'wide'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_site_announcements_priority
    ON site_announcements (priority DESC, created_at DESC);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'announcement-images',
    'announcement-images',
    true,
    8388608,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Announcement images public read" ON storage.objects;
CREATE POLICY "Announcement images public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'announcement-images');

DROP POLICY IF EXISTS "Announcement images admin upload" ON storage.objects;
CREATE POLICY "Announcement images admin upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Announcement images admin delete" ON storage.objects;
CREATE POLICY "Announcement images admin delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);


-- SECTION 15/25: migration_v13_storage_security.sql
-- Source SHA-256: 47eb35dad820f03d822a8031ad4e4031c49b3725a8ad7df0319d742e230119ff

-- ============================================================
-- Migration v13: Fix storage security - restrict file listing
-- Run this in Supabase SQL Editor
-- Safe to run multiple times.
-- ============================================================
-- Problem: Broad SELECT policies on storage.objects with TO public
-- allow ANY client to enumerate ALL files in these buckets:
--   1. manga-pages
--   2. comment-images
--   3. announcement-images
--
-- Since all 3 buckets are public, files are already accessible
-- via their public URLs. The SELECT policy only controls the
-- storage LIST API — we should restrict it.
-- ============================================================

-- ── 1. manga-pages ──────────────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Anyone can view manga pages" ON storage.objects;

-- Replace: uploaders see own folder, admins/mods see all
DROP POLICY IF EXISTS "Scoped read manga pages" ON storage.objects;
CREATE POLICY "Scoped read manga pages"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'manga-pages'
    AND (
        -- Uploaders can list their own upload folder
        -- Path: {manga_slug}/{chapter_number}/{uploader_id}/page.ext
        (storage.foldername(name))[3] = auth.uid()::text
        OR
        -- Admins and moderators can list any files
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);

-- ── 2. comment-images ───────────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Comment images public read" ON storage.objects;

-- Replace: users see own comment images, admins see all
DROP POLICY IF EXISTS "Scoped read comment images" ON storage.objects;
CREATE POLICY "Scoped read comment images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'comment-images'
    AND (
        -- Owner can see their own uploads
        owner = auth.uid()
        OR
        -- Admins and moderators can see all
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);

-- ── 3. announcement-images ──────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Announcement images public read" ON storage.objects;

-- Replace: only admins can list announcement images
DROP POLICY IF EXISTS "Scoped read announcement images" ON storage.objects;
CREATE POLICY "Scoped read announcement images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- ============================================================
-- Note: Public bucket files remain accessible via public URLs
-- (e.g. https://xxx.supabase.co/storage/v1/object/public/bucket/path)
-- These policies ONLY restrict the storage.objects LIST/SELECT API,
-- preventing clients from enumerating all files in the buckets.
-- ============================================================


-- SECTION 16/25: migration_v14_auth_session_security.sql
-- Source SHA-256: 2369e09de58fb870886ce8d6d4bf831485ffdbbbca195e031687d3397ab42763

-- Auth session security metadata.
-- Required for backend-side invalidation of already-issued access JWTs.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS session_revoked_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_session_revoked_at
ON public.profiles(session_revoked_at);

CREATE INDEX IF NOT EXISTS idx_profiles_password_changed_at
ON public.profiles(password_changed_at);


-- SECTION 17/25: migration_v15_view_comment_anti_spam.sql
-- Source SHA-256: 4012e7086933029ac76a574c9787926cfc66f2be9340c79d5cf819903df8db48

-- ============================================================
-- v15: View/comment anti-spam support
-- ============================================================
-- Safe to run multiple times.

ALTER TABLE public.manga_view_events
ADD COLUMN IF NOT EXISTS viewer_hash TEXT,
ADD COLUMN IF NOT EXISTS ip_hash TEXT,
ADD COLUMN IF NOT EXISTS user_agent_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_manga_view_events_viewer_recent
ON public.manga_view_events (viewer_hash, created_at DESC)
WHERE viewer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manga_view_events_dedup
ON public.manga_view_events (manga_slug, chapter_id, viewer_hash, created_at DESC)
WHERE viewer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manga_view_events_manga_viewer_recent
ON public.manga_view_events (manga_slug, viewer_hash, created_at DESC)
WHERE viewer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manga_view_events_manga_ip_recent
ON public.manga_view_events (manga_slug, ip_hash, created_at DESC)
WHERE ip_hash IS NOT NULL;

-- v15 stores hashed viewer/IP/user-agent signals in manga_view_events.
-- Keep aggregate counts public via manga_views, but never expose raw event rows to clients.
ALTER TABLE public.manga_view_events ENABLE ROW LEVEL SECURITY;
-- Replaces the old public-read policy from rls_policies.sql. This does not delete data.
DROP POLICY IF EXISTS "manga_view_events_select_all" ON public.manga_view_events;
DROP POLICY IF EXISTS "manga_view_events_no_client_access" ON public.manga_view_events;
CREATE POLICY "manga_view_events_no_client_access" ON public.manga_view_events
    FOR ALL
    USING (FALSE)
    WITH CHECK (FALSE);
REVOKE ALL ON TABLE public.manga_view_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manga_view_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_comments_user_created_recent
ON public.comments (user_id, created_at DESC)
WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS public.manga_read_sessions (
    session_id TEXT PRIMARY KEY,
    manga_slug VARCHAR(255) NOT NULL,
    chapter_id VARCHAR(100),
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    viewer_hash TEXT NOT NULL,
    ip_hash TEXT,
    user_agent_hash TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    max_progress NUMERIC(5, 2) NOT NULL DEFAULT 0,
    max_page_seen INTEGER NOT NULL DEFAULT 0,
    counted_at TIMESTAMPTZ
);

ALTER TABLE public.manga_read_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "manga_read_sessions_no_client_access" ON public.manga_read_sessions;
CREATE POLICY "manga_read_sessions_no_client_access" ON public.manga_read_sessions
    FOR ALL
    USING (FALSE)
    WITH CHECK (FALSE);
REVOKE ALL ON TABLE public.manga_read_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manga_read_sessions TO service_role;

CREATE INDEX IF NOT EXISTS idx_manga_read_sessions_viewer_recent
ON public.manga_read_sessions (viewer_hash, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_manga_read_sessions_user_recent
ON public.manga_read_sessions (user_id, started_at DESC)
WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.start_manga_read_session(
    p_manga_slug TEXT,
    p_chapter_id TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_viewer_hash TEXT DEFAULT NULL,
    p_ip_hash TEXT DEFAULT NULL,
    p_user_agent_hash TEXT DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session_id TEXT := NULLIF(trim(COALESCE(p_session_id, '')), '');
    v_viewer_hash TEXT := NULLIF(trim(COALESCE(p_viewer_hash, '')), '');
BEGIN
    IF p_manga_slug IS NULL OR length(trim(p_manga_slug)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid-manga');
    END IF;

    IF v_session_id IS NULL OR v_viewer_hash IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid-session');
    END IF;

    INSERT INTO public.manga_read_sessions (
        session_id,
        manga_slug,
        chapter_id,
        user_id,
        viewer_hash,
        ip_hash,
        user_agent_hash
    )
    VALUES (
        v_session_id,
        trim(p_manga_slug),
        NULLIF(p_chapter_id, ''),
        p_user_id,
        v_viewer_hash,
        NULLIF(p_ip_hash, ''),
        NULLIF(p_user_agent_hash, '')
    )
    ON CONFLICT (session_id)
    DO UPDATE SET
        last_seen_at = NOW(),
        user_id = COALESCE(manga_read_sessions.user_id, EXCLUDED.user_id);

    RETURN jsonb_build_object('ok', true, 'session_id', v_session_id);
END;
$$;

-- Removes the obsolete v15 draft overload so Supabase RPC resolution is unambiguous.
-- This drops only the old function signature, not any table or stored data.
DROP FUNCTION IF EXISTS public.track_manga_view_checked(
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    INTEGER
);

CREATE OR REPLACE FUNCTION public.track_manga_view_checked(
    p_manga_slug TEXT,
    p_chapter_id TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_viewer_hash TEXT DEFAULT NULL,
    p_ip_hash TEXT DEFAULT NULL,
    p_user_agent_hash TEXT DEFAULT NULL,
    p_dedup_seconds INTEGER DEFAULT 900,
    p_session_id TEXT DEFAULT NULL,
    p_elapsed_seconds INTEGER DEFAULT 0,
    p_progress NUMERIC DEFAULT 0,
    p_page_seen INTEGER DEFAULT 0,
    p_min_elapsed_seconds INTEGER DEFAULT 12,
    p_min_progress NUMERIC DEFAULT 15,
    p_min_page_seen INTEGER DEFAULT 2
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session public.manga_read_sessions%ROWTYPE;
    v_session_id TEXT := NULLIF(trim(COALESCE(p_session_id, '')), '');
    v_viewer_hash TEXT := NULLIF(trim(COALESCE(p_viewer_hash, '')), '');
    v_actual_elapsed INTEGER := 0;
    v_progress NUMERIC := LEAST(100, GREATEST(0, COALESCE(p_progress, 0)));
    v_page_seen INTEGER := GREATEST(0, COALESCE(p_page_seen, 0));
BEGIN
    IF p_manga_slug IS NULL OR length(trim(p_manga_slug)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'counted', false, 'reason', 'invalid-manga');
    END IF;

    IF v_session_id IS NULL OR v_viewer_hash IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'missing-read-session');
    END IF;

    SELECT *
    INTO v_session
    FROM public.manga_read_sessions
    WHERE session_id = v_session_id
      AND manga_slug = trim(p_manga_slug)
      AND COALESCE(chapter_id, '') = COALESCE(p_chapter_id, '')
      AND viewer_hash = v_viewer_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-not-started');
    END IF;

    IF v_session.started_at < NOW() - INTERVAL '6 hours' THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-expired');
    END IF;

    -- Serialize different session IDs for the same viewer and manga so two
    -- concurrent requests cannot both pass the recent-view check.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(trim(p_manga_slug) || ':' || v_viewer_hash, 0)
    );

    v_actual_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - v_session.started_at)))::INTEGER);
    v_progress := GREATEST(v_progress, COALESCE(v_session.max_progress, 0));
    v_page_seen := GREATEST(v_page_seen, COALESCE(v_session.max_page_seen, 0));

    UPDATE public.manga_read_sessions
    SET
        last_seen_at = NOW(),
        max_progress = v_progress,
        max_page_seen = v_page_seen,
        user_id = COALESCE(manga_read_sessions.user_id, p_user_id)
    WHERE session_id = v_session_id;

    IF v_session.counted_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-already-counted');
    END IF;

    IF v_actual_elapsed < GREATEST(1, p_min_elapsed_seconds) THEN
        RETURN jsonb_build_object(
            'ok', true,
            'counted', false,
            'reason', 'too-short',
            'elapsed', v_actual_elapsed
        );
    END IF;

    IF v_progress < p_min_progress AND v_page_seen < p_min_page_seen THEN
        RETURN jsonb_build_object(
            'ok', true,
            'counted', false,
            'reason', 'not-enough-progress',
            'progress', v_progress,
            'page_seen', v_page_seen
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.manga_view_events e
        WHERE e.manga_slug = p_manga_slug
          AND e.created_at >= NOW() - make_interval(secs => GREATEST(1, p_dedup_seconds))
          AND (
              (p_user_id IS NOT NULL AND e.user_id = p_user_id)
              OR (p_viewer_hash IS NOT NULL AND e.viewer_hash = p_viewer_hash)
              OR (
                  p_user_id IS NULL
                  AND p_ip_hash IS NOT NULL
                  AND e.ip_hash = p_ip_hash
              )
          )
        LIMIT 1
    ) THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'recent-view');
    END IF;

    INSERT INTO public.manga_view_events (
        manga_slug,
        chapter_id,
        user_id,
        viewer_hash,
        ip_hash,
        user_agent_hash
    )
    VALUES (
        p_manga_slug,
        NULLIF(p_chapter_id, ''),
        p_user_id,
        NULLIF(p_viewer_hash, ''),
        NULLIF(p_ip_hash, ''),
        NULLIF(p_user_agent_hash, '')
    );

    INSERT INTO public.manga_views (manga_slug, views, updated_at)
    VALUES (p_manga_slug, 1, NOW())
    ON CONFLICT (manga_slug)
    DO UPDATE SET
        views = manga_views.views + 1,
        updated_at = NOW();

    UPDATE public.manga_read_sessions
    SET counted_at = NOW()
    WHERE session_id = v_session_id;

    RETURN jsonb_build_object('ok', true, 'counted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_comment_checked(
    p_user_id UUID,
    p_manga_slug TEXT,
    p_chapter_id TEXT DEFAULT NULL,
    p_parent_id UUID DEFAULT NULL,
    p_content TEXT DEFAULT '',
    p_image_url TEXT DEFAULT NULL,
    p_min_interval_seconds INTEGER DEFAULT 4,
    p_short_window_seconds INTEGER DEFAULT 60,
    p_short_window_limit INTEGER DEFAULT 8,
    p_long_window_seconds INTEGER DEFAULT 3600,
    p_long_window_limit INTEGER DEFAULT 80,
    p_duplicate_window_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_content TEXT := trim(COALESCE(p_content, ''));
    v_image_url TEXT := NULLIF(trim(COALESCE(p_image_url, '')), '');
    v_normalized TEXT := lower(regexp_replace(trim(COALESCE(p_content, '')), '\s+', ' ', 'g'));
    v_last_created TIMESTAMPTZ;
    v_short_count INTEGER := 0;
    v_long_count INTEGER := 0;
    v_duplicate_exists BOOLEAN := FALSE;
    v_comment public.comments%ROWTYPE;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status', 401, 'reason', 'unauthorized');
    END IF;

    IF p_manga_slug IS NULL OR length(trim(p_manga_slug)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'status', 400, 'reason', 'invalid-manga');
    END IF;

    IF v_content = '' AND v_image_url IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status', 400, 'reason', 'empty-comment');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 9001));

    SELECT created_at
    INTO v_last_created
    FROM public.comments
    WHERE user_id = p_user_id
      AND is_deleted = FALSE
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_last_created IS NOT NULL
       AND v_last_created > NOW() - make_interval(secs => GREATEST(1, p_min_interval_seconds)) THEN
        RETURN jsonb_build_object('ok', false, 'status', 429, 'reason', 'cooldown');
    END IF;

    SELECT COUNT(*)
    INTO v_short_count
    FROM public.comments
    WHERE user_id = p_user_id
      AND is_deleted = FALSE
      AND created_at >= NOW() - make_interval(secs => GREATEST(1, p_short_window_seconds));

    IF v_short_count >= GREATEST(1, p_short_window_limit) THEN
        RETURN jsonb_build_object('ok', false, 'status', 429, 'reason', 'minute-limit');
    END IF;

    SELECT COUNT(*)
    INTO v_long_count
    FROM public.comments
    WHERE user_id = p_user_id
      AND is_deleted = FALSE
      AND created_at >= NOW() - make_interval(secs => GREATEST(1, p_long_window_seconds));

    IF v_long_count >= GREATEST(1, p_long_window_limit) THEN
        RETURN jsonb_build_object('ok', false, 'status', 429, 'reason', 'hour-limit');
    END IF;

    IF v_normalized <> '' THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.comments c
            WHERE c.user_id = p_user_id
              AND c.is_deleted = FALSE
              AND c.manga_slug = trim(p_manga_slug)
              AND COALESCE(c.chapter_id, '') = COALESCE(p_chapter_id, '')
              AND COALESCE(c.parent_id::TEXT, '') = COALESCE(p_parent_id::TEXT, '')
              AND c.created_at >= NOW() - make_interval(secs => GREATEST(1, p_duplicate_window_seconds))
              AND lower(regexp_replace(trim(COALESCE(c.content, '')), '\s+', ' ', 'g')) = v_normalized
            LIMIT 1
        )
        INTO v_duplicate_exists;

        IF v_duplicate_exists THEN
            RETURN jsonb_build_object('ok', false, 'status', 429, 'reason', 'duplicate');
        END IF;
    END IF;

    INSERT INTO public.comments (
        user_id,
        manga_slug,
        chapter_id,
        parent_id,
        content,
        image_url
    )
    VALUES (
        p_user_id,
        trim(p_manga_slug),
        NULLIF(p_chapter_id, ''),
        p_parent_id,
        v_content,
        v_image_url
    )
    RETURNING * INTO v_comment;

    UPDATE public.profiles
    SET comments_posted = COALESCE(comments_posted, 0) + 1
    WHERE id = p_user_id;

    RETURN jsonb_build_object('ok', true, 'comment', to_jsonb(v_comment));
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_view_anti_spam_events(
    p_session_retention_days INTEGER DEFAULT 7,
    p_event_retention_days INTEGER DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session_deleted INTEGER := 0;
    v_event_deleted INTEGER := 0;
BEGIN
    DELETE FROM public.manga_read_sessions
    WHERE started_at < NOW() - make_interval(days => GREATEST(1, COALESCE(p_session_retention_days, 7)));
    GET DIAGNOSTICS v_session_deleted = ROW_COUNT;

    DELETE FROM public.manga_view_events
    WHERE created_at < NOW() - make_interval(days => GREATEST(1, COALESCE(p_event_retention_days, 90)));
    GET DIAGNOSTICS v_event_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'sessions_deleted', v_session_deleted,
        'events_deleted', v_event_deleted
    );
END;
$$;

REVOKE ALL ON FUNCTION public.track_manga_view_checked(
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    INTEGER,
    TEXT,
    INTEGER,
    NUMERIC,
    INTEGER,
    INTEGER,
    NUMERIC,
    INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.track_manga_view_checked(
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    INTEGER,
    TEXT,
    INTEGER,
    NUMERIC,
    INTEGER,
    INTEGER,
    NUMERIC,
    INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.start_manga_read_session(
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_manga_read_session(
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.create_comment_checked(
    UUID,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_comment_checked(
    UUID,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER,
    INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_view_anti_spam_events(
    INTEGER,
    INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_view_anti_spam_events(
    INTEGER,
    INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.increment_manga_view(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_manga_view(TEXT) TO service_role;


-- SECTION 18/25: migration_v16_site_settings_maintenance.sql
-- Source SHA-256: 2b5605f35613b45297cd2c2c440a1624e7565184d24a822c1d680aabea82adce

-- ============================================================
-- Migration V16: System settings / maintenance mode
-- Safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'tr_system_settings_updated'
    ) THEN
        CREATE TRIGGER tr_system_settings_updated
            BEFORE UPDATE ON public.system_settings
            FOR EACH ROW
            EXECUTE FUNCTION public.update_updated_at();
    END IF;
END $$;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_settings_no_public_read" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_no_public_write" ON public.system_settings;

REVOKE ALL ON public.system_settings FROM anon;
REVOKE ALL ON public.system_settings FROM authenticated;

INSERT INTO public.system_settings (key, value)
VALUES (
    'maintenance_mode',
    jsonb_build_object(
        'enabled', false,
        'title', 'Website đang bảo trì',
        'message', 'MangaHub đang bảo trì hệ thống. Vui lòng quay lại sau ít phút.'
    )
)
ON CONFLICT (key) DO NOTHING;

UPDATE public.system_settings
SET value = value || jsonb_build_object(
    'image_url', COALESCE(value->'image_url', 'null'::jsonb),
    'starts_at', COALESCE(value->'starts_at', 'null'::jsonb),
    'ends_at', COALESCE(value->'ends_at', 'null'::jsonb)
)
WHERE key = 'maintenance_mode';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'maintenance-images',
    'maintenance-images',
    true,
    8388608,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Maintenance images public read" ON storage.objects;
DROP POLICY IF EXISTS "Scoped read maintenance images" ON storage.objects;
CREATE POLICY "Scoped read maintenance images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Maintenance images admin upload" ON storage.objects;
CREATE POLICY "Maintenance images admin upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Maintenance images admin delete" ON storage.objects;
CREATE POLICY "Maintenance images admin delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);


-- SECTION 19/25: migration_v17_storage_image_mime_fix.sql
-- Source SHA-256: 801858b645a0661ee859d02c600b4cf4cb1d2ae7d9dc6c627c37c92753c46542

-- ============================================================
-- Migration V17: Normalize image bucket MIME allow-lists.
-- Safe to run multiple times.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
WHERE id IN (
    'manga-pages',
    'comment-images',
    'announcement-images',
    'maintenance-images'
);

UPDATE storage.buckets
SET file_size_limit = 8388608
WHERE id IN ('announcement-images', 'maintenance-images')
  AND (file_size_limit IS NULL OR file_size_limit < 8388608);


-- SECTION 20/25: migration_v18_profile_rls_hardening.sql
-- Source SHA-256: 6b401de4bbca555fba985c6f956fc3f6e48d645a6e49c2436178efd31ceb527d

-- ============================================================
-- v18: Harden profile RLS
-- ============================================================
-- The API writes profiles through the backend service-role client.
-- Browser clients must not be able to update sensitive profile columns
-- such as role, vip flags, ban flags, auth revoke timestamps, or stats.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_no_client_update" ON public.profiles;

-- Deny direct profile updates from anon/authenticated clients.
-- service_role bypasses RLS and is the only role expected to update profiles.
CREATE POLICY "profiles_no_client_update"
ON public.profiles
FOR UPDATE
USING (FALSE)
WITH CHECK (FALSE);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO service_role;


-- SECTION 21/25: migration_v19_reading_activity_events.sql
-- Source SHA-256: 5f444aa438fe2db287d538e48e8bc68ace65033969f105afcacdce52ae0e7014

-- Stable reading activity events for weekly chart and streaks.
-- reading_history intentionally stores the latest position per manga, so it
-- cannot be used as a durable per-day activity source.

CREATE TABLE IF NOT EXISTS public.reading_activity_events (
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    manga_slug TEXT NOT NULL,
    chapter_id TEXT NOT NULL DEFAULT '',
    activity_date DATE NOT NULL,
    first_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_count INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, manga_slug, chapter_id, activity_date)
);

CREATE INDEX IF NOT EXISTS idx_reading_activity_events_user_date
ON public.reading_activity_events (user_id, activity_date DESC);

ALTER TABLE public.reading_activity_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reading_activity_select_own" ON public.reading_activity_events;
CREATE POLICY "reading_activity_select_own" ON public.reading_activity_events
FOR SELECT TO authenticated
USING (auth.uid() = user_id);

-- Backend writes through the service role/RPC. Do not expose direct client
-- insert/update policies; otherwise users could forge streaks from the browser.

CREATE OR REPLACE FUNCTION public.record_reading_activity_event(
    p_user_id UUID,
    p_manga_slug TEXT,
    p_chapter_id TEXT,
    p_activity_date DATE,
    p_read_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_manga_slug TEXT := NULLIF(BTRIM(COALESCE(p_manga_slug, '')), '');
    v_chapter_id TEXT := BTRIM(COALESCE(p_chapter_id, ''));
BEGIN
    IF p_user_id IS NULL OR v_manga_slug IS NULL OR p_activity_date IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.reading_activity_events (
        user_id,
        manga_slug,
        chapter_id,
        activity_date,
        first_read_at,
        last_read_at,
        read_count
    )
    VALUES (
        p_user_id,
        v_manga_slug,
        v_chapter_id,
        p_activity_date,
        COALESCE(p_read_at, NOW()),
        COALESCE(p_read_at, NOW()),
        1
    )
    ON CONFLICT (user_id, manga_slug, chapter_id, activity_date)
    DO UPDATE SET
        first_read_at = LEAST(reading_activity_events.first_read_at, EXCLUDED.first_read_at),
        last_read_at = GREATEST(reading_activity_events.last_read_at, EXCLUDED.last_read_at),
        read_count = LEAST(reading_activity_events.read_count + 1, 50),
        updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_reading_activity_event(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_reading_activity_event(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ) TO service_role;

-- Best-effort backfill from the current history table. It cannot recover days
-- that were already overwritten before this migration, but it seeds current data.
INSERT INTO public.reading_activity_events (
    user_id,
    manga_slug,
    chapter_id,
    activity_date,
    first_read_at,
    last_read_at,
    read_count
)
SELECT
    user_id,
    manga_slug,
    COALESCE(chapter_id, ''),
    (read_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE,
    MIN(read_at),
    MAX(read_at),
    COUNT(*)::INTEGER
FROM public.reading_history
WHERE read_at IS NOT NULL
GROUP BY user_id, manga_slug, COALESCE(chapter_id, ''), (read_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE
ON CONFLICT (user_id, manga_slug, chapter_id, activity_date)
DO UPDATE SET
    first_read_at = LEAST(reading_activity_events.first_read_at, EXCLUDED.first_read_at),
    last_read_at = GREATEST(reading_activity_events.last_read_at, EXCLUDED.last_read_at),
    read_count = GREATEST(reading_activity_events.read_count, EXCLUDED.read_count),
    updated_at = NOW();


-- SECTION 22/25: migration_v20_silent_view_tracking.sql
-- Source SHA-256: 72af3349064e592cb25fe34e1372a54d5cdc5c18d6b7cebb0d2b81b68cd1c725

-- ============================================================
-- v20: Persist admin-only silent view tracking
-- ============================================================
-- Admins can read without incrementing view counters. The setting must live in
-- the database so it survives session loss, but non-admin accounts must never
-- be able to enable it through direct API/database writes.

ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS silent_view_tracking BOOLEAN;

ALTER TABLE public.user_settings
ALTER COLUMN silent_view_tracking SET DEFAULT FALSE;

UPDATE public.user_settings
SET silent_view_tracking = FALSE
WHERE silent_view_tracking IS NULL;

UPDATE public.user_settings us
SET silent_view_tracking = FALSE
WHERE COALESCE(us.silent_view_tracking, FALSE) = TRUE
  AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = us.user_id
        AND LOWER(COALESCE(p.role, '')) = 'admin'
  );

ALTER TABLE public.user_settings
ALTER COLUMN silent_view_tracking SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_silent_view_tracking_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
BEGIN
    IF COALESCE(NEW.silent_view_tracking, FALSE) IS TRUE THEN
        SELECT role INTO v_role
        FROM public.profiles
        WHERE id = NEW.user_id;

        IF LOWER(COALESCE(v_role, 'reader')) <> 'admin' THEN
            RAISE EXCEPTION 'silent_view_tracking is admin-only';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_user_settings_silent_view_admin ON public.user_settings;
CREATE TRIGGER tr_user_settings_silent_view_admin
    BEFORE INSERT OR UPDATE OF user_id, silent_view_tracking
    ON public.user_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_silent_view_tracking_admin();

CREATE OR REPLACE FUNCTION public.clear_silent_view_tracking_when_non_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF LOWER(COALESCE(NEW.role, 'reader')) <> 'admin' THEN
        UPDATE public.user_settings
        SET silent_view_tracking = FALSE
        WHERE user_id = NEW.id
          AND COALESCE(silent_view_tracking, FALSE) = TRUE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_profiles_clear_silent_view_tracking ON public.profiles;
CREATE TRIGGER tr_profiles_clear_silent_view_tracking
    AFTER INSERT OR UPDATE OF role
    ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.clear_silent_view_tracking_when_non_admin();


-- SECTION 23/25: migration_v21_upload_group_security.sql
-- Source SHA-256: c78b7eca214c1132884db1410c5ba68919e19202b189a83f5cd94a4fb096d669

-- ============================================================
-- v21: Harden upload moderation and scanlation group membership
-- ============================================================
-- Public/authenticated Supabase clients must not be able to join arbitrary
-- groups or publish uploads directly. The FastAPI moderation/group routes use
-- the service role after checking the caller's role and ownership.

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_members_insert_member" ON public.group_members;
REVOKE INSERT ON TABLE public.group_members FROM PUBLIC, anon, authenticated;

ALTER TABLE public.chapter_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uploads_insert_own" ON public.chapter_uploads;
CREATE POLICY "uploads_insert_own" ON public.chapter_uploads
    FOR INSERT WITH CHECK (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending')
    );

DROP POLICY IF EXISTS "uploads_update_own" ON public.chapter_uploads;
CREATE POLICY "uploads_update_own" ON public.chapter_uploads
    FOR UPDATE
    USING (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending', 'rejected')
    )
    WITH CHECK (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending')
    );

DROP POLICY IF EXISTS "uploads_delete_own" ON public.chapter_uploads;
CREATE POLICY "uploads_delete_own" ON public.chapter_uploads
    FOR DELETE USING (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending', 'rejected')
    );

ALTER TABLE public.manga_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manga_uploads_insert_own" ON public.manga_uploads;
CREATE POLICY "manga_uploads_insert_own" ON public.manga_uploads
    FOR INSERT WITH CHECK (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending')
    );

DROP POLICY IF EXISTS "manga_uploads_update_own" ON public.manga_uploads;
CREATE POLICY "manga_uploads_update_own" ON public.manga_uploads
    FOR UPDATE
    USING (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending', 'rejected')
    )
    WITH CHECK (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending')
    );

DROP POLICY IF EXISTS "manga_uploads_delete_own" ON public.manga_uploads;
CREATE POLICY "manga_uploads_delete_own" ON public.manga_uploads
    FOR DELETE USING (
        uploader_id = auth.uid()
        AND status IN ('draft', 'pending', 'rejected')
    );



-- SECTION 24/25: migration_v22_reading_history_chapter_text.sql
-- Source SHA-256: af1740b2b416adcb1b5a71a13fac36e9d391b9523dff02f148620bb621e989db

-- QQ chapter tokens include the complete source slug and can exceed 100 characters.
-- Preserve the full token so resume links still identify the exact comic/chapter.
-- This only widens column types; rows, constraints, RLS and policies stay intact.

ALTER TABLE public.reading_history
    ALTER COLUMN chapter_id TYPE TEXT,
    ALTER COLUMN chapter_name TYPE TEXT;

SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reading_history'
  AND column_name IN ('chapter_id', 'chapter_name');


-- SECTION 25/25: migration_v22_view_proxy_rls_security.sql
-- Source SHA-256: c8367752e10436b72576a0b7b69630eee5780100c197eeb1ab2d1f129c567310

-- ============================================================
-- v22: View integrity and backend-only mutation security
-- ============================================================
-- Run after migration_v15 and migration_v21. Safe to run repeatedly.

CREATE INDEX IF NOT EXISTS idx_manga_view_events_manga_viewer_recent
ON public.manga_view_events (manga_slug, viewer_hash, created_at DESC)
WHERE viewer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manga_view_events_manga_ip_recent
ON public.manga_view_events (manga_slug, ip_hash, created_at DESC)
WHERE ip_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.track_manga_view_checked(
    p_manga_slug TEXT,
    p_chapter_id TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_viewer_hash TEXT DEFAULT NULL,
    p_ip_hash TEXT DEFAULT NULL,
    p_user_agent_hash TEXT DEFAULT NULL,
    p_dedup_seconds INTEGER DEFAULT 900,
    p_session_id TEXT DEFAULT NULL,
    p_elapsed_seconds INTEGER DEFAULT 0,
    p_progress NUMERIC DEFAULT 0,
    p_page_seen INTEGER DEFAULT 0,
    p_min_elapsed_seconds INTEGER DEFAULT 12,
    p_min_progress NUMERIC DEFAULT 15,
    p_min_page_seen INTEGER DEFAULT 2
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session public.manga_read_sessions%ROWTYPE;
    v_session_id TEXT := NULLIF(BTRIM(COALESCE(p_session_id, '')), '');
    v_viewer_hash TEXT := NULLIF(BTRIM(COALESCE(p_viewer_hash, '')), '');
    v_manga_slug TEXT := NULLIF(BTRIM(COALESCE(p_manga_slug, '')), '');
    v_actual_elapsed INTEGER := 0;
    v_progress NUMERIC := LEAST(100, GREATEST(0, COALESCE(p_progress, 0)));
    v_page_seen INTEGER := GREATEST(0, COALESCE(p_page_seen, 0));
BEGIN
    IF v_manga_slug IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'counted', false, 'reason', 'invalid-manga');
    END IF;

    IF v_session_id IS NULL OR v_viewer_hash IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'missing-read-session');
    END IF;

    SELECT *
    INTO v_session
    FROM public.manga_read_sessions
    WHERE session_id = v_session_id
      AND manga_slug = v_manga_slug
      AND COALESCE(chapter_id, '') = COALESCE(p_chapter_id, '')
      AND viewer_hash = v_viewer_hash
      AND (user_id IS NULL OR user_id = p_user_id)
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-not-started');
    END IF;

    IF v_session.started_at < NOW() - INTERVAL '6 hours' THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-expired');
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(v_manga_slug || ':' || v_viewer_hash, 0)
    );

    v_actual_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - v_session.started_at)))::INTEGER);
    v_progress := GREATEST(v_progress, COALESCE(v_session.max_progress, 0));
    v_page_seen := GREATEST(v_page_seen, COALESCE(v_session.max_page_seen, 0));

    UPDATE public.manga_read_sessions
    SET
        last_seen_at = NOW(),
        max_progress = v_progress,
        max_page_seen = v_page_seen,
        user_id = COALESCE(manga_read_sessions.user_id, p_user_id)
    WHERE session_id = v_session_id;

    IF v_session.counted_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'session-already-counted');
    END IF;

    IF v_actual_elapsed < GREATEST(1, p_min_elapsed_seconds) THEN
        RETURN jsonb_build_object(
            'ok', true,
            'counted', false,
            'reason', 'too-short',
            'elapsed', v_actual_elapsed
        );
    END IF;

    IF v_progress < p_min_progress AND v_page_seen < p_min_page_seen THEN
        RETURN jsonb_build_object(
            'ok', true,
            'counted', false,
            'reason', 'not-enough-progress',
            'progress', v_progress,
            'page_seen', v_page_seen
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.manga_view_events e
        WHERE e.manga_slug = v_manga_slug
          AND e.created_at >= NOW() - make_interval(secs => GREATEST(1, p_dedup_seconds))
          AND (
              (p_user_id IS NOT NULL AND e.user_id = p_user_id)
              OR (e.viewer_hash = v_viewer_hash)
              OR (
                  p_user_id IS NULL
                  AND p_ip_hash IS NOT NULL
                  AND e.ip_hash = p_ip_hash
              )
          )
        LIMIT 1
    ) THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'reason', 'recent-view');
    END IF;

    INSERT INTO public.manga_view_events (
        manga_slug,
        chapter_id,
        user_id,
        viewer_hash,
        ip_hash,
        user_agent_hash
    )
    VALUES (
        v_manga_slug,
        NULLIF(p_chapter_id, ''),
        p_user_id,
        v_viewer_hash,
        NULLIF(p_ip_hash, ''),
        NULLIF(p_user_agent_hash, '')
    );

    INSERT INTO public.manga_views (manga_slug, views, updated_at)
    VALUES (v_manga_slug, 1, NOW())
    ON CONFLICT (manga_slug)
    DO UPDATE SET
        views = manga_views.views + 1,
        updated_at = NOW();

    UPDATE public.manga_read_sessions
    SET counted_at = NOW()
    WHERE session_id = v_session_id;

    RETURN jsonb_build_object('ok', true, 'counted', true);
END;
$$;

-- SECURITY DEFINER and view mutation RPCs are backend-only.
REVOKE ALL ON FUNCTION public.track_manga_view_checked(
    TEXT, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT,
    INTEGER, NUMERIC, INTEGER, INTEGER, NUMERIC, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.track_manga_view_checked(
    TEXT, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT,
    INTEGER, NUMERIC, INTEGER, INTEGER, NUMERIC, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.start_manga_read_session(
    TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_manga_read_session(
    TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.create_comment_checked(
    UUID, TEXT, TEXT, UUID, TEXT, TEXT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_comment_checked(
    UUID, TEXT, TEXT, UUID, TEXT, TEXT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_view_anti_spam_events(INTEGER, INTEGER)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_view_anti_spam_events(INTEGER, INTEGER)
TO service_role;

REVOKE ALL ON FUNCTION public.increment_manga_view(TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_manga_view(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.record_reading_activity_event(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reading_activity_event(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ)
TO service_role;

REVOKE ALL ON FUNCTION public.get_admin_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_stats() TO service_role;

-- These resources are mutated only through FastAPI using the service role.
-- Public reads remain controlled by the existing SELECT policies.
DROP POLICY IF EXISTS "comments_insert_auth" ON public.comments;
DROP POLICY IF EXISTS "comments_update_own" ON public.comments;
DROP POLICY IF EXISTS "comments_delete_own" ON public.comments;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.comments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.comments TO service_role;

DROP POLICY IF EXISTS "likes_insert_own" ON public.comment_likes;
DROP POLICY IF EXISTS "likes_delete_own" ON public.comment_likes;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.comment_likes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.comment_likes TO service_role;

DROP POLICY IF EXISTS "reactions_insert_own" ON public.comment_reactions;
DROP POLICY IF EXISTS "reactions_update_own" ON public.comment_reactions;
DROP POLICY IF EXISTS "reactions_delete_own" ON public.comment_reactions;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.comment_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.comment_reactions TO service_role;

DROP POLICY IF EXISTS "reports_insert_auth" ON public.reports;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reports TO service_role;

DROP POLICY IF EXISTS "groups_insert_auth" ON public.scanlation_groups;
DROP POLICY IF EXISTS "groups_update_owner" ON public.scanlation_groups;
DROP POLICY IF EXISTS "groups_delete_owner" ON public.scanlation_groups;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.scanlation_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scanlation_groups TO service_role;

DROP POLICY IF EXISTS "group_members_insert_member" ON public.group_members;
DROP POLICY IF EXISTS "group_members_delete_own" ON public.group_members;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.group_members FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role;

DROP POLICY IF EXISTS "uploads_insert_own" ON public.chapter_uploads;
DROP POLICY IF EXISTS "uploads_update_own" ON public.chapter_uploads;
DROP POLICY IF EXISTS "uploads_delete_own" ON public.chapter_uploads;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.chapter_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chapter_uploads TO service_role;

DROP POLICY IF EXISTS "manga_uploads_insert_own" ON public.manga_uploads;
DROP POLICY IF EXISTS "manga_uploads_update_own" ON public.manga_uploads;
DROP POLICY IF EXISTS "manga_uploads_delete_own" ON public.manga_uploads;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.manga_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manga_uploads TO service_role;


-- Refresh Supabase REST metadata after the complete setup commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
