import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Crown, Palette, Type, Sparkles, Check } from 'lucide-react';
import { User } from '@/types/manga';
import {
  getNameEffectClass,
  getNameEffectStyle,
  getNameFontClass,
  hasPremiumNameStyleAccess,
  isPremiumNameColor,
  isPremiumNameEffect,
  isPremiumNameFont,
  NAME_VIP_BADGE_CLASS,
  NAME_VIP_BADGE_ICON_CLASS,
  normalizeNameColorForAccess,
  normalizeNameEffectForAccess,
  normalizeNameFontForAccess,
} from '@/lib/nameStyles';

const NAME_COLORS = [
  { color: '', label: 'Mặc định' },
  // Đỏ
  { color: '#ef4444', label: 'Đỏ' },
  { color: '#e62e2e', label: 'Đỏ manga' },
  { color: '#dc2626', label: 'Đỏ đậm' },
  { color: '#f87171', label: 'Đỏ nhạt' },
  { color: '#e11d48', label: 'Rose' },
  // Cam / Vàng
  { color: '#f97316', label: 'Cam' },
  { color: '#fb923c', label: 'Cam nhạt' },
  { color: '#f59e0b', label: 'Vàng' },
  { color: '#facc15', label: 'Amber' },
  { color: '#eab308', label: 'Vàng đậm' },
  { color: '#fbbf24', label: 'Vàng sáng' },
  // Xanh lá
  { color: '#10b981', label: 'Xanh lá' },
  { color: '#4ade80', label: 'Xanh nhạt' },
  { color: '#84cc16', label: 'Lime' },
  { color: '#22c55e', label: 'Xanh tươi' },
  { color: '#16a34a', label: 'Xanh đậm' },
  // Xanh dương
  { color: '#3b82f6', label: 'Xanh dương' },
  { color: '#0ea5e9', label: 'Sky' },
  { color: '#06b6d4', label: 'Cyan' },
  { color: '#14b8a6', label: 'Teal' },
  { color: '#2563eb', label: 'Xanh đậm' },
  { color: '#60a5fa', label: 'Xanh nhạt' },
  // Tím / Hồng
  { color: '#8b5cf6', label: 'Tím' },
  { color: '#a855f7', label: 'Purple' },
  { color: '#7c3aed', label: 'Violet' },
  { color: '#c084fc', label: 'Tím nhạt' },
  { color: '#d946ef', label: 'Fuchsia' },
  { color: '#ec4899', label: 'Hồng' },
  { color: '#f472b6', label: 'Hồng nhạt' },
  // Trung tính
  { color: '#ffffff', label: 'Trắng' },
  { color: '#94a3b8', label: 'Xám' },
  { color: '#1e293b', label: 'Tối' },
  { color: '#78716c', label: 'Nâu xám' },
  { color: '#b45309', label: 'Nâu' },
];

const NAME_FONTS: { id: string; label: string; style: string }[] = [
  { id: 'default', label: 'Mặc định', style: 'font-sans' },
  { id: 'serif', label: 'Serif', style: 'font-serif' },
  { id: 'mono', label: 'Mono', style: 'font-mono' },
  { id: 'cursive', label: 'Nghệ thuật', style: 'italic' },
  { id: 'fantasy', label: 'Fantasy', style: 'tracking-widest uppercase' },
  { id: 'rounded', label: 'Bo tròn', style: 'tracking-wide' },
  { id: 'bold', label: 'Đậm nét', style: 'font-black' },
  { id: 'thin', label: 'Mảnh', style: 'font-light tracking-wider' },
  { id: 'condensed', label: 'Thu gọn', style: 'tracking-tighter font-bold' },
  { id: 'wide', label: 'Giãn rộng', style: 'tracking-[0.3em]' },
  { id: 'uppercase', label: 'IN HOA', style: 'uppercase font-semibold' },
  { id: 'lowercase', label: 'chữ thường', style: 'lowercase' },
  { id: 'capitalize', label: 'Viết Hoa Đầu', style: 'capitalize' },
  { id: 'smallcaps', label: 'Chữ Nhỏ', style: 'text-xs uppercase tracking-widest font-bold' },
  { id: 'heavy', label: 'Siêu đậm', style: 'font-black text-lg' },
  { id: 'elegant', label: 'Thanh lịch', style: 'font-serif italic tracking-wide' },
  { id: 'tech', label: 'Công nghệ', style: 'font-mono uppercase tracking-wider font-bold' },
  { id: 'handwrite', label: 'Viết tay', style: 'italic font-light' },
  // New fonts
  { id: 'gothic', label: 'Gothic', style: 'font-black uppercase tracking-tight' },
  { id: 'retro-font', label: 'Retro', style: 'font-bold italic tracking-wide' },
  { id: 'pixel', label: 'Pixel', style: 'font-mono text-sm tracking-widest' },
  { id: 'newspaper', label: 'Báo chí', style: 'font-serif font-bold uppercase' },
  { id: 'whisper', label: 'Thì thầm', style: 'font-extralight text-sm tracking-[0.2em]' },
  { id: 'military', label: 'Quân đội', style: 'font-bold uppercase tracking-[0.15em]' },
  { id: 'manga-style', label: 'Manga', style: 'font-black italic' },
  { id: 'minimal', label: 'Tối giản', style: 'font-thin tracking-[0.25em] uppercase' },
  { id: 'typewriter', label: 'Máy đánh chữ', style: 'font-mono font-medium' },
  { id: 'display', label: 'Display', style: 'font-extrabold text-lg tracking-tight' },
  { id: 'sketch', label: 'Phác thảo', style: 'font-light italic tracking-wider' },
  { id: 'royal', label: 'Hoàng gia', style: 'font-serif font-semibold tracking-wide' },
  { id: 'cinematic', label: 'Điện ảnh', style: 'font-serif font-black uppercase tracking-[0.08em]' },
  { id: 'luxe', label: 'Luxury', style: 'font-serif italic font-semibold tracking-[0.06em]' },
  { id: 'stencil', label: 'Stencil', style: 'font-black uppercase tracking-[0.2em]' },
  { id: 'hacker', label: 'Hacker', style: 'font-mono text-[0.92rem] uppercase tracking-[0.08em]' },
  { id: 'titan', label: 'Titan', style: 'font-black text-lg uppercase tracking-tight' },
  { id: 'airy', label: 'Airy', style: 'font-light italic tracking-[0.18em]' },
  { id: 'comic-pop', label: 'Comic Pop', style: 'font-extrabold tracking-[0.06em] uppercase' },
  { id: 'bookish', label: 'Bookish', style: 'font-serif tracking-[0.01em]' },
  { id: 'razor', label: 'Razor', style: 'font-semibold tracking-[-0.02em]' },
  { id: 'rune', label: 'Rune', style: 'font-serif font-bold uppercase tracking-[0.12em]' },
  { id: 'zen', label: 'Zen', style: 'font-light lowercase tracking-[0.12em]' },
  { id: 'noble', label: 'Noble', style: 'font-serif font-bold tracking-[0.05em]' },
];

const NAME_EFFECTS: { id: string; label: string }[] = [
  { id: 'none', label: 'Không' },
  // Tĩnh
  { id: 'glow', label: 'Phát sáng' },
  { id: 'shadow', label: 'Đổ bóng' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'underline', label: 'Gạch chân' },
  { id: 'italic', label: 'Nghiêng' },
  { id: 'retro', label: 'Retro' },
  { id: 'outline', label: 'Viền chữ' },
  { id: 'double-shadow', label: 'Bóng đôi' },
  { id: 'emboss', label: 'Nổi' },
  { id: 'wave-underline', label: 'Gạch lượn' },
  { id: 'strikethrough', label: 'Gạch ngang' },
  { id: 'frost', label: 'Băng giá' },
  { id: 'metallic', label: 'Kim loại' },
  { id: 'blood', label: 'Máu' },
  { id: 'gold', label: 'Vàng kim' },
  { id: 'silver', label: 'Bạc' },
  { id: 'copper', label: 'Đồng' },
  { id: 'electric', label: 'Điện' },
  { id: 'sunset', label: 'Hoàng hôn' },
  { id: 'ocean', label: 'Đại dương' },
  { id: 'toxic', label: 'Độc' },
  { id: 'hologram', label: 'Hologram' },
  { id: 'galaxy', label: 'Thiên hà' },
  { id: 'cherry', label: 'Hoa anh đào' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'prism', label: 'Lăng kính' },
  { id: 'rose-gold', label: 'Rose Gold' },
  { id: 'midnight', label: 'Nửa đêm' },
  { id: 'mint-glow', label: 'Mint Glow' },
  { id: 'comic-shadow', label: 'Comic Shadow' },
  { id: 'crystal', label: 'Crystal' },
  { id: 'ember', label: 'Ember' },
  { id: 'starlight', label: 'Starlight' },
  // Động (chỉ hiệu ứng màu/ánh sáng)
  { id: 'neon-glow', label: 'Neon' },
  { id: 'fire-text', label: 'Lửa' },
  { id: 'rainbow', label: 'Cầu vồng' },
  { id: 'glitch', label: 'Glitch' },
  { id: 'blur-glow', label: 'Mờ sáng' },
  { id: 'color-cycle', label: 'Đổi màu' },
  { id: 'flicker', label: 'Chớp sáng' },
  { id: 'glow-pulse', label: 'Sáng nhịp' },
  { id: 'rainbow-shift', label: 'Cầu vồng chạy' },
  { id: 'aurora', label: 'Cực quang' },
  { id: 'lava', label: 'Dung nham' },
  { id: 'ice-shimmer', label: 'Băng lấp lánh' },
  { id: 'neon-pulse', label: 'Neon nhịp' },
  { id: 'galaxy-shift', label: 'Thiên hà chạy' },
  { id: 'prism-flow', label: 'Prism Flow' },
  { id: 'cyber-scan', label: 'Cyber Scan' },
  { id: 'comet-trail', label: 'Sao chổi' },
  { id: 'storm-flicker', label: 'Bão điện' },
  { id: 'blossom-breeze', label: 'Hoa bay' },
];

const EFFECTS_WITH_OWN_COLOR = new Set([
  'gradient',
  'rainbow',
  'metallic',
  'gold',
  'silver',
  'copper',
  'sunset',
  'ocean',
  'hologram',
  'galaxy',
  'prism',
  'rose-gold',
  'midnight',
  'crystal',
  'rainbow-shift',
  'aurora',
  'lava',
  'ice-shimmer',
  'galaxy-shift',
  'prism-flow',
  'comet-trail',
  'blossom-breeze',
]);

const OPTION_VIP_BADGE_CLASS =
  'absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-md border border-amber-300/70 bg-amber-400 px-1.5 py-0.5 text-[8px] font-black uppercase leading-none text-black shadow-sm';

const premiumOptionClass = (active: boolean, locked: boolean) => {
  if (locked) {
    return 'border-amber-400/70 bg-amber-500/10 opacity-75 cursor-not-allowed shadow-[0_0_0_1px_rgba(251,191,36,0.2)]';
  }
  if (active) {
    return 'border-primary bg-primary/5 scale-105';
  }
  return 'border-amber-400/60 bg-amber-500/5 hover:border-amber-300 hover:bg-amber-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.12)]';
};

interface Props {
  open: boolean;
  onClose: () => void;
  user: User;
  onSave: (data: Partial<Pick<User, 'nameColor' | 'nameFont' | 'nameEffect'>>) => void;
}

const ProfileCustomizeModal = ({ open, onClose, user, onSave }: Props) => {
  const [activeTab, setActiveTab] = useState<'color' | 'font' | 'effect'>('color');
  const [selectedColor, setSelectedColor] = useState(normalizeNameColorForAccess(user.nameColor, user));
  const [selectedFont, setSelectedFont] = useState(normalizeNameFontForAccess(user.nameFont, user));
  const [selectedEffect, setSelectedEffect] = useState(normalizeNameEffectForAccess(user.nameEffect, user));
  const hasPremiumAccess = hasPremiumNameStyleAccess(user);

  const handleSave = () => {
    onSave({
      nameColor: normalizeNameColorForAccess(selectedColor, user),
      nameFont: normalizeNameFontForAccess(selectedFont, user),
      nameEffect: normalizeNameEffectForAccess(selectedEffect, user),
    });
    onClose();
  };

  const getNameStyle = (): React.CSSProperties => {
    const style: React.CSSProperties = {};
    if (selectedColor && !EFFECTS_WITH_OWN_COLOR.has(selectedEffect)) style.color = selectedColor;
    Object.assign(style, getNameEffectStyle(selectedEffect, selectedColor));
    return style;
  };

  const getNameClass = () => {
    const classes = ['text-lg font-bold'];
    classes.push(getNameFontClass(selectedFont));
    classes.push(getNameEffectClass(selectedEffect));
    return classes.join(' ');
  };

  const tabs = [
    { key: 'color' as const, label: 'Màu tên', icon: Palette, count: NAME_COLORS.length - 1 },
    { key: 'font' as const, label: 'Font', icon: Type, count: NAME_FONTS.length },
    { key: 'effect' as const, label: 'Hiệu ứng', icon: Sparkles, count: NAME_EFFECTS.length - 1 },
  ];

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="bg-card border border-border rounded-2xl w-full max-w-xl max-h-[90vh] overflow-hidden shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              Tuỳ chỉnh hồ sơ
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Preview */}
          <div className="p-4 bg-secondary/20 border-b border-border">
            <p className="text-[10px] text-muted-foreground mb-2 uppercase font-bold tracking-wider">Xem trước</p>
            <div className="flex items-center gap-3">
              <div className="relative w-14 h-14 rounded-xl ring-2 ring-background bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <span className="text-xl font-bold text-primary-foreground">{user.username.charAt(0)}</span>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <p className={getNameClass()} style={getNameStyle()}>
                    {user.displayName || user.username}
                  </p>
                  {user.isVip && (
                    <span className={NAME_VIP_BADGE_CLASS}>
                      <Crown className={NAME_VIP_BADGE_ICON_CLASS} /> VIP
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">@{user.username}</p>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-xs font-bold transition-colors ${
                  activeTab === t.key ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                <span className="px-1 py-0.5 rounded bg-secondary text-[9px]">{t.count}</span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="p-4 overflow-y-auto max-h-[45vh]">
            {activeTab === 'color' && (
              <div className="grid grid-cols-5 gap-2">
                {NAME_COLORS.map(c => {
                  const premium = isPremiumNameColor(c.color);
                  const locked = premium && !hasPremiumAccess;
                  const active = selectedColor === c.color;
                  return (
                    <button
                      key={c.color || 'default'}
                      onClick={() => { if (!locked) setSelectedColor(c.color); }}
                      disabled={locked}
                      className={`relative flex min-h-[74px] flex-col items-center gap-1 rounded-xl border-2 p-2 pt-3 transition-all ${
                        premium
                          ? premiumOptionClass(active, locked)
                          : active
                          ? 'border-primary bg-primary/5 scale-105'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {premium && (
                        <span className={OPTION_VIP_BADGE_CLASS}>
                          <Crown className="h-2.5 w-2.5" />
                          VIP
                        </span>
                      )}
                      <div
                        className={`h-7 w-7 rounded-full border-2 ${premium ? 'border-amber-300/80' : 'border-border'}`}
                        style={{ backgroundColor: c.color || 'hsl(var(--foreground))' }}
                      />
                      <p className="max-w-full truncate text-[9px] font-bold">{c.label}</p>
                      {active && (
                        <div className="absolute bottom-1 right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary">
                          <Check className="h-2 w-2 text-primary-foreground" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {activeTab === 'font' && (
              <div className="space-y-2">
                {NAME_FONTS.map(font => {
                  const premium = isPremiumNameFont(font.id);
                  const locked = premium && !hasPremiumAccess;
                  const active = selectedFont === font.id;
                  return (
                    <button
                      key={font.id}
                      onClick={() => { if (!locked) setSelectedFont(font.id); }}
                      disabled={locked}
                      className={`relative w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all ${
                        premium
                          ? premiumOptionClass(active, locked)
                          : active
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <span className={`text-sm font-bold ${getNameFontClass(font.id)}`} style={selectedColor ? { color: selectedColor } : undefined}>
                        {user.displayName || user.username}
                      </span>
                      <span className={`pr-12 text-[10px] ${premium ? 'font-bold text-amber-500' : 'text-muted-foreground'}`}>{font.label}</span>
                      {premium && (
                        <span className={OPTION_VIP_BADGE_CLASS}>
                          <Crown className="h-2.5 w-2.5" />
                          VIP
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {activeTab === 'effect' && (
              <div className="grid grid-cols-2 gap-2">
                {NAME_EFFECTS.map(effect => {
                  const premium = isPremiumNameEffect(effect.id);
                  const locked = premium && !hasPremiumAccess;
                  const active = selectedEffect === effect.id;
                  const previewStyle: React.CSSProperties = {};
                  if (selectedColor && !EFFECTS_WITH_OWN_COLOR.has(effect.id)) previewStyle.color = selectedColor;
                  Object.assign(previewStyle, getNameEffectStyle(effect.id, selectedColor));

                  let previewClass = 'text-sm font-bold';
                  previewClass += ' ' + getNameEffectClass(effect.id);

                  return (
                    <button
                      key={effect.id}
                      onClick={() => { if (!locked) setSelectedEffect(effect.id); }}
                      disabled={locked}
                      className={`relative flex min-h-[92px] flex-col items-center gap-2 rounded-xl border-2 p-4 pt-6 transition-all ${
                        premium
                          ? premiumOptionClass(active, locked)
                          : active
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {premium && (
                        <span className={OPTION_VIP_BADGE_CLASS}>
                          <Crown className="h-2.5 w-2.5" />
                          VIP
                        </span>
                      )}
                      <span className={previewClass} style={previewStyle}>Abc</span>
                      <p className="text-[10px] font-bold text-muted-foreground">{effect.label}</p>
                      {active && (
                        <div className="absolute top-1 left-1 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-primary-foreground" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-bold text-muted-foreground hover:bg-secondary transition-colors">
              Huỷ
            </button>
            <button
              onClick={handleSave}
              className="px-5 py-2 rounded-lg text-sm font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Lưu thay đổi
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default ProfileCustomizeModal;
