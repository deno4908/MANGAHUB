-- ============================================================
-- Migration V8: Manga Overrides (Admin Control)
-- ============================================================
-- Allows admins to hide/feature/annotate any manga (including
-- external OTruyen/MangaDex slugs) without modifying the source.
-- Run this in Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS manga_overrides (
    manga_slug  TEXT PRIMARY KEY,
    is_hidden   BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_reason TEXT,
    hidden_at   TIMESTAMPTZ,
    hidden_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    featured_at TIMESTAMPTZ,
    featured_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    admin_notes TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manga_overrides_hidden   ON manga_overrides(is_hidden);
CREATE INDEX IF NOT EXISTS idx_manga_overrides_featured ON manga_overrides(is_featured);

-- Auto-update updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_manga_overrides_updated'
    ) THEN
        CREATE TRIGGER tr_manga_overrides_updated
            BEFORE UPDATE ON manga_overrides
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

-- RLS: only admins can read/write overrides
ALTER TABLE manga_overrides ENABLE ROW LEVEL SECURITY;

-- Service role (backend) bypasses RLS
-- Public read for is_hidden check (needed by manga router)
DROP POLICY IF EXISTS "manga_overrides_public_read" ON manga_overrides;
CREATE POLICY "manga_overrides_public_read"
    ON manga_overrides FOR SELECT
    USING (true);

-- Only service role can write (done via backend with service key)
