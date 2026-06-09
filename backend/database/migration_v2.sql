-- ============================================================
-- Migration V2: Uploads, Groups, Audit Log
-- ============================================================

-- 11. SCANLATION GROUPS
CREATE TABLE IF NOT EXISTS scanlation_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    logo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    total_uploads INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. GROUP MEMBERS
CREATE TABLE IF NOT EXISTS group_members (
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner','admin','uploader','member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- 13. CHAPTER UPLOADS
CREATE TABLE IF NOT EXISTS chapter_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    uploader_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    group_id UUID REFERENCES scanlation_groups(id) ON DELETE SET NULL,
    manga_slug VARCHAR(255) NOT NULL,
    manga_title VARCHAR(500) DEFAULT '',
    chapter_number INTEGER NOT NULL,
    chapter_title VARCHAR(255) DEFAULT '',
    language VARCHAR(10) DEFAULT 'vi',
    pages JSONB DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'draft'
        CHECK (status IN ('draft','pending','published','rejected')),
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    admin_name VARCHAR(100) DEFAULT '',
    action VARCHAR(100) NOT NULL,
    target VARCHAR(500) DEFAULT '',
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_uploads_uploader ON chapter_uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON chapter_uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_group ON chapter_uploads(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC);

-- Trigger
CREATE TRIGGER tr_uploads_updated
    BEFORE UPDATE ON chapter_uploads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
