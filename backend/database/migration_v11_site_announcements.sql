-- ============================================================
-- Migration V11: Public site announcements / home popup
-- Safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS site_announcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    announcement_type VARCHAR(30) NOT NULL DEFAULT 'system'
        CHECK (announcement_type IN ('system', 'maintenance', 'event', 'warning')),
    target VARCHAR(30) NOT NULL DEFAULT 'all',
    show_popup BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_announcements_active
    ON site_announcements (is_active, show_popup, target, starts_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_site_announcements_created_at
    ON site_announcements (created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'tr_site_announcements_updated'
    ) THEN
        CREATE TRIGGER tr_site_announcements_updated
            BEFORE UPDATE ON site_announcements
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

ALTER TABLE site_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_announcements_public_active_read" ON site_announcements;
CREATE POLICY "site_announcements_public_active_read"
    ON site_announcements FOR SELECT
    USING (
        is_active = TRUE
        AND show_popup = TRUE
        AND target = 'all'
        AND starts_at <= NOW()
        AND expires_at > NOW()
    );
