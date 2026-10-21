import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  BookOpen,
  Calendar,
  Clock,
  Crown,
  ExternalLink,
  Flame,
  Heart,
  Loader2,
  Lock,
  MessageCircle,
  Settings,
  Shield,
} from 'lucide-react';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { userApi } from '@/lib/api';
import { useCanonicalMangaRecords } from '@/hooks/useCardMetadata';
import { useUserStore } from '@/store/userStore';
import {
  getNameEffectClass,
  getNameEffectStyle,
  getNameFontClass,
  NAME_VIP_BADGE_CLASS,
  NAME_VIP_BADGE_ICON_CLASS,
  normalizeNameEffectForAccess,
  normalizeNameFontForAccess,
} from '@/lib/nameStyles';
import { getMangaDetailPath } from '@/lib/mangaLinks';

type PublicActivityItem = {
  id?: string;
  manga_slug?: string;
  manga_title?: string;
  manga_thumb?: string;
  manga_thumb_fallback?: string;
  chapter_name?: string;
  progress?: number;
  created_at?: string;
  read_at?: string;
  content?: string;
  likes?: number;
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const MANGADEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_COVER_FALLBACK = '/no-cover.svg';

const formatDate = (value?: string) => {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return 'Chưa rõ';
  return new Date(time).toLocaleDateString('vi-VN');
};

const compactNumber = (value: unknown) =>
  Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('vi-VN');

const normalizeMangaDexId = (value?: string) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const candidate = raw.startsWith('mdx-') ? raw.slice(4) : raw;
  return MANGADEX_ID_RE.test(candidate) ? candidate : '';
};

const isMangaDexImageUrl = (value: string) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith('uploads.mangadex.org') || host.endsWith('mangadex.network');
  } catch {
    return false;
  }
};

const proxyImage = (url: string) => `${API_BASE}/api/images/img?url=${encodeURIComponent(url)}`;

const safeCoverFallback = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw || isMangaDexImageUrl(raw)) return LOCAL_COVER_FALLBACK;
  return raw;
};

const resolveCoverSources = (item: PublicActivityItem) => {
  const slug = String(item.manga_slug || '').trim();
  const thumb = String(item.manga_thumb || '').trim();
  const fallback = String(item.manga_thumb_fallback || '').trim();

  if (thumb) {
    if (/^https?:\/\//i.test(thumb)) {
      if (isMangaDexImageUrl(thumb)) {
        return { src: proxyImage(thumb), fallbackSrc: LOCAL_COVER_FALLBACK };
      }
      return { src: thumb, fallbackSrc: safeCoverFallback(fallback) };
    }
    if (thumb.startsWith('/api/')) {
      return { src: `${API_BASE}${thumb}`, fallbackSrc: safeCoverFallback(fallback) };
    }
    return { src: thumb, fallbackSrc: safeCoverFallback(fallback) };
  }

  const mangaDexId = normalizeMangaDexId(slug);
  if (mangaDexId) {
    return {
      src: `${API_BASE}/api/manga/mangadex-cover/${mangaDexId}`,
      fallbackSrc: LOCAL_COVER_FALLBACK,
    };
  }

  if (slug) {
    const direct = `${API_BASE}/api/manga/truyenqq/cover/${encodeURIComponent(slug)}`;
    return { src: direct, fallbackSrc: LOCAL_COVER_FALLBACK };
  }

  return { src: LOCAL_COVER_FALLBACK, fallbackSrc: LOCAL_COVER_FALLBACK };
};

const visibilityLabel = (value?: string) => {
  if (value === 'private') return 'Riêng tư';
  return 'Công khai';
};

const fallbackTitle = (slug?: string) => {
  const clean = String(slug || '').trim();
  if (!clean) return 'Truyện';
  if (normalizeMangaDexId(clean)) return 'Truyện MangaDex';
  return clean
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const ActivityMangaList = ({
  title,
  icon: Icon,
  items,
  disabled,
  emptyText,
}: {
  title: string;
  icon: any;
  items: PublicActivityItem[];
  disabled?: boolean;
  emptyText: string;
}) => (
  <section className="bg-card border border-border rounded-2xl p-4">
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-bold flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        {title}
      </h2>
      <span className="text-xs text-muted-foreground">{disabled ? 'Đã ẩn' : `${items.length} mục`}</span>
    </div>

    {disabled ? (
      <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm text-muted-foreground flex items-center gap-2">
        <Lock className="w-4 h-4" />
        Người dùng đã ẩn mục này trong cài đặt quyền riêng tư.
      </div>
    ) : items.length === 0 ? (
      <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm text-muted-foreground">
        {emptyText}
      </div>
    ) : (
      <div className="grid sm:grid-cols-2 gap-2.5">
        {items.map((item, index) => {
          const slug = String(item.manga_slug || '').trim();
          const titleText = String(item.manga_title || '').trim() || fallbackTitle(slug);
          const cover = resolveCoverSources(item);
          return (
            <Link
              key={`${slug}-${item.id || index}`}
              to={getMangaDetailPath(slug)}
              className="group flex gap-3 rounded-xl border border-border bg-background/40 p-2.5 hover:bg-muted/50 transition-colors"
            >
              <div className="w-11 h-16 rounded-lg overflow-hidden bg-muted border border-border shrink-0">
                <OptimizedImage
                  src={cover.src}
                  fallbackSrc={cover.fallbackSrc}
                  alt={titleText}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm line-clamp-2 group-hover:text-primary transition-colors">
                  {titleText}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {item.chapter_name ? `Chương ${item.chapter_name}` : formatDate(item.read_at || item.created_at)}
                </p>
                {Number.isFinite(Number(item.progress)) && Number(item.progress) > 0 ? (
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(0, Math.min(100, Number(item.progress)))}%` }}
                    />
                  </div>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    )}
  </section>
);

const CommentList = ({
  comments,
  disabled,
}: {
  comments: PublicActivityItem[];
  disabled?: boolean;
}) => (
  <section className="bg-card border border-border rounded-2xl p-4">
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-bold flex items-center gap-2">
        <MessageCircle className="w-4 h-4 text-primary" />
        Bình luận gần đây
      </h2>
      <span className="text-xs text-muted-foreground">{disabled ? 'Đã ẩn' : `${comments.length} mục`}</span>
    </div>

    {disabled ? (
      <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm text-muted-foreground flex items-center gap-2">
        <Lock className="w-4 h-4" />
        Người dùng đã ẩn bình luận trong cài đặt quyền riêng tư.
      </div>
    ) : comments.length === 0 ? (
      <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm text-muted-foreground">
        Chưa có bình luận công khai.
      </div>
    ) : (
      <div className="space-y-2.5">
        {comments.map((comment) => {
          const slug = String(comment.manga_slug || '').trim();
          const titleText = String(comment.manga_title || '').trim() || fallbackTitle(slug);
          return (
            <Link
              key={comment.id || `${slug}-${comment.created_at}`}
              to={getMangaDetailPath(slug)}
              className="block rounded-xl border border-border bg-background/40 p-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <p className="text-xs font-bold text-primary line-clamp-1">{titleText}</p>
                <span className="text-[11px] text-muted-foreground shrink-0">{formatDate(comment.created_at)}</span>
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">{comment.content || 'Bình luận trống'}</p>
            </Link>
          );
        })}
      </div>
    )}
  </section>
);

const PublicProfilePage = () => {
  const { userId = '' } = useParams<{ userId: string }>();
  const currentUser = useUserStore((s) => s.user);
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-profile', userId],
    queryFn: () => userApi.getPublicProfile(userId),
    enabled: !!userId,
    retry: false,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
  const rawActivity = data?.activity || {};
  const activity = {
    following: useCanonicalMangaRecords(rawActivity.following, { fillMissingCovers: true }) || [],
    history: useCanonicalMangaRecords(rawActivity.history, { fillMissingCovers: true }) || [],
    comments: useCanonicalMangaRecords(rawActivity.comments, { fillMissingCovers: true }) || [],
  };

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data?.profile) {
    return (
      <div className="container mx-auto px-4 py-16 max-w-xl">
        <div className="rounded-3xl border border-border bg-card p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted mx-auto mb-4 flex items-center justify-center">
            <Lock className="w-7 h-7 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-bold mb-2">Không thể xem hồ sơ</h1>
          <p className="text-sm text-muted-foreground mb-5">
            {(error as Error)?.message || 'Hồ sơ không tồn tại hoặc đang được đặt riêng tư.'}
          </p>
          <Link to="/manga" className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">
            Quay lại khám phá
          </Link>
        </div>
      </div>
    );
  }

  const profile = data.profile;
  const settings = data.settings || {};
  const isSelf = Boolean(
    data.viewer?.is_self ||
    currentUser?.id === profile.id ||
    (currentUser?.username && currentUser.username === profile.username),
  );
  const displayProfile = isSelf && currentUser
    ? {
        ...profile,
        username: currentUser.username || profile.username,
        display_name: currentUser.displayName || profile.display_name,
        avatar: currentUser.avatar || profile.avatar,
        bio: currentUser.bio ?? profile.bio,
        role: currentUser.role || profile.role,
        is_vip: currentUser.isVip ?? profile.is_vip,
        name_color: currentUser.nameColor ?? profile.name_color,
        name_font: currentUser.nameFont ?? profile.name_font,
        name_effect: currentUser.nameEffect ?? profile.name_effect,
      }
    : profile;
  const displayName = displayProfile.display_name || displayProfile.username || 'Người dùng';
  const initial = String(displayName).trim().charAt(0).toUpperCase() || 'U';
  const profileNameFont = normalizeNameFontForAccess(displayProfile.name_font, displayProfile);
  const profileNameEffect = normalizeNameEffectForAccess(displayProfile.name_effect, displayProfile);

  return (
    <div className="min-h-screen">
      <div className="relative h-36 overflow-hidden bg-gradient-to-br from-primary/20 via-accent/10 to-background">
        <div className="absolute inset-0 opacity-50 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary)/0.35),transparent_35%),radial-gradient(circle_at_80%_10%,hsl(var(--accent)/0.25),transparent_30%)]" />
      </div>

      <div className="container mx-auto px-4 -mt-16 relative z-10 max-w-6xl">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="grid lg:grid-cols-[320px_1fr] gap-6">
          <aside className="bg-card border border-border rounded-3xl p-5 h-fit lg:sticky lg:top-20">
            <div className="text-center">
              <div className="w-28 h-28 rounded-3xl mx-auto mb-4 overflow-hidden border border-border bg-muted shadow-lg">
                {displayProfile.avatar ? (
                  <img src={displayProfile.avatar} alt={displayName} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                    <span className="text-4xl font-black text-primary-foreground">{initial}</span>
                  </div>
                )}
              </div>

              <h1 className="text-2xl font-black flex items-center justify-center gap-1.5 flex-wrap">
                <span
                  className={`${getNameFontClass(profileNameFont)} ${getNameEffectClass(profileNameEffect)}`}
                  style={{
                    ...(displayProfile.name_color && profileNameEffect !== 'gradient' ? { color: displayProfile.name_color } : {}),
                    ...getNameEffectStyle(profileNameEffect, displayProfile.name_color),
                  }}
                >
                  {displayName}
                </span>
                {displayProfile.is_vip ? (
                  <span className={NAME_VIP_BADGE_CLASS}>
                    <Crown className={NAME_VIP_BADGE_ICON_CLASS} />
                    VIP
                  </span>
                ) : null}
              </h1>
              <p className="text-sm text-muted-foreground">@{displayProfile.username}</p>
              <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                  <Shield className="w-3.5 h-3.5" />
                  {visibilityLabel(settings.profile_visibility)}
                </span>
                <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold uppercase">{displayProfile.role || 'reader'}</span>
              </div>
            </div>

            {displayProfile.bio ? (
              <p className="mt-5 text-sm text-muted-foreground text-center leading-relaxed">{displayProfile.bio}</p>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-muted/40 p-3 text-center">
                <BookOpen className="w-4 h-4 text-primary mx-auto mb-1" />
                <p className="text-lg font-black">{compactNumber(displayProfile.chapters_read)}</p>
                <p className="text-[11px] text-muted-foreground">Chương đọc</p>
              </div>
              <div className="rounded-2xl bg-muted/40 p-3 text-center">
                <MessageCircle className="w-4 h-4 text-green-400 mx-auto mb-1" />
                <p className="text-lg font-black">{compactNumber(displayProfile.comments_posted)}</p>
                <p className="text-[11px] text-muted-foreground">Bình luận</p>
              </div>
              <div className="rounded-2xl bg-muted/40 p-3 text-center">
                <Flame className="w-4 h-4 text-orange-400 mx-auto mb-1" />
                <p className="text-lg font-black">{compactNumber(displayProfile.reading_streak)}</p>
                <p className="text-[11px] text-muted-foreground">Chuỗi ngày</p>
              </div>
              <div className="rounded-2xl bg-muted/40 p-3 text-center">
                <Calendar className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                <p className="text-sm font-black">{formatDate(displayProfile.created_at)}</p>
                <p className="text-[11px] text-muted-foreground">Tham gia</p>
              </div>
            </div>

            {isSelf ? (
              <Link
                to="/settings"
                className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-bold hover:bg-muted transition-colors"
              >
                <Settings className="w-4 h-4" />
                Chỉnh quyền riêng tư
              </Link>
            ) : null}
          </aside>

          <main className="space-y-4 pb-10">
            <div className="bg-card border border-border rounded-3xl p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-black">Hoạt động công khai</h2>
                  <p className="text-sm text-muted-foreground">
                    Những mục bên dưới được điều khiển bởi phần Cài đặt quyền riêng tư của người dùng.
                  </p>
                </div>
                {isSelf ? (
                  <Link
                    to="/profile"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-primary/25 bg-primary/10 px-4 py-2 text-sm font-bold text-primary shadow-sm hover:bg-primary hover:text-primary-foreground transition-all"
                  >
                    Về hồ sơ cá nhân <ExternalLink className="w-4 h-4" />
                  </Link>
                ) : null}
              </div>
            </div>

            <ActivityMangaList
              title="Đang theo dõi"
              icon={Heart}
              items={activity.following || []}
              disabled={!settings.show_followed_manga}
              emptyText="Chưa theo dõi truyện nào công khai."
            />
            <ActivityMangaList
              title="Lịch sử đọc"
              icon={Clock}
              items={activity.history || []}
              disabled={!settings.show_reading_history}
              emptyText="Chưa có lịch sử đọc công khai."
            />
            <CommentList
              comments={activity.comments || []}
              disabled={!settings.show_comments}
            />
          </main>
        </motion.div>
      </div>
    </div>
  );
};

export default PublicProfilePage;
