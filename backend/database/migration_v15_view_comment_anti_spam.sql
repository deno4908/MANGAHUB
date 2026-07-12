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
