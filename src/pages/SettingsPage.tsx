import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettingsStore } from '@/store/settingsStore';
import { useThemeStore, type AccentColor } from '@/store/themeStore';
import { useUserStore } from '@/store/userStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User, BookOpen, Bell, Shield, Eye, Lock, Trash2, Save,
  Smartphone, Columns, AlignVerticalSpaceAround, Monitor,
  ChevronRight, AlertTriangle, LogOut, Check, Palette, Moon, Sun,
  Settings as SettingsIcon, Globe, LockKeyhole, ExternalLink
} from 'lucide-react';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import { NewPasswordFields, usePasswordAssessment } from '@/components/security/NewPasswordFields';
import { passwordStrengthError } from '@/lib/passwordPolicy';

type SettingsSection = 'account' | 'reader' | 'notifications' | 'privacy' | 'security' | 'appearance' | 'danger';

const SettingsPage = () => {
  const [section, setSection] = useState<SettingsSection>('account');
  const { user } = useUserStore();
  const isMobile = useIsMobile();
  const loadSettings = useSettingsStore(s => s.loadSettings);
  useEffect(() => { loadSettings(); }, []);

  if (!user) {
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <Lock className="w-8 h-8 text-muted-foreground" />
        <p className="text-muted-foreground font-medium text-lg">Vui lòng đăng nhập để truy cập cài đặt.</p>
      </div>
    );
  }

  const sections: { key: SettingsSection; label: string; icon: any; description: string; danger?: boolean }[] = [
    { key: 'account', label: 'Tài khoản', icon: User, description: 'Thông tin cá nhân' },
    { key: 'reader', label: 'Trình đọc', icon: BookOpen, description: 'Tùy chỉnh đọc truyện' },
    { key: 'notifications', label: 'Thông báo', icon: Bell, description: 'Quản lý thông báo' },
    { key: 'privacy', label: 'Quyền riêng tư', icon: Eye, description: 'Ai có thể thấy' },
    { key: 'appearance', label: 'Giao diện', icon: Palette, description: 'Tuỳ chỉnh hiển thị' },
    { key: 'security', label: 'Bảo mật', icon: Shield, description: 'Mật khẩu & phiên' },
    { key: 'danger', label: 'Vùng nguy hiểm', icon: AlertTriangle, description: 'Xoá tài khoản', danger: true },
  ];

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-comic tracking-wide mb-6 text-gradient flex items-center gap-2"><SettingsIcon className="w-6 h-6" /> Cài Đặt</h1>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Sidebar */}
          <div className="md:w-56 shrink-0">
            <div className="bg-card rounded-xl border border-border/50 p-1.5 md:sticky md:top-20">
              {isMobile ? (
                /* Mobile: horizontal scroll */
                <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                  {sections.map(s => (
                    <button
                      key={s.key}
                      onClick={() => setSection(s.key)}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                        section === s.key
                          ? s.danger ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <s.icon className="w-3.5 h-3.5 shrink-0" />
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : (
                /* Desktop: vertical list */
                sections.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setSection(s.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left ${
                      section === s.key
                        ? s.danger ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                        : s.danger ? 'text-destructive/60 hover:text-destructive hover:bg-destructive/5' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                    }`}
                  >
                    <s.icon className="w-4 h-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-bold text-xs">{s.label}</p>
                      <p className="text-[10px] opacity-60 hidden lg:block">{s.description}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <AnimatePresence mode="wait">
              <motion.div key={section} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }}>
                {section === 'account' && <AccountSection />}
                {section === 'reader' && <ReaderSection />}
                {section === 'notifications' && <NotificationsSection />}
                {section === 'privacy' && <PrivacySection />}
                {section === 'appearance' && <AppearanceSection />}
                {section === 'security' && <SecuritySection />}
                {section === 'danger' && <DangerSection />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

/* === Shared Components === */
const SectionCard = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <div className="bg-card rounded-xl border border-border/50 p-5 mb-4">
    <h3 className="text-sm font-bold mb-1 text-foreground">{title}</h3>
    {description && <p className="text-xs text-muted-foreground mb-4">{description}</p>}
    {!description && <div className="mb-4" />}
    {children}
  </div>
);

const ToggleSwitch = ({ checked, onChange, label, description }: { checked: boolean; onChange: () => void; label: string; description?: string }) => (
  <div className="flex items-center justify-between py-3 border-b border-border/20 last:border-0">
    <div>
      <p className="text-sm font-medium">{label}</p>
      {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
    </div>
    <button
      onClick={onChange}
      className={`w-11 h-6 rounded-full transition-all relative shrink-0 ${checked ? 'bg-primary' : 'bg-secondary border border-border'}`}
    >
      <div className={`w-5 h-5 rounded-full bg-primary-foreground shadow-sm absolute top-0.5 transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  </div>
);

const OptionGroup = ({ options, value, onChange }: { options: { value: string; label: string; icon?: any }[]; value: string; onChange: (v: any) => void }) => (
  <div className="flex flex-wrap gap-2">
    {options.map(o => (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
          value === o.value ? 'bg-primary text-primary-foreground' : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
        }`}
      >
        {o.icon && <o.icon className="w-4 h-4" />}
        {o.label}
      </button>
    ))}
  </div>
);

const InputField = ({ label, value, onChange, type = 'text', readonly = false, rows }: { label: string; value: string; onChange: (v: string) => void; type?: string; readonly?: boolean; rows?: number }) => (
  <div>
    <label className="text-xs font-bold text-muted-foreground mb-1 block">{label}</label>
    {rows ? (
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} readOnly={readonly}
        className="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:border-primary/50 resize-none" />
    ) : (
      <input type={type} value={value} onChange={e => onChange(e.target.value)} readOnly={readonly}
        className={`w-full px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:border-primary/50 ${readonly ? 'opacity-60 cursor-not-allowed' : ''}`} />
    )}
  </div>
);

/* === Sections === */
const AccountSection = () => {
  const { updateAccount, settings } = useSettingsStore();
  const { user, updateProfile, uploadAvatar } = useUserStore();
  const [form, setForm] = useState({
    username: user?.username || '',
    displayName: user?.displayName || '',
    bio: user?.bio || '',
    email: user?.email || settings.account.email || '',
  });
  const [avatar, setAvatar] = useState<string | null>(user?.avatar || null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = () => {
    updateAccount(form);
    updateProfile({ displayName: form.displayName, bio: form.bio });
    toast.success('Đã lưu thông tin tài khoản!');
  };

  useEffect(() => {
    setAvatar(user?.avatar || null);
  }, [user?.avatar]);

  useEffect(() => {
    setForm({
      username: user?.username || '',
      displayName: user?.displayName || '',
      bio: user?.bio || '',
      email: user?.email || settings.account.email || '',
    });
  }, [user?.username, user?.displayName, user?.bio, user?.email, settings.account.email]);

  const handleFile = async (file: File) => {
    if (!file.type.match(/image\/(png|jpe?g|webp|gif)/)) {
      toast.error('Chỉ hỗ trợ PNG, JPG, WEBP hoặc GIF');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Ảnh vượt quá 5MB');
      return;
    }

    setIsUploadingAvatar(true);
    try {
      const res = await uploadAvatar(file);
      if (!res.success || !res.avatarUrl) {
        toast.error(res.error || 'Không thể cập nhật ảnh đại diện');
        return;
      }
      setAvatar(res.avatarUrl);
      toast.success('Đã cập nhật ảnh đại diện!');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  return (
    <>
      <SectionCard title="Thông tin cá nhân" description="Chỉnh sửa thông tin hiển thị trên hồ sơ">
        <div className="space-y-4">
          <InputField label="Tên người dùng" value={form.username} onChange={v => setForm({ ...form, username: v })} />
          <InputField label="Tên hiển thị" value={form.displayName} onChange={v => setForm({ ...form, displayName: v })} />
          <InputField label="Email" value={form.email} onChange={() => {}} type="email" readonly />
          <InputField label="Giới thiệu" value={form.bio} onChange={v => setForm({ ...form, bio: v })} rows={3} />
          <button onClick={handleSave} className="px-5 py-2.5 rounded-xl manga-gradient text-primary-foreground text-sm font-bold flex items-center gap-2 hover:opacity-90 transition-opacity">
            <Save className="w-4 h-4" /> Lưu thay đổi
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Ảnh đại diện" description="PNG, JPG, WEBP hoặc GIF. Tối đa 5MB.">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
        />

        <div className="flex flex-col sm:flex-row gap-5 items-start">
          {/* Avatar preview */}
          <div className="relative shrink-0 group">
            <div className="w-24 h-24 rounded-2xl overflow-hidden border-2 border-border bg-secondary flex items-center justify-center">
              {avatar
                ? <img src={avatar} alt="Avatar" className="w-full h-full object-cover" />
                : <span className="text-4xl font-comic text-primary">{form.username.charAt(0).toUpperCase()}</span>
              }
            </div>
            {avatar && (
              <button
                onClick={() => {
                  setAvatar(null);
                  updateProfile({ avatar: '' });
                  toast.success('Đã xoá ảnh đại diện');
                }}
                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
              >✕</button>
            )}
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex-1 min-h-[96px] rounded-xl border-2 border-dashed cursor-pointer transition-all flex flex-col items-center justify-center gap-2 px-4 py-5 text-center select-none
              ${isDragging
                ? 'border-primary bg-primary/10 scale-[1.01]'
                : 'border-border hover:border-primary/50 hover:bg-secondary/60 bg-secondary/30'
              }`}
          >
            <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${isDragging ? 'bg-primary/20' : 'bg-secondary'}`}>
              <svg className={`w-5 h-5 transition-colors ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0L8 8m4-4l4 4" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-bold text-foreground">{isUploadingAvatar ? 'Đang upload...' : isDragging ? 'Thả ảnh vào đây!' : 'Kéo thả hoặc nhấn để chọn ảnh'}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">PNG, JPG, WEBP, GIF · Tối đa 5MB</p>
            </div>
          </div>
        </div>

        {avatar && (
          <motion.div
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            className="mt-3 flex items-center gap-2"
          >
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 rounded-lg bg-secondary border border-border text-xs font-bold hover:bg-secondary/80 transition-colors"
            >Đổi ảnh</button>
            <button
              onClick={() => {
                setAvatar(null);
                updateProfile({ avatar: '' });
                toast.success('Đã xoá ảnh đại diện');
              }}
              className="px-4 py-2 rounded-lg text-xs font-bold text-destructive/70 hover:text-destructive transition-colors"
            >Xoá ảnh</button>
          </motion.div>
        )}
      </SectionCard>
    </>
  );
};

const ReaderSection = () => {
  const { settings, updateReader } = useSettingsStore();
  const reader = settings.reader;

  return (
    <>
      <SectionCard title="Chế độ đọc" description="Chọn cách hiển thị trang truyện mặc định">
        <OptionGroup
          options={[
            { value: 'vertical', label: 'Cuộn dọc', icon: AlignVerticalSpaceAround },
            { value: 'horizontal', label: 'Lật trang ngang', icon: Columns },
            { value: 'webtoon', label: 'Webtoon', icon: Smartphone },
          ]}
          value={reader.readingMode}
          onChange={(v: any) => { updateReader({ readingMode: v }); toast.success(`Chế độ đọc: ${v === 'vertical' ? 'Cuộn dọc' : v === 'horizontal' ? 'Lật trang ngang' : 'Webtoon'}`); }}
        />
      </SectionCard>

      <SectionCard title="Hướng trang">
        <OptionGroup
          options={[
            { value: 'ltr', label: 'Trái → Phải' },
            { value: 'rtl', label: 'Phải → Trái' },
          ]}
          value={reader.pageDirection}
          onChange={(v: any) => { updateReader({ pageDirection: v }); toast.success(`Hướng trang: ${v === 'ltr' ? 'Trái → Phải' : 'Phải → Trái'}`); }}
        />
      </SectionCard>

      <SectionCard title="Hiển thị ảnh">
        <OptionGroup
          options={[
            { value: 'width', label: 'Vừa chiều rộng' },
            { value: 'height', label: 'Vừa chiều cao' },
            { value: 'original', label: 'Kích thước gốc' },
          ]}
          value={reader.imageFit}
          onChange={(v: any) => { updateReader({ imageFit: v }); toast.success(`Hiển thị ảnh: ${v === 'width' ? 'Vừa chiều rộng' : v === 'height' ? 'Vừa chiều cao' : 'Kích thước gốc'}`); }}
        />
      </SectionCard>

      <SectionCard title="Chế độ tải ảnh">
        <OptionGroup
          options={[
            { value: 'standard', label: 'Tiêu chuẩn' },
            { value: 'preload', label: 'Tải trước' },
            { value: 'aggressive', label: 'Tải mạnh' },
          ]}
          value={reader.imageLoading}
          onChange={(v: any) => { updateReader({ imageLoading: v }); toast.success(`Chế độ tải: ${v === 'standard' ? 'Tiêu chuẩn' : v === 'preload' ? 'Tải trước' : 'Tải mạnh'}`); }}
        />
      </SectionCard>

      <SectionCard title="Giao diện trình đọc">
        <ToggleSwitch checked={reader.autoHideToolbar} onChange={() => updateReader({ autoHideToolbar: !reader.autoHideToolbar })} label="Tự ẩn thanh công cụ" description="Ẩn khi đọc, hiện khi di chuột/chạm" />
        <ToggleSwitch checked={reader.showPageNumber} onChange={() => updateReader({ showPageNumber: !reader.showPageNumber })} label="Hiện số trang" />
        <ToggleSwitch checked={reader.showProgressBar} onChange={() => updateReader({ showProgressBar: !reader.showProgressBar })} label="Hiện thanh tiến độ" />
      </SectionCard>

      <SectionCard title="Tự động">
        <ToggleSwitch checked={reader.autoBookmark} onChange={() => updateReader({ autoBookmark: !reader.autoBookmark })} label="Tự lưu chương đã đọc" description="Tự đánh dấu chương cuối đã đọc" />
        <ToggleSwitch checked={reader.autoFollow} onChange={() => updateReader({ autoFollow: !reader.autoFollow })} label="Tự theo dõi khi đọc" description="Tự theo dõi truyện khi bắt đầu đọc" />
      </SectionCard>
    </>
  );
};

const NotificationsSection = () => {
  const { settings, updateNotifications } = useSettingsStore();
  const notif = settings.notifications;

  return (
    <>
      <SectionCard title="Loại thông báo" description="Chọn thông báo bạn muốn nhận">
        <ToggleSwitch checked={notif.newChapter} onChange={() => updateNotifications({ newChapter: !notif.newChapter })} label="Chapter mới" description="Thông báo khi truyện theo dõi có chapter mới" />
        <ToggleSwitch checked={notif.commentReply} onChange={() => updateNotifications({ commentReply: !notif.commentReply })} label="Phản hồi bình luận" description="Khi có người trả lời bình luận của bạn" />
        <ToggleSwitch checked={notif.systemAnnouncement} onChange={() => updateNotifications({ systemAnnouncement: !notif.systemAnnouncement })} label="Thông báo hệ thống" description="Cập nhật và thông báo từ MangaHub" />
      </SectionCard>

      <SectionCard title="Phương thức gửi">
        <ToggleSwitch checked={notif.emailNotifications} onChange={() => updateNotifications({ emailNotifications: !notif.emailNotifications })} label="Thông báo email" description="Gửi thông báo quan trọng qua email" />
      </SectionCard>
    </>
  );
};

const PrivacySection = () => {
  const { settings, updatePrivacy } = useSettingsStore();
  const { user } = useUserStore();
  const privacy = settings.privacy;
  const publicProfilePath = user ? `/u/${encodeURIComponent(user.username || user.id)}` : '';

  return (
    <>
      <SectionCard title="Hiển thị hồ sơ" description="Ai có thể xem hồ sơ của bạn">
        <OptionGroup
          options={[
            { value: 'public', label: 'Công khai', icon: Globe },
            { value: 'private', label: 'Riêng tư', icon: LockKeyhole },
          ]}
          value={privacy.profileVisibility}
          onChange={(v: any) => { updatePrivacy({ profileVisibility: v }); toast.success(`Hiển thị hồ sơ: ${v === 'public' ? 'Công khai' : 'Riêng tư'}`); }}
        />
        {user && (
          <div className="mt-4 rounded-xl border border-border bg-muted/30 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold">Liên kết hồ sơ công khai</p>
              <p className="text-xs text-muted-foreground truncate">{publicProfilePath}</p>
            </div>
            <Link
              to={publicProfilePath}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Mở hồ sơ <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Hiển thị hoạt động" description="Chọn thông tin hiển thị trên hồ sơ">
        <ToggleSwitch checked={privacy.showReadingHistory} onChange={() => updatePrivacy({ showReadingHistory: !privacy.showReadingHistory })} label="Hiện lịch sử đọc" />
        <ToggleSwitch checked={privacy.showFollowedManga} onChange={() => updatePrivacy({ showFollowedManga: !privacy.showFollowedManga })} label="Hiện truyện đang theo dõi" />
        <ToggleSwitch checked={privacy.showComments} onChange={() => updatePrivacy({ showComments: !privacy.showComments })} label="Hiện bình luận" />
        <ToggleSwitch
          checked={privacy.showMatureContent}
          onChange={() => updatePrivacy({ showMatureContent: !privacy.showMatureContent })}
          label="Hiển thị nội dung Mature (18+)"
          description="Tắt: ẩn khỏi banner, khám phá, xếp hạng. Bật: hiển thị đầy đủ."
        />
        {user?.role === 'admin' && (
          <ToggleSwitch
            checked={Boolean(privacy.silentViewTracking)}
            onChange={() => updatePrivacy({ silentViewTracking: !privacy.silentViewTracking })}
            label="Xem ẩn view"
            description="Chỉ admin: đọc truyện nhưng không tăng lượt xem. Lịch sử đọc vẫn được lưu."
          />
        )}
      </SectionCard>
    </>
  );
};

const AppearanceSection = () => {
  const { mode, accent, setMode, setAccent } = useThemeStore();

  const accentColors: { name: string; value: AccentColor; hsl: string }[] = [
    { name: 'Đỏ', value: 'red', hsl: '0 72% 51%' },
    { name: 'Tím', value: 'purple', hsl: '265 50% 55%' },
    { name: 'Xanh dương', value: 'blue', hsl: '210 60% 50%' },
    { name: 'Cam', value: 'orange', hsl: '20 85% 55%' },
    { name: 'Hồng', value: 'pink', hsl: '340 60% 55%' },
    { name: 'Xanh lá', value: 'green', hsl: '155 55% 42%' },
  ];

  return (
    <>
      <SectionCard title="Chủ đề" description="Tuỳ chỉnh giao diện hiển thị">
        <div className="space-y-4">
          <div>
            <p className="text-xs text-muted-foreground mb-2 font-bold">Chế độ hiển thị</p>
            <OptionGroup
              options={[
                { value: 'dark', label: 'Tối', icon: Moon },
                { value: 'light', label: 'Sáng', icon: Sun },
              ]}
              value={mode}
              onChange={(v) => {
                setMode(v);
                toast.success(v === 'dark' ? 'Đã chuyển sang chế độ tối' : 'Đã chuyển sang chế độ sáng');
              }}
            />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-2 font-bold">Màu chủ đạo</p>
            <div className="flex gap-2">
              {accentColors.map(c => (
                <button key={c.value} onClick={() => { setAccent(c.value); toast.success(`Đã đổi màu chủ đạo: ${c.name}`); }}
                  className={`w-8 h-8 rounded-full border-2 transition-all ${accent === c.value ? 'ring-2 ring-offset-2 ring-offset-background scale-110' : 'border-transparent hover:border-foreground/50'}`}
                  style={{ backgroundColor: `hsl(${c.hsl})`, borderColor: accent === c.value ? `hsl(${c.hsl})` : undefined, boxShadow: accent === c.value ? `0 0 0 2px hsl(${c.hsl})` : undefined }}
                  title={c.name} />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>
    </>
  );
};

const SecuritySection = () => {
  const { logout } = useUserStore();
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const assessment = usePasswordAssessment(newPw);
  const [changingPw, setChangingPw] = useState(false);

  const handleChangePassword = async () => {
    if (!currentPw) { toast.error('Vui lòng nhập mật khẩu hiện tại'); return; }
    const strengthError = passwordStrengthError(newPw);
    if (strengthError) {
      toast.error(strengthError);
      return;
    }
    if (newPw !== confirmPw) { toast.error('Mật khẩu xác nhận không khớp'); return; }
    setChangingPw(true);
    try {
      const { authApi } = await import('@/lib/api');
      await authApi.changePassword(currentPw, newPw);
      toast.success('Đã cập nhật mật khẩu. Vui lòng đăng nhập lại.');
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      logout('global');
    } catch (err: any) {
      toast.error(err.message || 'Không thể đổi mật khẩu');
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <>
      <SectionCard title="Đổi mật khẩu" description="Cập nhật mật khẩu tài khoản">
        <div className="space-y-3">
          <InputField label="Mật khẩu hiện tại" value={currentPw} onChange={setCurrentPw} type="password" />
          <NewPasswordFields password={newPw} confirmation={confirmPw} onPasswordChange={setNewPw}
            onConfirmationChange={setConfirmPw} assessment={assessment} disabled={changingPw} />
          <button onClick={handleChangePassword} disabled={changingPw || !currentPw || !assessment.accepted || newPw !== confirmPw}
            className="px-5 py-2.5 rounded-xl manga-gradient text-primary-foreground text-sm font-bold flex items-center gap-2 disabled:opacity-50">
            <Lock className="w-4 h-4" /> {changingPw ? 'Đang lưu...' : 'Đổi mật khẩu'}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Phiên đăng nhập" description="Quản lý các thiết bị đã đăng nhập">
        <div className="space-y-3">
          {[
            { device: navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Trình duyệt', ip: '', time: 'Đang hoạt động', active: true },
          ].map((s, i) => (
            <div key={i} className="flex items-center justify-between py-2.5 border-b border-border/20 last:border-0">
              <div className="flex items-center gap-3">
                <Monitor className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">{s.device}</p>
                  <p className="text-[10px] text-muted-foreground">{s.ip} · {s.time}</p>
                </div>
              </div>
              {s.active ? (
                <span className="text-[10px] text-green-400 font-bold flex items-center gap-1"><Check className="w-3 h-3" /> Hiện tại</span>
              ) : (
                <button className="text-xs text-destructive/70 font-bold hover:text-destructive hover:underline">Đăng xuất</button>
              )}
            </div>
          ))}
          <button onClick={() => { logout('global'); toast.success('Đã đăng xuất tất cả!'); }}
            className="px-4 py-2 rounded-lg bg-secondary border border-border text-xs font-bold text-muted-foreground hover:text-foreground flex items-center gap-2">
            <LogOut className="w-3 h-3" /> Đăng xuất tất cả thiết bị
          </button>
        </div>
      </SectionCard>
    </>
  );
};

const DangerSection = () => {
  const [showDelete, setShowDelete] = useState(false);

  return (
    <div className="bg-destructive/5 rounded-xl border border-destructive/20 p-6">
      <h3 className="text-lg font-bold text-destructive mb-1 flex items-center gap-2">
        <AlertTriangle className="w-5 h-5" /> Vùng nguy hiểm
      </h3>
      <p className="text-sm text-muted-foreground mb-6">Hành động ở đây không thể hoàn tác. Hãy cẩn thận.</p>

      <div className="bg-card rounded-xl border border-destructive/20 p-5">
        <h4 className="font-bold text-sm mb-1">Xoá tài khoản vĩnh viễn</h4>
        <p className="text-xs text-muted-foreground mb-4">Toàn bộ dữ liệu của bạn (hồ sơ, lịch sử, bookmarks, comments) sẽ bị xoá vĩnh viễn và không thể khôi phục.</p>

        {!showDelete ? (
          <button onClick={() => setShowDelete(true)}
            className="px-5 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive text-sm font-bold flex items-center gap-2 hover:bg-destructive/20 transition-colors">
            <Trash2 className="w-4 h-4" /> Xoá tài khoản
          </button>
        ) : (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-destructive font-bold mb-2 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Chưa bật xoá tài khoản tự động</p>
              <p className="text-[10px] text-muted-foreground">Web chưa có endpoint xoá tài khoản an toàn, nên trang này không thu mật khẩu. Gửi yêu cầu hỗ trợ để admin xử lý thủ công.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowDelete(false)} className="px-4 py-2.5 rounded-xl bg-secondary border border-border text-sm font-bold hover:bg-secondary/80 transition-colors">
                Huỷ bỏ
              </button>
              <Link
                to="/support"
                className="px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-bold flex items-center gap-1 hover:bg-destructive/90 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Gửi yêu cầu xoá
              </Link>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;
