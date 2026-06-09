-- ============================================================
-- Migration V16: System settings / maintenance mode
-- Safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'tr_system_settings_updated'
    ) THEN
        CREATE TRIGGER tr_system_settings_updated
            BEFORE UPDATE ON public.system_settings
            FOR EACH ROW
            EXECUTE FUNCTION public.update_updated_at();
    END IF;
END $$;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_settings_no_public_read" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_no_public_write" ON public.system_settings;

REVOKE ALL ON public.system_settings FROM anon;
REVOKE ALL ON public.system_settings FROM authenticated;

INSERT INTO public.system_settings (key, value)
VALUES (
    'maintenance_mode',
    jsonb_build_object(
        'enabled', false,
        'title', 'Website đang bảo trì',
        'message', 'MangaHub đang bảo trì hệ thống. Vui lòng quay lại sau ít phút.'
    )
)
ON CONFLICT (key) DO NOTHING;

UPDATE public.system_settings
SET value = value || jsonb_build_object(
    'image_url', COALESCE(value->'image_url', 'null'::jsonb),
    'starts_at', COALESCE(value->'starts_at', 'null'::jsonb),
    'ends_at', COALESCE(value->'ends_at', 'null'::jsonb)
)
WHERE key = 'maintenance_mode';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'maintenance-images',
    'maintenance-images',
    true,
    8388608,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Maintenance images public read" ON storage.objects;
DROP POLICY IF EXISTS "Scoped read maintenance images" ON storage.objects;
CREATE POLICY "Scoped read maintenance images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Maintenance images admin upload" ON storage.objects;
CREATE POLICY "Maintenance images admin upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

DROP POLICY IF EXISTS "Maintenance images admin delete" ON storage.objects;
CREATE POLICY "Maintenance images admin delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
    bucket_id = 'maintenance-images'
    AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);
