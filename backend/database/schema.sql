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
    chapter_id VARCHAR(100) NOT NULL,       -- OTruyen chapter _id
    chapter_name VARCHAR(100) DEFAULT '',   -- e.g. "671"
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
