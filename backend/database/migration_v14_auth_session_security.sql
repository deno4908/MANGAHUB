-- Auth session security metadata.
-- Required for backend-side invalidation of already-issued access JWTs.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS session_revoked_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_session_revoked_at
ON public.profiles(session_revoked_at);

CREATE INDEX IF NOT EXISTS idx_profiles_password_changed_at
ON public.profiles(password_changed_at);
