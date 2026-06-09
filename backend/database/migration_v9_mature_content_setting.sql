-- ============================================================
-- Migration V9: Mature content visibility setting
-- ============================================================

ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS show_mature_content BOOLEAN DEFAULT FALSE;

UPDATE user_settings
SET show_mature_content = FALSE
WHERE show_mature_content IS NULL;
