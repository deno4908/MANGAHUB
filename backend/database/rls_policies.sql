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

-- Authenticated users can insert
DROP POLICY IF EXISTS "comments_insert_auth" ON comments;
CREATE POLICY "comments_insert_auth" ON comments
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update/delete own comments
DROP POLICY IF EXISTS "comments_update_own" ON comments;
CREATE POLICY "comments_update_own" ON comments
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "comments_delete_own" ON comments;
CREATE POLICY "comments_delete_own" ON comments
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- COMMENT LIKES
-- ============================================================
DROP POLICY IF EXISTS "likes_select_all" ON comment_likes;
CREATE POLICY "likes_select_all" ON comment_likes
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "likes_insert_own" ON comment_likes;
CREATE POLICY "likes_insert_own" ON comment_likes
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "likes_delete_own" ON comment_likes;
CREATE POLICY "likes_delete_own" ON comment_likes
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- COMMENT REACTIONS
-- ============================================================
DROP POLICY IF EXISTS "reactions_select_all" ON comment_reactions;
CREATE POLICY "reactions_select_all" ON comment_reactions
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "reactions_insert_own" ON comment_reactions;
CREATE POLICY "reactions_insert_own" ON comment_reactions
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "reactions_update_own" ON comment_reactions;
CREATE POLICY "reactions_update_own" ON comment_reactions
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "reactions_delete_own" ON comment_reactions;
CREATE POLICY "reactions_delete_own" ON comment_reactions
    FOR DELETE USING (user_id = auth.uid());

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
CREATE POLICY "reports_insert_auth" ON reports
    FOR INSERT WITH CHECK (reporter_id = auth.uid());

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
CREATE POLICY "groups_insert_auth" ON scanlation_groups
    FOR INSERT WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "groups_update_owner" ON scanlation_groups;
CREATE POLICY "groups_update_owner" ON scanlation_groups
    FOR UPDATE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "groups_delete_owner" ON scanlation_groups;
CREATE POLICY "groups_delete_owner" ON scanlation_groups
    FOR DELETE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "group_members_select_all" ON group_members;
CREATE POLICY "group_members_select_all" ON group_members
    FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "group_members_insert_member" ON group_members;
CREATE POLICY "group_members_insert_member" ON group_members
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "group_members_delete_own" ON group_members;
CREATE POLICY "group_members_delete_own" ON group_members
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- CHAPTER UPLOADS (owner read/write, public read published)
-- ============================================================
ALTER TABLE chapter_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uploads_select_own_or_published" ON chapter_uploads;
CREATE POLICY "uploads_select_own_or_published" ON chapter_uploads
    FOR SELECT USING (uploader_id = auth.uid() OR status = 'published');

DROP POLICY IF EXISTS "uploads_insert_own" ON chapter_uploads;
CREATE POLICY "uploads_insert_own" ON chapter_uploads
    FOR INSERT WITH CHECK (uploader_id = auth.uid());

DROP POLICY IF EXISTS "uploads_update_own" ON chapter_uploads;
CREATE POLICY "uploads_update_own" ON chapter_uploads
    FOR UPDATE USING (uploader_id = auth.uid());

DROP POLICY IF EXISTS "uploads_delete_own" ON chapter_uploads;
CREATE POLICY "uploads_delete_own" ON chapter_uploads
    FOR DELETE USING (uploader_id = auth.uid());

-- ============================================================
-- MANGA UPLOADS
-- ============================================================
ALTER TABLE manga_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manga_uploads_select_own_or_published" ON manga_uploads;
CREATE POLICY "manga_uploads_select_own_or_published" ON manga_uploads
    FOR SELECT USING (uploader_id = auth.uid() OR status = 'published');

DROP POLICY IF EXISTS "manga_uploads_insert_own" ON manga_uploads;
CREATE POLICY "manga_uploads_insert_own" ON manga_uploads
    FOR INSERT WITH CHECK (uploader_id = auth.uid());

DROP POLICY IF EXISTS "manga_uploads_update_own" ON manga_uploads;
CREATE POLICY "manga_uploads_update_own" ON manga_uploads
    FOR UPDATE USING (uploader_id = auth.uid());

DROP POLICY IF EXISTS "manga_uploads_delete_own" ON manga_uploads;
CREATE POLICY "manga_uploads_delete_own" ON manga_uploads
    FOR DELETE USING (uploader_id = auth.uid());

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
