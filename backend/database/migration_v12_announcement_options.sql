-- ============================================================
-- Migration V12: Rich site announcement options
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE site_announcements
    ADD COLUMN IF NOT EXISTS image_url TEXT,
    ADD COLUMN IF NOT EXISTS cta_label VARCHAR(80),
    ADD COLUMN IF NOT EXISTS cta_url TEXT,
    ADD COLUMN IF NOT EXISTS popup_size VARCHAR(20) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS popup_dismissible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'site_announcements_popup_size_check'
    ) THEN
        ALTER TABLE site_announcements
            ADD CONSTRAINT site_announcements_popup_size_check
            CHECK (popup_size IN ('compact', 'standard', 'wide'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_site_announcements_priority
    ON site_announcements (priority DESC, created_at DESC);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'announcement-images',
    'announcement-images',
    true,
    8388608,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Announcement images public read" ON storage.objects;
CREATE POLICY "Announcement images public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'announcement-images');

DROP POLICY IF EXISTS "Announcement images admin upload" ON storage.objects;
CREATE POLICY "Announcement images admin upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Announcement images admin delete" ON storage.objects;
CREATE POLICY "Announcement images admin delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'announcement-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);
