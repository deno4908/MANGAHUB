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
