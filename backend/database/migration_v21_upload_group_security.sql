-- ============================================================
-- v21: Harden upload moderation and scanlation group membership
-- ============================================================
-- Public/authenticated Supabase clients must not be able to join arbitrary
-- groups or publish uploads directly. The FastAPI moderation/group routes use
-- the service role after checking the caller's role and ownership.

BEGIN;

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

COMMIT;
