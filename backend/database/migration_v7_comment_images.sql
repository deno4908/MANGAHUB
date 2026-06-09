ALTER TABLE comments
ADD COLUMN IF NOT EXISTS image_url TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'comment-images',
    'comment-images',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Comment images public read" ON storage.objects;
CREATE POLICY "Comment images public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'comment-images');

DROP POLICY IF EXISTS "Comment images authenticated upload" ON storage.objects;
CREATE POLICY "Comment images authenticated upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'comment-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND NOT is_banned
    )
);

DROP POLICY IF EXISTS "Comment images owner delete" ON storage.objects;
CREATE POLICY "Comment images owner delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'comment-images'
    AND owner = auth.uid()
);
