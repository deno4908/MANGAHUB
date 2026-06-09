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
