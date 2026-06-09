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
