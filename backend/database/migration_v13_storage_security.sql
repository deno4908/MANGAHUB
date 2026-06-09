-- ============================================================
-- Migration v13: Fix storage security - restrict file listing
-- Run this in Supabase SQL Editor
-- Safe to run multiple times.
-- ============================================================
-- Problem: Broad SELECT policies on storage.objects with TO public
-- allow ANY client to enumerate ALL files in these buckets:
--   1. manga-pages
--   2. comment-images
--   3. announcement-images
--
-- Since all 3 buckets are public, files are already accessible
-- via their public URLs. The SELECT policy only controls the
-- storage LIST API — we should restrict it.
-- ============================================================

-- ── 1. manga-pages ──────────────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Anyone can view manga pages" ON storage.objects;

-- Replace: uploaders see own folder, admins/mods see all
DROP POLICY IF EXISTS "Scoped read manga pages" ON storage.objects;
CREATE POLICY "Scoped read manga pages"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'manga-pages'
    AND (
        -- Uploaders can list their own upload folder
        -- Path: {manga_slug}/{chapter_number}/{uploader_id}/page.ext
        (storage.foldername(name))[3] = auth.uid()::text
        OR
        -- Admins and moderators can list any files
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);

-- ── 2. comment-images ───────────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Comment images public read" ON storage.objects;

-- Replace: users see own comment images, admins see all
DROP POLICY IF EXISTS "Scoped read comment images" ON storage.objects;
CREATE POLICY "Scoped read comment images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'comment-images'
    AND (
        -- Owner can see their own uploads
        owner = auth.uid()
        OR
        -- Admins and moderators can see all
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);

-- ── 3. announcement-images ──────────────────────────────────
-- Drop the broad public SELECT
DROP POLICY IF EXISTS "Announcement images public read" ON storage.objects;

-- Replace: only admins can list announcement images
DROP POLICY IF EXISTS "Scoped read announcement images" ON storage.objects;
CREATE POLICY "Scoped read announcement images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- ============================================================
-- Note: Public bucket files remain accessible via public URLs
-- (e.g. https://xxx.supabase.co/storage/v1/object/public/bucket/path)
-- These policies ONLY restrict the storage.objects LIST/SELECT API,
-- preventing clients from enumerating all files in the buckets.
-- ============================================================
