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
