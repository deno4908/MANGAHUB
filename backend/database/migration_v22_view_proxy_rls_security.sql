-- ============================================================
-- v22: View integrity and backend-only mutation security
-- ============================================================
-- Run after migration_v15 and migration_v21. Safe to run repeatedly.

BEGIN;

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

COMMIT;
