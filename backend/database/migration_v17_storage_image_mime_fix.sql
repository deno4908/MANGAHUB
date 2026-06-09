-- ============================================================
-- Migration V17: Normalize image bucket MIME allow-lists.
-- Safe to run multiple times.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
WHERE id IN (
    'manga-pages',
    'comment-images',
    'announcement-images',
    'maintenance-images'
);

UPDATE storage.buckets
SET file_size_limit = 8388608
WHERE id IN ('announcement-images', 'maintenance-images')
  AND (file_size_limit IS NULL OR file_size_limit < 8388608);

