-- QQ chapter tokens include the complete source slug and can exceed 100 characters.
-- Preserve the full token so resume links still identify the exact comic/chapter.
-- This only widens column types; rows, constraints, RLS and policies stay intact.
BEGIN;
ALTER TABLE public.reading_history
    ALTER COLUMN chapter_id TYPE TEXT,
    ALTER COLUMN chapter_name TYPE TEXT;
COMMIT;

SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reading_history'
  AND column_name IN ('chapter_id', 'chapter_name');
