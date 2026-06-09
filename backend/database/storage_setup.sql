-- ============================================================
-- Supabase Storage: Manga Chapter Images Bucket
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Create public bucket for manga pages
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'manga-pages',
    'manga-pages',
    true,
    10485760,  -- 10MB per file (configurable via site_settings)
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- 1b. Site settings table (admin can change max upload size)
CREATE TABLE IF NOT EXISTS site_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO site_settings (key, value)
VALUES ('max_upload_size_mb', '10')
ON CONFLICT (key) DO NOTHING;

-- 2. Allow authenticated users with uploader+ role to upload
CREATE POLICY "Uploaders can upload manga pages"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'manga-pages'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('uploader', 'moderator', 'admin')
        AND NOT is_banned
    )
);

-- 3. Anyone can view (public bucket)
CREATE POLICY "Anyone can view manga pages"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'manga-pages');

-- 4. Uploaders can delete their own uploads, admins can delete any
CREATE POLICY "Uploaders can delete own manga pages"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'manga-pages'
    AND (
        auth.uid()::text = (storage.foldername(name))[2]
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
            AND role IN ('moderator', 'admin')
        )
    )
);
