import { useUserStore } from '@/store/userStore';
import { useBookmarks, useFollows, useHistory, useToggleFollow, useToggleBookmark } from '@/hooks/useApi';
import { historyApi, commentApi, mangaApi, ratingApi, userApi } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import AvatarEditorModal from '@/components/manga/AvatarEditorModal';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User, BookOpen, Heart, Bookmark, Clock, MessageCircle, BarChart3,
  Calendar, Flame, TrendingUp, ThumbsUp, ExternalLink, Settings,
  Trash2, Edit3, ListOrdered, Plus, LogOut, X,
  Star, Crown, Sparkles, ChevronLeft, ChevronRight, Loader2
} from 'lucide-react';
import ProfileCustomizeModal from '@/components/manga/ProfileCustomizeModal';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
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

type ProfileTab = 'overview' | 'following' | 'bookmarks' | 'history' | 'comments' | 'lists';

type ProfileListItem = {
  manga_slug: string;
  manga_title: string;
  manga_thumb?: string;
  manga_thumb_fallback?: string;
  created_at?: string;
  updated_at?: string;
  read_at?: string;
  last_read_at?: string;
  score?: number;
  meta?: string;
};

type ProfileCustomList = {
  id: string;
  name: string;
  items: ProfileListItem[];
  createdAt: string;
  updatedAt: string;
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const LOCAL_COVER_FALLBACK = '/no-cover.svg';

const isMangaDexImageUrl = (value?: string) => {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith('uploads.mangadex.org') || host.endsWith('mangadex.network');
  } catch {
    return false;
  }
};

const normalizeProfileCoverSources = (primary?: string, fallback?: string) => {
  const rawPrimary = String(primary || '').trim();
  const rawFallback = String(fallback || '').trim();
  if (isMangaDexImageUrl(rawPrimary)) {
    return {
      primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(rawPrimary)}`,
      fallback: LOCAL_COVER_FALLBACK,
    };
  }
  if (!rawPrimary && isMangaDexImageUrl(rawFallback)) {
    return {
      primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(rawFallback)}`,
      fallback: LOCAL_COVER_FALLBACK,
    };
  }
  return {
    primary: rawPrimary,
    fallback: isMangaDexImageUrl(rawFallback) ? LOCAL_COVER_FALLBACK : rawFallback,
  };
};

const normalizeProfileComment = (c: any) => ({
  id: String(c?.id || ''),
  manga_slug: String(c?.manga_slug || c?.mangaSlug || ''),
  mangaTitle: String(c?.manga_title || c?.mangaTitle || c?.title || '').trim(),
  chapterId: c?.chapter_id || c?.chapterId || '',
  content: String(c?.content || ''),
  createdAt: c?.created_at || c?.createdAt || new Date().toISOString(),
  likes: Number(c?.likes || 0),
  reactions: c?.reactions && typeof c.reactions === 'object' ? c.reactions : {},
});

const isUuidLikeSlug = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const normalizeMangaDexCommentId = (slug: string) => {
  const clean = String(slug || '').trim().toLowerCase();
  const raw = clean.startsWith('mdx-') ? clean.slice(4) : clean;
  return isUuidLikeSlug(raw) ? raw : '';
};

const formatMangaSlugLabel = (slug: string) => {
  const clean = String(slug || '').trim();
  if (!clean) return 'Truyện';
  if (normalizeMangaDexCommentId(clean)) return 'Đang tải tên truyện...';
  return clean
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const getProfileMangaSlug = (item: any): string =>
  String(item?.manga_slug || item?.mangaSlug || item?.slug || item?.id || '').trim();

const toProfileListItem = (item: any, fallbackTitle = ''): ProfileListItem | null => {
  const slug = getProfileMangaSlug(item);
  if (!slug) return null;

  const title = String(
    item?.manga_title ||
    item?.mangaTitle ||
    item?.title ||
    fallbackTitle ||
    formatMangaSlugLabel(slug)
  ).trim();
  const coverSources = normalizeProfileCoverSources(
    item?.manga_thumb || item?.thumb || item?.cover || item?.cover_url,
    item?.manga_thumb_fallback || item?.coverProxy,
  );

  return {
    ...item,
    manga_slug: slug,
    manga_title: title || formatMangaSlugLabel(slug),
    manga_thumb: coverSources.primary,
    manga_thumb_fallback: coverSources.fallback,
    created_at: String(item?.created_at || item?.createdAt || item?.updated_at || item?.read_at || item?.last_read_at || '').trim(),
    updated_at: String(item?.updated_at || item?.updatedAt || item?.created_at || item?.read_at || '').trim(),
    read_at: String(item?.read_at || item?.readAt || '').trim(),
    last_read_at: String(item?.last_read_at || item?.lastReadAt || '').trim(),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : undefined,
  };
};

const uniqueProfileListItems = (items: any[], titleBySlug: Record<string, string> = {}): ProfileListItem[] => {
  const bySlug = new Map<string, ProfileListItem>();
  for (const item of items || []) {
    const slug = getProfileMangaSlug(item);
    const normalized = toProfileListItem(item, titleBySlug[slug]);
    if (!normalized) continue;

    const current = bySlug.get(normalized.manga_slug);
    if (!current) {
      bySlug.set(normalized.manga_slug, normalized);
      continue;
    }

    bySlug.set(normalized.manga_slug, {
      ...current,
      ...normalized,
      manga_title: normalized.manga_title || current.manga_title,
      manga_thumb: normalized.manga_thumb || current.manga_thumb,
      manga_thumb_fallback: normalized.manga_thumb_fallback || current.manga_thumb_fallback,
    });
  }
  return Array.from(bySlug.values());
};

const buildCommentListItems = (
  comments: any[],
  mangaTitleBySlug: Record<string, string>,
): ProfileListItem[] => {
  const bySlug = new Map<string, ProfileListItem & { comment_count: number }>();

  for (const raw of comments || []) {
    const comment = normalizeProfileComment(raw);
    const slug = String(comment.manga_slug || '').trim();
    if (!slug) continue;

    const current = bySlug.get(slug);
    const title = comment.mangaTitle || mangaTitleBySlug[slug] || formatMangaSlugLabel(slug);
    const createdAt = comment.createdAt || new Date().toISOString();
    const nextCount = (current?.comment_count || 0) + 1;
    bySlug.set(slug, {
      manga_slug: slug,
      manga_title: current?.manga_title && current.manga_title !== formatMangaSlugLabel(slug)
        ? current.manga_title
        : title,
      created_at: current?.created_at && current.created_at > createdAt ? current.created_at : createdAt,
      meta: `${nextCount} bình luận`,
      comment_count: nextCount,
    });
  }

  return Array.from(bySlug.values()).sort((a, b) =>
    new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  );
};

const getCustomListsStorageKey = (userId: string) => `manga-profile-custom-lists:${userId || 'anonymous'}`;

const readCustomLists = (storageKey: string): ProfileCustomList[] => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((list: any) => ({
        id: String(list?.id || crypto.randomUUID?.() || `list-${Date.now()}`),
        name: String(list?.name || '').trim(),
        items: uniqueProfileListItems(Array.isArray(list?.items) ? list.items : []),
        createdAt: String(list?.createdAt || new Date().toISOString()),
        updatedAt: String(list?.updatedAt || list?.createdAt || new Date().toISOString()),
      }))
      .filter((list: ProfileCustomList) => list.name);
  } catch {
    return [];
  }
};

const fetchMangaDexCommentTitleMap = async (ids: string[]) => {
  const uniqueIds = Array.from(new Set(ids.map((id) => normalizeMangaDexCommentId(id)).filter(Boolean))).slice(0, 30);
  const entries = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const payload = await mangaApi.getMangaDexLookup(id, { timeoutMs: 6_000 });
        const title = String(payload?.manga?.title || '').trim();
        return title ? [id, title] as const : null;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>);
};

const Profile = () => {
  const { user, updateProfile, uploadAvatar, logout } = useUserStore();
  const toggleFollowMutation = useToggleFollow();
  const toggleBookmarkMutation = useToggleBookmark();
  const qc = useQueryClient();

  const toggleFollow = (slug: string) => {
    toggleFollowMutation.mutate({ slug, title: '', thumb: '', isFollowing: true });
  };
  const toggleBookmark = (slug: string) => {
    toggleBookmarkMutation.mutate({ slug, title: '', thumb: '', isBookmarked: true });
  };
  const removeHistoryItem = async (slug: string) => {
    await historyApi.remove(slug);
    qc.invalidateQueries({ queryKey: ['history'], refetchType: 'active' });
  };
  const clearHistory = async () => {
    if (!confirm('Xoá tất cả lịch sử đọc?')) return;
    await historyApi.clear();
    qc.invalidateQueries({ queryKey: ['history'], refetchType: 'active' });
  };
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [tab, setTab] = useState<ProfileTab>('overview');
  const [historySort, setHistorySort] = useState<'recent' | 'alpha' | 'progress'>('recent');
  const [bookmarkSort, setBookmarkSort] = useState<'recent' | 'alpha' | 'lastread'>('recent');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const clearPendingAvatar = () => {
    if (pendingAvatarPreview) {
      URL.revokeObjectURL(pendingAvatarPreview);
    }
    setPendingAvatarFile(null);
    setPendingAvatarPreview('');
  };

  const handleFile = (file: File) => {
    if (!file.type.match(/image\/(png|jpe?g|webp|gif)/)) { toast.error('Chỉ hỗ trợ PNG, JPG, WEBP hoặc GIF'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Ảnh vượt quá 5MB'); return; }

    if (pendingAvatarPreview) {
      URL.revokeObjectURL(pendingAvatarPreview);
    }
    const preview = URL.createObjectURL(file);
    setPendingAvatarFile(file);
    setPendingAvatarPreview(preview);
    setAvatarEditorOpen(true);
  };

  const handleConfirmAvatarCrop = async (cropArea: { x: number; y: number; width: number; height: number }) => {
    if (!pendingAvatarFile) return;
    setIsUploadingAvatar(true);
    try {
      const res = await uploadAvatar(pendingAvatarFile, cropArea);
      if (!res.success || !res.avatarUrl) {
        toast.error(res.error || 'Upload avatar thất bại');
        return;
      }
      setAvatar(res.avatarUrl);
      qc.invalidateQueries({ queryKey: ['public-profile'] });
      setAvatarEditorOpen(false);
      clearPendingAvatar();
      toast.success('Đã cập nhật ảnh đại diện!');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pendingAvatarPreview) {
        URL.revokeObjectURL(pendingAvatarPreview);
      }
    };
  }, [pendingAvatarPreview]);

  useEffect(() => {
    if (!user) return;
    setAvatar(user.avatar || null);
  }, [user?.avatar]);

  const { data: followedManga = [] } = useFollows();
  const { data: bookmarkedManga = [] } = useBookmarks();
  const { data: historyItems = [] } = useHistory({ enrichThumbs: false });
  const { data: profileStatsPayload } = useQuery({
    queryKey: ['users', 'stats', 'profile', user?.id || 'anonymous'],
    queryFn: userApi.getStats,
    enabled: !!user,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const profileStats = (profileStatsPayload as any)?.stats || user?.stats || {};
  const {
    data: profileComments = [],
    isFetching: profileCommentsFetching,
  } = useQuery({
    queryKey: ['comments', 'me', 'profile', user?.id || user?.username || 'anonymous'],
    queryFn: async () => {
      const res = await commentApi.getMine(1, 100);
      return (Array.isArray(res?.comments) ? res.comments : []).map((c: any) => normalizeProfileComment(c));
    },
    enabled: !!user,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const {
    data: profileRatedPayload,
    isFetching: profileRatedFetching,
  } = useQuery({
    queryKey: ['ratings', 'me', 'profile', user?.id || user?.username || 'anonymous'],
    queryFn: () => ratingApi.getMyRatedManga(200),
    enabled: !!user,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const commentsCount = profileComments.length;
  const ratedManga = useMemo(
    () => uniqueProfileListItems(((profileRatedPayload as any)?.items || []).map((item: any) => ({
      ...item,
      manga_title: item.title || item.manga_title,
      manga_thumb: item.thumb || item.manga_thumb,
      created_at: item.updated_at || item.created_at,
      meta: item.score ? `${item.score} sao` : undefined,
    }))),
    [profileRatedPayload],
  );
  const profileMangaTitleBySlug = useMemo(() => {
    const titleBySlug: Record<string, string> = {};
    const addTitle = (item: any) => {
      const slug = String(item?.manga_slug || item?.mangaSlug || item?.id || item?.slug || '').trim();
      const title = String(item?.manga_title || item?.mangaTitle || item?.title || '').trim();
      if (slug && title && title !== slug && !titleBySlug[slug]) {
        titleBySlug[slug] = title;
      }
    };

    followedManga.forEach(addTitle);
    bookmarkedManga.forEach(addTitle);
    historyItems.forEach(addTitle);
    profileComments.forEach(addTitle);

    return titleBySlug;
  }, [bookmarkedManga, followedManga, historyItems, profileComments]);
  const profileListCount = useMemo(() => {
    return [
      followedManga.length,
      bookmarkedManga.length,
      historyItems.length,
      profileComments.length,
      ratedManga.length,
    ].filter((count) => count > 0).length;
  }, [bookmarkedManga.length, followedManga.length, historyItems.length, profileComments.length, ratedManga.length]);

  if (!user) {
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <User className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
        <p className="text-muted-foreground font-medium text-lg">Vui lòng đăng nhập để xem hồ sơ.</p>
      </div>
    );
  }

  const publicProfilePath = `/u/${encodeURIComponent(user.username || user.id)}`;
  const profileNameFont = normalizeNameFontForAccess(user.nameFont, user);
  const profileNameEffect = normalizeNameEffectForAccess(user.nameEffect, user);

  const tabs: { key: ProfileTab; label: string; icon: any; count?: number }[] = [
    { key: 'overview', label: 'Tổng quan', icon: BarChart3 },
    { key: 'following', label: 'Theo dõi', icon: Heart, count: followedManga.length },
    { key: 'bookmarks', label: 'Đã lưu', icon: Bookmark, count: bookmarkedManga.length },
    { key: 'history', label: 'Lịch sử', icon: Clock, count: historyItems.length },
    { key: 'comments', label: 'Bình luận', icon: MessageCircle, count: commentsCount },
    { key: 'lists', label: 'Danh sách', icon: ListOrdered, count: profileListCount },
  ];

  return (
    <div className="min-h-screen">
      {/* Profile Banner */}
      <div className="relative h-28 md:h-36 overflow-hidden bg-muted">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-background" />
      </div>

      <div className="container mx-auto px-4 -mt-20 relative z-10 max-w-7xl">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left Sidebar */}
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="lg:w-72 shrink-0">
            <div className="bg-card border border-border/50 rounded-2xl p-5 lg:sticky lg:top-20">
              {/* Avatar */}
              <div className="flex flex-col items-center text-center mb-5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
                />
                {/* Avatar */}
                <div className="relative mb-3">
                  <div
                    className={`relative w-24 h-24 rounded-2xl ring-1 shadow-md cursor-pointer group transition-transform hover:scale-105 z-10 ${
                      isDragging ? 'ring-primary/60 scale-105' : 'ring-border/40'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) void handleFile(f); }}
                  >
                    {(avatar || user.avatar)
                      ? <img src={avatar || user.avatar} alt="Avatar" className="w-full h-full object-cover rounded-2xl" />
                      : <div className="w-full h-full rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                          <span className="text-4xl font-bold text-primary-foreground">{user.username.charAt(0)}</span>
                        </div>
                    }
                    <div className={`absolute inset-0 rounded-2xl bg-background/60 flex flex-col items-center justify-center gap-1 transition-opacity ${isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {isUploadingAvatar ? <Loader2 className="w-5 h-5 text-foreground animate-spin" /> : <Edit3 className="w-5 h-5 text-foreground" />}
                      <span className="text-[10px] font-bold text-foreground">{isUploadingAvatar ? 'Đang tải...' : isDragging ? 'Thả ảnh' : 'Đổi ảnh'}</span>
                    </div>
                  </div>
                </div>
                {(avatar || user.avatar) && (
                  <button
                    onClick={() => {
                      setAvatar(null);
                      updateProfile({ avatar: '' });
                      qc.invalidateQueries({ queryKey: ['public-profile'] });
                      toast.success('Đã xóa ảnh đại diện');
                    }}
                    className="mb-2 text-[10px] text-destructive/70 hover:text-destructive font-bold transition-colors"
                  >Xoá ảnh</button>
                )}
                {/* Custom Name + VIP */}
                <h2 className="text-xl font-bold flex items-center gap-1.5 flex-wrap justify-center">
                  <span
                    className={`${getNameFontClass(profileNameFont)} ${getNameEffectClass(profileNameEffect)}`}
                    style={{
                      ...(user.nameColor && profileNameEffect !== 'gradient' ? { color: user.nameColor } : {}),
                      ...getNameEffectStyle(profileNameEffect, user.nameColor),
                    }}
                  >
                    {user.displayName || user.username}
                  </span>
                  {user.isVip && (
                    <span className={NAME_VIP_BADGE_CLASS}>
                      <Crown className={NAME_VIP_BADGE_ICON_CLASS} />
                      VIP
                    </span>
                  )}
                </h2>
                <p className="text-sm text-muted-foreground">@{user.username}</p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap justify-center">
                  <span className="px-2.5 py-0.5 rounded-lg bg-primary/20 text-primary text-xs font-bold uppercase">{user.role}</span>
                  {user.isVip && user.vipExpiry && (
                    <span className="px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-500 text-[10px] font-bold">
                      VIP đến {new Date(user.vipExpiry).toLocaleDateString('vi-VN')}
                    </span>
                  )}
                </div>
              </div>

              {user.bio && <p className="text-xs text-muted-foreground text-center mb-4 leading-relaxed">{user.bio}</p>}

              <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground mb-5">
                <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> {new Date(user.joinDate).toLocaleDateString('vi-VN')}</span>
                <span className="flex items-center gap-1"><Flame className="w-3.5 h-3.5 text-orange-400" /> {user.stats.readingStreak > 0 ? `${user.stats.readingStreak} ngày` : 'Chưa có chuỗi'}</span>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-2 mb-5">
                {[
                  { label: 'Theo dõi', value: followedManga?.length || 0, icon: Heart, color: 'text-red-400' },
                  { label: 'Đã đọc', value: user.stats.chaptersRead, icon: BookOpen, color: 'text-primary' },
                  { label: 'Đã lưu', value: bookmarkedManga?.length || 0, icon: Bookmark, color: 'text-yellow-400' },
                  { label: 'Bình luận', value: commentsCount, icon: MessageCircle, color: 'text-green-400' },
                ].map(s => (
                  <div key={s.label} className="bg-secondary/30 rounded-xl p-3 text-center group cursor-default" title={`${s.value} ${s.label}`}>
                    <s.icon className={`w-4 h-4 ${s.color} mx-auto mb-1`} />
                    <p className="text-lg font-bold">{s.value}</p>
                    <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Quick links */}
              <div className="space-y-1">
                <button
                  onClick={() => setCustomizeOpen(true)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-bold text-primary hover:bg-primary/10 transition-all"
                >
                  <Sparkles className="w-4 h-4" /> Tuỳ chỉnh hồ sơ
                </button>
                <Link to="/settings" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all">
                  <Settings className="w-4 h-4" /> Chỉnh sửa hồ sơ
                </Link>
                <Link to={publicProfilePath} className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all">
                  <ExternalLink className="w-4 h-4" /> Xem hồ sơ công khai
                </Link>
                <Link to="/settings" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all">
                  <User className="w-4 h-4" /> Cài đặt tài khoản
                </Link>
                <button onClick={() => { logout(); window.location.href = '/'; }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-destructive/70 hover:text-destructive hover:bg-destructive/5 transition-all">
                  <LogOut className="w-4 h-4" /> Đăng xuất
                </button>
              </div>
            </div>
          </motion.div>

          {/* Center Content */}
          <div className="flex-1 min-w-0">
            {/* Tabs */}
            <div className="relative mb-6 overflow-hidden">
              <div className="flex gap-1 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-px">
                {tabs.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`relative flex items-center gap-1.5 px-2.5 py-2.5 text-xs sm:text-sm font-bold transition-all whitespace-nowrap shrink-0 ${
                      tab === t.key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <t.icon className="w-4 h-4" />
                    {tab === t.key && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: 'auto', opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        className="overflow-hidden"
                      >
                        {t.label}
                      </motion.span>
                    )}
                    {t.count !== undefined && tab === t.key && (
                      <span className="px-1.5 py-0.5 rounded-full bg-secondary text-[10px] font-bold">{t.count}</span>
                    )}
                    {tab === t.key && (
                      <motion.div
                        layoutId="profile-tab-indicator"
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"
                        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                      />
                    )}
                  </button>
                ))}
              </div>
              {/* Fade hint for scroll on mobile */}
              <div className="absolute right-0 top-0 bottom-px w-6 bg-gradient-to-l from-background to-transparent pointer-events-none sm:hidden" />
            </div>

            <AnimatePresence mode="wait">
              <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
                {tab === 'overview' && <OverviewTab user={user} stats={profileStats} followedManga={followedManga} historyItems={historyItems} />}
                {tab === 'following' && <FollowingTab manga={followedManga} onUnfollow={toggleFollow} />}
                {tab === 'bookmarks' && <BookmarksTab manga={bookmarkedManga} onRemove={toggleBookmark} sort={bookmarkSort} setSort={setBookmarkSort} />}
                {tab === 'history' && <HistoryTab items={historyItems} onRemove={removeHistoryItem} onClear={clearHistory} sort={historySort} setSort={setHistorySort} />}
                {tab === 'comments' && <CommentsTab comments={profileComments} mangaTitleBySlug={profileMangaTitleBySlug} loading={profileCommentsFetching && profileComments.length === 0} />}
                {tab === 'lists' && (
                  <ListsTab
                    userId={user.id || user.username}
                    followedManga={followedManga}
                    bookmarkedManga={bookmarkedManga}
                    historyItems={historyItems}
                    comments={profileComments}
                    mangaTitleBySlug={profileMangaTitleBySlug}
                    ratedManga={ratedManga}
                    ratedLoading={profileRatedFetching && ratedManga.length === 0}
                    onSelectTab={setTab}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

        </div>
      </div>
      <ProfileCustomizeModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        user={user}
        onSave={(data) => {
          updateProfile(data);
          qc.invalidateQueries({ queryKey: ['public-profile'] });
          toast.success('Đã cập nhật tuỳ chỉnh hồ sơ!');
        }}
      />
      <AvatarEditorModal
        open={avatarEditorOpen}
        imageSrc={pendingAvatarPreview}
        loading={isUploadingAvatar}
        onCancel={() => {
          setAvatarEditorOpen(false);
          clearPendingAvatar();
        }}
        onConfirm={handleConfirmAvatarCrop}
      />
    </div>
  );
};

/* === OVERVIEW TAB === */
const OverviewTab = ({ user, stats, followedManga, historyItems }: { user: any; stats: any; followedManga: any[]; historyItems: any[] }) => {
  const { labels, weeklyActivity } = (() => {
    const now = new Date();
    const result = [];
    
    // Tìm ngày Thứ 2 của tuần hiện tại (local time)
    const d = new Date(now);
    const day = d.getDay(); // 0=CN, 1=T2, ..., 6=T7
    const diff = d.getDate() - (day === 0 ? 6 : day - 1); // Lùi về Thứ 2
    const monday = new Date(d.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    
    // Tạo 7 ngày từ Thứ 2 đến Chủ Nhật
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const dayOfMonth = String(date.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${dayOfMonth}`;
      
      result.push({
        key: dateKey,
        label: i === 6 ? 'CN' : `T${i + 2}`,
        count: 0
      });
    }

    // Đếm số lượng truyện đã đọc theo ngày (local time)
    for (const item of historyItems || []) {
      const raw = item?.read_at || item?.created_at;
      if (!raw) continue;
      
      const itemDate = new Date(raw);
      const year = itemDate.getFullYear();
      const month = String(itemDate.getMonth() + 1).padStart(2, '0');
      const day = String(itemDate.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;
      
      const dayData = result.find(r => r.key === dateKey);
      if (dayData) dayData.count += 1;
    }
    
    return {
      labels: result.map(r => r.label),
      weeklyActivity: result.map(r => r.count)
    };
  })();

  const rawStatsWeeklyActivity = Array.isArray(stats?.weekly_activity)
    ? stats.weekly_activity
    : Array.isArray(stats?.weeklyActivity)
      ? stats.weeklyActivity
      : [];
  const statsWeeklyActivity = Array.isArray(rawStatsWeeklyActivity)
    ? rawStatsWeeklyActivity.map((value: unknown) => Math.max(0, Number(value) || 0)).slice(-7)
    : [];
  const activityLabels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    const day = date.getDay();
    return day === 0 ? 'CN' : `T${day + 1}`;
  });
  const displayedWeeklyActivity =
    statsWeeklyActivity.length === 7 ? statsWeeklyActivity : weeklyActivity;
  const displayedLabels =
    statsWeeklyActivity.length === 7 ? activityLabels : labels;
  const maxActivity = Math.max(...displayedWeeklyActivity, 1);

  return (
    <div className="space-y-6">
      <div className="p-5 rounded-xl bg-card border border-border/50">
        <h3 className="text-sm font-bold mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-primary" /> Hoạt động đọc trong tuần</h3>
        <div className="flex items-end gap-2 h-24 sm:h-28">
          {displayedWeeklyActivity.map((count: number, i: number) => (
            <div key={i} className="flex-1 h-full flex flex-col items-center gap-1">
              <span className={`text-[10px] font-bold ${count > 0 ? 'text-muted-foreground' : 'text-muted-foreground/30'}`}>{count}</span>
              <div className="w-full flex-1 flex items-end">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${(count / maxActivity) * 100}%` }}
                  transition={{ delay: i * 0.05, duration: 0.4 }}
                  className={`w-full rounded-t-lg transition-colors ${count > 0 ? 'bg-primary shadow-[0_-4px_12px_-2px_rgba(var(--primary),0.3)]' : 'bg-primary/10'}`}
                  style={{ minHeight: 4 }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">{displayedLabels[i]}</span>
            </div>
          ))}
        </div>
      </div>

      {historyItems.length > 0 && (
        <div>
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-primary" /> Đọc gần đây</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {historyItems.slice(0, 4).map((item: any) => (
              <Link key={item.manga_slug} to={getMangaDetailPath(item.manga_id || item.manga_slug)} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/50 hover:border-primary/30 transition-all group">
                <OptimizedImage src={item.manga_thumb || ''} fallbackSrc={item.manga_thumb_fallback || undefined} alt="" className="w-12 h-16 rounded-lg object-cover border border-border/50" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold line-clamp-1 group-hover:text-primary transition-colors">{item.manga_title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.chapter_name || 'Chương ?'} · {item.progress || 0}%</p>
                  <div className="w-full h-1.5 rounded-full bg-secondary mt-1.5">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${item.progress || 0}%` }} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {historyItems.length > 4 && (
            <Link to="/history" className="flex items-center justify-center gap-1 mt-3 text-xs font-semibold text-primary hover:underline">
              Xem tất cả ({historyItems.length}) →
            </Link>
          )}
        </div>
      )}

      {followedManga.length > 0 && (
        <div>
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2"><Heart className="w-4 h-4 text-red-400" /> Đang theo dõi</h3>
          <div className="relative group/scroll">
            <div id="followed-scroll" className="flex gap-3 overflow-x-auto scrollbar-hide pb-2 scroll-smooth">
              {followedManga.slice(0, 6).map((m: any) => (
                <Link key={m.manga_slug || m.id} to={getMangaDetailPath(m.id || m.manga_id || m.manga_slug)} className="shrink-0 w-28 group">
                  <OptimizedImage src={m.manga_thumb || m.cover || ''} fallbackSrc={m.manga_thumb_fallback || undefined} alt="" className="w-28 h-40 rounded-xl object-cover border border-border/50 group-hover:border-primary/50 transition-all" />
                  <p className="text-xs font-bold mt-1.5 line-clamp-2 group-hover:text-primary transition-colors">{m.manga_title || m.title}</p>
                </Link>
              ))}
            </div>
            <button
              onClick={() => document.getElementById('followed-scroll')?.scrollBy({ left: -200, behavior: 'smooth' })}
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 w-7 h-7 rounded-full bg-background/90 border border-border shadow-md flex items-center justify-center opacity-0 group-hover/scroll:opacity-100 transition-opacity z-10"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => document.getElementById('followed-scroll')?.scrollBy({ left: 200, behavior: 'smooth' })}
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 w-7 h-7 rounded-full bg-background/90 border border-border shadow-md flex items-center justify-center opacity-0 group-hover/scroll:opacity-100 transition-opacity z-10"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {followedManga.length > 6 && (
            <Link to="/bookmarks" className="flex items-center justify-center gap-1 mt-3 text-xs font-semibold text-primary hover:underline">
              Xem tất cả ({followedManga.length}) →
            </Link>
          )}
        </div>
      )}
    </div>
  );
};

/* === FOLLOWING TAB === */
const FOLLOW_LIMIT = 12;
const FollowingTab = ({ manga, onUnfollow }: { manga: any[]; onUnfollow: (id: string) => void }) => {
  const [showAll, setShowAll] = useState(false);
  if (manga.length === 0) return <EmptyState icon={<Heart className="w-10 h-10 text-muted-foreground/30" />} text="Chưa theo dõi truyện nào" sub="Khám phá truyện mới và bấm theo dõi!" />;
  const displayed = showAll ? manga : manga.slice(0, FOLLOW_LIMIT);
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {displayed.map((m: any) => (
          <div key={m.manga_slug || m.id} className="group relative">
            <Link to={getMangaDetailPath(m.id || m.manga_id || m.manga_slug)}>
              <OptimizedImage src={m.manga_thumb || m.cover || ''} fallbackSrc={m.manga_thumb_fallback || undefined} alt={m.manga_title || m.title} className="w-full aspect-[2/3] object-cover rounded-xl border border-border/50 group-hover:border-primary/50 transition-all" />
              <p className="text-xs font-bold mt-1.5 line-clamp-2 group-hover:text-primary transition-colors">{m.manga_title || m.title}</p>
            </Link>
            <button onClick={() => { onUnfollow(m.manga_slug || m.id); toast.success('Đã bỏ theo dõi'); }}
              className="absolute top-2 right-2 p-1.5 rounded-lg bg-card/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/20 hover:text-destructive">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      {!showAll && manga.length > FOLLOW_LIMIT && (
        <button onClick={() => setShowAll(true)} className="flex items-center justify-center gap-1 mt-4 mx-auto text-xs font-semibold text-primary hover:underline">
          Xem tất cả ({manga.length}) →
        </button>
      )}
    </div>
  );
};

/* === BOOKMARKS TAB === */
const BOOKMARK_LIMIT = 8;
const BookmarksTab = ({ manga, onRemove, sort, setSort }: { manga: any[]; onRemove: (id: string) => void; sort: string; setSort: (s: any) => void }) => {
  const [showAll, setShowAll] = useState(false);
  if (manga.length === 0) return <EmptyState icon={<Bookmark className="w-10 h-10 text-muted-foreground/30" />} text="Chưa lưu truyện nào" sub="Lưu truyện yêu thích để đọc sau!" />;

  const sorted = [...manga].sort((a, b) => {
    if (sort === 'alpha') return (a.manga_title || a.title || '').localeCompare(b.manga_title || b.title || '');
    return 0;
  });
  const displayed = showAll ? sorted : sorted.slice(0, BOOKMARK_LIMIT);

  return (
    <div>
      <div className="flex gap-1.5 mb-4">
        {[
          { key: 'recent', label: 'Mới nhất' },
          { key: 'alpha', label: 'A-Z' },
          { key: 'lastread', label: 'Đọc gần đây' },
        ].map(s => (
          <button key={s.key} onClick={() => setSort(s.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${sort === s.key ? 'bg-primary text-primary-foreground' : 'bg-secondary/50 text-muted-foreground hover:text-foreground'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {displayed.map((m: any) => (
          <div key={m.manga_slug || m.id} className="flex items-center gap-4 p-3 rounded-xl bg-card border border-border/50 hover:border-primary/30 transition-all group">
            <Link to={getMangaDetailPath(m.id || m.manga_id || m.manga_slug)} className="flex items-center gap-4 flex-1 min-w-0">
              <OptimizedImage src={m.manga_thumb || m.cover || ''} fallbackSrc={m.manga_thumb_fallback || undefined} alt="" className="w-12 h-16 rounded-lg object-cover border border-border/50 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-bold line-clamp-1 group-hover:text-primary transition-colors">{m.manga_title || m.title}</p>
              </div>
            </Link>
            <button onClick={() => { onRemove(m.manga_slug || m.id); toast.success('Đã xoá khỏi danh sách lưu'); }}
              className="p-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100 shrink-0">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      {!showAll && sorted.length > BOOKMARK_LIMIT && (
        <button onClick={() => setShowAll(true)} className="flex items-center justify-center gap-1 mt-4 mx-auto text-xs font-semibold text-primary hover:underline">
          Xem tất cả ({sorted.length}) →
        </button>
      )}
    </div>
  );
};

/* === HISTORY TAB === */
const HISTORY_LIMIT = 6;
const HistoryTab = ({ items, onRemove, onClear, sort, setSort }: { items: any[]; onRemove: (id: string) => void; onClear: () => void; sort: string; setSort: (s: any) => void }) => {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return <EmptyState icon={<BookOpen className="w-10 h-10 text-muted-foreground/30" />} text="Chưa có lịch sử đọc" sub="Bắt đầu đọc truyện để xem lịch sử!" />;

  const sorted = [...items].sort((a, b) => {
    if (sort === 'alpha') return (a.manga_title || '').localeCompare(b.manga_title || '');
    if (sort === 'progress') return (b.progress || 0) - (a.progress || 0);
    return new Date(b.last_read_at || b.created_at || 0).getTime() - new Date(a.last_read_at || a.created_at || 0).getTime();
  });
  const displayed = showAll ? sorted : sorted.slice(0, HISTORY_LIMIT);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1.5">
          {[
            { key: 'recent', label: 'Gần đây' },
            { key: 'alpha', label: 'A-Z' },
            { key: 'progress', label: 'Tiến độ' },
          ].map(s => (
            <button key={s.key} onClick={() => setSort(s.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${sort === s.key ? 'bg-primary text-primary-foreground' : 'bg-secondary/50 text-muted-foreground hover:text-foreground'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <button onClick={() => { onClear(); toast.success('Đã xoá lịch sử'); }}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-destructive/70 hover:text-destructive hover:bg-destructive/5 transition-all flex items-center gap-1">
          <Trash2 className="w-3 h-3" /> Xoá tất cả
        </button>
      </div>
      <div className="space-y-2">
        {displayed.map((item: any, i: number) => (
          <motion.div key={item.manga_slug || i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
            <div className="flex items-center gap-4 p-4 rounded-xl bg-card border border-border/50 hover:border-primary/30 transition-all group">
              <OptimizedImage src={item.manga_thumb || ''} fallbackSrc={item.manga_thumb_fallback || undefined} alt="" className="w-14 h-20 object-cover rounded-lg border border-border/50 shrink-0" />
              <div className="flex-1 min-w-0">
                <Link to={getMangaDetailPath(item.manga_id || item.manga_slug)} className="block">
                  <h3 className="text-sm font-bold line-clamp-1 group-hover:text-primary transition-colors">{item.manga_title}</h3>
                </Link>
                <p className="text-xs text-muted-foreground mt-1">{item.chapter_name || 'Chương ?'}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex-1 h-1.5 rounded-full bg-secondary max-w-[140px]">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${item.progress || 0}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-foreground font-bold">{item.progress || 0}%</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">{timeAgoVi(item.last_read_at || item.created_at || '')}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Link to={getMangaDetailPath(item.manga_id || item.manga_slug)} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                  Tiếp tục
                </Link>
                <button onClick={() => { onRemove(item.manga_slug); toast.success('Đã xoá'); }}
                  className="p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
      {!showAll && sorted.length > HISTORY_LIMIT && (
        <button onClick={() => setShowAll(true)} className="flex items-center justify-center gap-1 mt-4 mx-auto text-xs font-semibold text-primary hover:underline">
          Xem tất cả ({sorted.length}) →
        </button>
      )}
    </div>
  );
};

/* === COMMENTS TAB === */
const COMMENT_LIMIT = 5;
const CommentsTab = ({ comments: initialComments, mangaTitleBySlug, loading = false }: { comments: any[]; mangaTitleBySlug: Record<string, string>; loading?: boolean }) => {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [comments, setComments] = useState<any[]>((Array.isArray(initialComments) ? initialComments : []).map((c: any) => normalizeProfileComment(c)));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setComments((Array.isArray(initialComments) ? initialComments : []).map((c: any) => normalizeProfileComment(c)));
  }, [initialComments]);

  const titleLookupIds = useMemo(() => {
    const visibleComments = (Array.isArray(comments) ? comments : []).slice(0, showAll ? 30 : COMMENT_LIMIT);
    return Array.from(new Set(
      visibleComments
        .filter((comment: any) => {
          const slug = String(comment?.manga_slug || comment?.mangaSlug || '').trim();
          return normalizeMangaDexCommentId(slug) && !comment?.mangaTitle && !mangaTitleBySlug[slug];
        })
        .map((comment: any) => normalizeMangaDexCommentId(comment?.manga_slug || comment?.mangaSlug || ''))
        .filter(Boolean),
    ));
  }, [comments, mangaTitleBySlug, showAll]);

  const { data: mangaDexTitleById = {} } = useQuery({
    queryKey: ['comments', 'me', 'profile', 'mangadex-title-lookup', titleLookupIds.join(',')],
    queryFn: () => fetchMangaDexCommentTitleMap(titleLookupIds),
    enabled: titleLookupIds.length > 0,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const handleDelete = async (id: string) => {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      await commentApi.delete(id);
      setComments(prev => {
        const next = prev.filter(c => c.id !== id);
        return next;
      });
      queryClient.setQueriesData({ queryKey: ['comments', 'me', 'profile'] }, (old: any) => (
        Array.isArray(old) ? old.filter((c: any) => normalizeProfileComment(c).id !== id) : old
      ));
      toast.success('Đã xoá bình luận');
    } catch { toast.error('Không thể xoá bình luận'); }
    finally {
      setDeleting(false);
      setDeleteTargetId(null);
    }
  };

  const handleEdit = async (id: string) => {
    if (!editText.trim()) return;
    try {
      await commentApi.update(id, editText.trim());
      setComments(prev => prev.map(c => c.id === id ? { ...c, content: editText.trim() } : c));
      queryClient.setQueriesData({ queryKey: ['comments', 'me', 'profile'] }, (old: any) => (
        Array.isArray(old)
          ? old.map((c: any) => normalizeProfileComment(c).id === id ? { ...normalizeProfileComment(c), content: editText.trim() } : c)
          : old
      ));
      setEditingId(null);
      toast.success('Đã cập nhật bình luận');
    } catch { toast.error('Không thể cập nhật bình luận'); }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (comments.length === 0) return <EmptyState icon={<MessageCircle className="w-10 h-10 text-muted-foreground/30" />} text="Chưa có bình luận nào" sub="Tham gia thảo luận về các chapter yêu thích!" />;
  const safeComments = (Array.isArray(comments) ? comments : []).map((c: any) => normalizeProfileComment(c));
  const displayed = showAll ? safeComments : safeComments.slice(0, COMMENT_LIMIT);

  return (
    <div>
      <div className="space-y-2">
        {displayed.map((c: any, i: number) => {
          const mangaSlug = c.manga_slug || c.mangaSlug || '';
          const mangaDexId = normalizeMangaDexCommentId(mangaSlug);
          const mangaTitle = c.mangaTitle || mangaTitleBySlug[mangaSlug] || (mangaDexId ? mangaDexTitleById[mangaDexId] : '') || formatMangaSlugLabel(mangaSlug);
          return (
            <motion.div key={c.id || `comment-${i}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <div className="p-4 rounded-xl bg-card border border-border/50 hover:border-primary/30 transition-colors group">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {mangaSlug && (
                      <Link to={getMangaDetailPath(mangaSlug)} className="text-xs font-bold text-primary hover:underline flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" /> {mangaTitle}
                      </Link>
                    )}
                    <span className="text-[10px] text-muted-foreground">· {timeAgoVi(c.createdAt || '')}</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingId(c.id); setEditText(c.content); }} className="p-1 rounded hover:bg-secondary transition-colors"><Edit3 className="w-3 h-3 text-muted-foreground" /></button>
                    <button onClick={() => setDeleteTargetId(c.id)} className="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>
                {editingId === c.id ? (
                  <div className="flex gap-2 items-start">
                    <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2}
                      className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50" />
                    <button onClick={() => handleEdit(c.id)} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold">Lưu</button>
                    <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-bold">Huỷ</button>
                  </div>
                ) : (
                  <p className="text-sm text-foreground/90">{c.content}</p>
                )}
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1"><ThumbsUp className="w-3 h-3" /> {c.likes}</span>
                  {c.reactions && Object.keys(c.reactions).length > 0 && (
                    <div className="flex items-center gap-1">
                      {Object.entries(c.reactions).map(([emoji, count]: [string, number]) => (
                        <span key={emoji} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-[10px] font-medium">
                          {emoji} {count}
                        </span>
                      ))}
                    </div>
                  )}
                  {mangaSlug && (
                    c.chapterId ? (
                      <Link to={`/chapter/${c.chapterId}`} state={{ mangaSlug }} className="ml-auto text-primary hover:underline text-[10px]">
                        Xem chapter →
                      </Link>
                    ) : (
                      <Link to={getMangaDetailPath(mangaSlug)} className="ml-auto text-primary hover:underline text-[10px]">
                        Xem truyện →
                      </Link>
                    )
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
      {!showAll && comments.length > COMMENT_LIMIT && (
        <button onClick={() => setShowAll(true)} className="flex items-center justify-center gap-1 mt-4 mx-auto text-xs font-semibold text-primary hover:underline">
          Xem tất cả ({comments.length}) →
        </button>
      )}

      <AnimatePresence>
        {deleteTargetId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => !deleting && setDeleteTargetId(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm bg-card border border-border rounded-2xl p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-bold mb-1">Xóa bình luận</p>
              <p className="text-xs text-muted-foreground mb-4">Bạn có chắc muốn xóa bình luận này? Hành động này không thể hoàn tác.</p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteTargetId(null)}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  Hủy
                </button>
                <button
                  onClick={() => handleDelete(deleteTargetId)}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg bg-destructive text-destructive-foreground text-xs font-semibold disabled:opacity-50"
                >
                  {deleting ? 'Đang xóa...' : 'Xóa'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* === LISTS TAB === */
const ListsTab = ({
  userId,
  followedManga,
  bookmarkedManga,
  historyItems,
  comments,
  mangaTitleBySlug,
  ratedManga,
  ratedLoading = false,
  onSelectTab,
}: {
  userId: string;
  followedManga: any[];
  bookmarkedManga: any[];
  historyItems: any[];
  comments: any[];
  mangaTitleBySlug: Record<string, string>;
  ratedManga: ProfileListItem[];
  ratedLoading?: boolean;
  onSelectTab: (tab: ProfileTab) => void;
}) => {
  const storageKey = getCustomListsStorageKey(userId);
  const [activeListId, setActiveListId] = useState('bookmarks');
  const [customLists, setCustomLists] = useState<ProfileCustomList[]>(() => readCustomLists(storageKey));
  const [listDialog, setListDialog] = useState<{
    type: 'create' | 'rename' | 'add-item';
    listId?: string;
  } | null>(null);
  const [listNameInput, setListNameInput] = useState('');
  const [itemSlugInput, setItemSlugInput] = useState('');
  const [itemTitleInput, setItemTitleInput] = useState('');
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    setCustomLists(readCustomLists(storageKey));
  }, [storageKey]);

  const persistCustomLists = (updater: (prev: ProfileCustomList[]) => ProfileCustomList[]) => {
    setCustomLists((prev) => {
      const next = updater(prev);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        toast.error('Không thể lưu danh sách trên trình duyệt này');
      }
      return next;
    });
  };

  const commentManga = useMemo(
    () => buildCommentListItems(comments, mangaTitleBySlug),
    [comments, mangaTitleBySlug],
  );

  const smartLists = useMemo(() => [
    {
      id: 'bookmarks',
      name: 'Đã lưu',
      description: 'Truyện bạn đã bookmark để đọc sau.',
      icon: Bookmark,
      tab: 'bookmarks' as ProfileTab,
      items: uniqueProfileListItems(bookmarkedManga, mangaTitleBySlug),
    },
    {
      id: 'following',
      name: 'Đang theo dõi',
      description: 'Truyện có cập nhật mà bạn muốn bám sát.',
      icon: Heart,
      tab: 'following' as ProfileTab,
      items: uniqueProfileListItems(followedManga, mangaTitleBySlug),
    },
    {
      id: 'history',
      name: 'Đang đọc',
      description: 'Tạo từ lịch sử đọc gần đây của bạn.',
      icon: Clock,
      tab: 'history' as ProfileTab,
      items: uniqueProfileListItems(historyItems, mangaTitleBySlug),
    },
    {
      id: 'rated',
      name: 'Đã đánh giá',
      description: 'Những truyện bạn đã chấm sao.',
      icon: Star,
      tab: null,
      items: uniqueProfileListItems(ratedManga, mangaTitleBySlug),
      loading: ratedLoading,
    },
    {
      id: 'commented',
      name: 'Đã bình luận',
      description: 'Truyện bạn từng tham gia thảo luận.',
      icon: MessageCircle,
      tab: 'comments' as ProfileTab,
      items: commentManga,
    },
  ], [bookmarkedManga, commentManga, followedManga, historyItems, mangaTitleBySlug, ratedLoading, ratedManga]);

  const customListCards = useMemo(() => customLists.map((list) => ({
    id: `custom:${list.id}`,
    name: list.name,
    description: 'Danh sách tự tạo, lưu trên trình duyệt của bạn.',
    icon: ListOrdered,
    tab: null,
    items: list.items,
    customId: list.id,
  })), [customLists]);

  const allLists = useMemo(() => [...smartLists, ...customListCards], [customListCards, smartLists]);
  const activeList = allLists.find((list) => list.id === activeListId) || allLists.find((list) => list.items.length > 0) || allLists[0];
  const activeCustomId = activeList?.customId || '';
  const activeItems = activeList?.items || [];

  useEffect(() => {
    if (allLists.some((list) => list.id === activeListId)) return;
    setActiveListId(allLists.find((list) => list.items.length > 0)?.id || allLists[0]?.id || 'bookmarks');
  }, [activeListId, allLists]);

  const closeListDialog = () => {
    setListDialog(null);
    setListNameInput('');
    setItemSlugInput('');
    setItemTitleInput('');
    setDialogError('');
  };

  const openCreateListDialog = () => {
    setListNameInput('');
    setDialogError('');
    setListDialog({ type: 'create' });
  };

  const createCustomList = (nameValue: string) => {
    const name = nameValue.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID?.() || `list-${Date.now()}`;
    persistCustomLists((prev) => [
      ...prev,
      { id, name, items: [], createdAt: now, updatedAt: now },
    ]);
    setActiveListId(`custom:${id}`);
    toast.success('Đã tạo danh sách');
  };

  const openRenameListDialog = (id: string) => {
    const current = customLists.find((list) => list.id === id);
    if (!current) return;
    setListNameInput(current.name);
    setDialogError('');
    setListDialog({ type: 'rename', listId: id });
  };

  const renameCustomList = (id: string, nameValue: string) => {
    const current = customLists.find((list) => list.id === id);
    if (!current) return;
    const name = nameValue.trim();
    if (!name || name === current.name) return;
    persistCustomLists((prev) => prev.map((list) => (
      list.id === id ? { ...list, name, updatedAt: new Date().toISOString() } : list
    )));
    toast.success('Đã đổi tên danh sách');
  };

  const deleteCustomList = (id: string) => {
    const current = customLists.find((list) => list.id === id);
    if (!current) return;
    if (!window.confirm(`Xóa danh sách "${current.name}"?`)) return;
    persistCustomLists((prev) => prev.filter((list) => list.id !== id));
    setActiveListId('bookmarks');
    toast.success('Đã xóa danh sách');
  };

  const openAddItemDialog = (id: string) => {
    setItemSlugInput('');
    setItemTitleInput('');
    setDialogError('');
    setListDialog({ type: 'add-item', listId: id });
  };

  const addItemToCustomList = (id: string, slugValue: string, titleValue: string) => {
    const slug = slugValue.trim();
    if (!slug) return;
    const title = titleValue.trim() || formatMangaSlugLabel(slug);
    const now = new Date().toISOString();
    persistCustomLists((prev) => prev.map((list) => {
      if (list.id !== id) return list;
      if (list.items.some((item) => item.manga_slug === slug)) return list;
      return {
        ...list,
        items: [{ manga_slug: slug, manga_title: title, created_at: now }, ...list.items],
        updatedAt: now,
      };
    }));
    toast.success('Đã thêm truyện vào danh sách');
  };

  const submitListDialog = () => {
    if (!listDialog) return;

    if (listDialog.type === 'create') {
      const name = listNameInput.trim();
      if (!name) {
        setDialogError('Nhập tên danh sách trước nha.');
        return;
      }
      createCustomList(name);
      closeListDialog();
      return;
    }

    if (listDialog.type === 'rename') {
      const name = listNameInput.trim();
      if (!name) {
        setDialogError('Tên danh sách không được để trống.');
        return;
      }
      renameCustomList(String(listDialog.listId || ''), name);
      closeListDialog();
      return;
    }

    const slug = itemSlugInput.trim();
    if (!slug) {
      setDialogError('Nhập slug hoặc ID truyện trước nha.');
      return;
    }
    addItemToCustomList(String(listDialog.listId || ''), slug, itemTitleInput);
    closeListDialog();
  };

  const removeCustomListItem = (id: string, slug: string) => {
    persistCustomLists((prev) => prev.map((list) => (
      list.id === id
        ? { ...list, items: list.items.filter((item) => item.manga_slug !== slug), updatedAt: new Date().toISOString() }
        : list
    )));
    toast.success('Đã xóa khỏi danh sách');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold flex items-center gap-2">
            <ListOrdered className="w-4 h-4 text-primary" /> Danh sách của bạn
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Tổng hợp từ dữ liệu thật và danh sách tự tạo.</p>
        </div>
        <button
          onClick={openCreateListDialog}
          className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition-all"
        >
          <Plus className="w-4 h-4" /> Tạo danh sách
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {allLists.map((list) => {
          const Icon = list.icon;
          const isActive = activeList?.id === list.id;
          return (
            <motion.button
              key={list.id}
              type="button"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => setActiveListId(list.id)}
              className={`text-left p-4 rounded-xl border transition-all group ${
                isActive
                  ? 'bg-primary/10 border-primary/40'
                  : 'bg-card border-border/50 hover:border-primary/30'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-primary shrink-0" />
                    <h4 className="font-semibold truncate group-hover:text-primary transition-colors">{list.name}</h4>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{list.description}</p>
                </div>
                <span className="px-2 py-1 rounded-lg bg-secondary text-xs font-bold shrink-0">
                  {list.loading ? '...' : list.items.length}
                </span>
              </div>
            </motion.button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border/50 bg-card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h4 className="font-bold">{activeList?.name || 'Danh sách'}</h4>
            <p className="text-xs text-muted-foreground">{activeItems.length} truyện</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeList?.tab && (
              <button
                onClick={() => onSelectTab(activeList.tab as ProfileTab)}
                className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
              >
                Mở tab gốc
              </button>
            )}
            {activeCustomId && (
              <>
                <button
                  onClick={() => openAddItemDialog(activeCustomId)}
                  className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:brightness-110 transition-all"
                >
                  Thêm truyện
                </button>
                <button
                  onClick={() => openRenameListDialog(activeCustomId)}
                  className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
                >
                  Đổi tên
                </button>
                <button
                  onClick={() => deleteCustomList(activeCustomId)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-destructive hover:bg-destructive/10 transition-colors"
                >
                  Xóa
                </button>
              </>
            )}
          </div>
        </div>

        {activeList?.loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : activeItems.length === 0 ? (
          <div className="text-center py-10">
            <BookOpen className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-semibold text-muted-foreground">Danh sách này đang trống</p>
            {activeCustomId ? (
              <button
                onClick={() => openAddItemDialog(activeCustomId)}
                className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold"
              >
                <Plus className="w-3.5 h-3.5" /> Thêm truyện đầu tiên
              </button>
            ) : (
              <Link to="/manga" className="inline-block mt-3 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold">
                Khám phá truyện
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {activeItems.slice(0, 80).map((item) => (
              <div key={item.manga_slug} className="flex items-center gap-3 p-3 rounded-xl bg-background/40 border border-border/40 hover:border-primary/30 transition-all group">
                <Link to={getMangaDetailPath(item.manga_id || item.manga_slug)} className="flex items-center gap-3 flex-1 min-w-0">
                  <OptimizedImage
                    src={item.manga_thumb || ''}
                    fallbackSrc={item.manga_thumb_fallback || undefined}
                    alt={item.manga_title}
                    className="w-11 h-16 rounded-lg object-cover border border-border/50 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-bold line-clamp-1 group-hover:text-primary transition-colors">{item.manga_title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {item.meta || (item.score ? `${item.score} sao` : timeAgoVi(item.updated_at || item.last_read_at || item.read_at || item.created_at || ''))}
                    </p>
                  </div>
                </Link>
                {activeCustomId && (
                  <button
                    onClick={() => removeCustomListItem(activeCustomId, item.manga_slug)}
                    className="p-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {listDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={closeListDialog}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: 'spring', stiffness: 360, damping: 28 }}
              className="w-full max-w-md overflow-hidden rounded-2xl bg-card border border-border shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="relative p-5 border-b border-border/60">
                <div className="absolute -top-12 -right-10 w-32 h-32 rounded-full bg-primary/20 blur-3xl" />
                <div className="relative flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.22em] text-primary">
                      Danh sách
                    </p>
                    <h3 className="text-lg font-bold mt-1">
                      {listDialog.type === 'create'
                        ? 'Tạo danh sách mới'
                        : listDialog.type === 'rename'
                          ? 'Đổi tên danh sách'
                          : 'Thêm truyện'}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      {listDialog.type === 'add-item'
                        ? 'Dán slug hoặc ID truyện, tên hiển thị có thể để trống.'
                        : 'Đặt tên ngắn, dễ nhớ để gom truyện theo gu của bạn.'}
                    </p>
                  </div>
                  <button
                    onClick={closeListDialog}
                    className="p-2 rounded-xl hover:bg-secondary transition-colors"
                    aria-label="Đóng"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="p-5 space-y-4">
                {listDialog.type === 'add-item' ? (
                  <>
                    <label className="block">
                      <span className="text-xs font-bold text-muted-foreground">Slug hoặc MangaDex ID</span>
                      <input
                        value={itemSlugInput}
                        onChange={(event) => {
                          setItemSlugInput(event.target.value);
                          setDialogError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitListDialog();
                        }}
                        placeholder="vd: one-piece hoặc 27624ef2-..."
                        className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                        autoFocus
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-bold text-muted-foreground">Tên hiển thị</span>
                      <input
                        value={itemTitleInput}
                        onChange={(event) => setItemTitleInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitListDialog();
                        }}
                        placeholder="Có thể bỏ trống, hệ thống tự dùng slug"
                        className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                  </>
                ) : (
                  <label className="block">
                    <span className="text-xs font-bold text-muted-foreground">Tên danh sách</span>
                    <input
                      value={listNameInput}
                      onChange={(event) => {
                        setListNameInput(event.target.value);
                        setDialogError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitListDialog();
                      }}
                      placeholder="vd: Romcom chữa lành, Đọc cuối tuần..."
                      className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                      autoFocus
                    />
                  </label>
                )}

                {dialogError && (
                  <p className="text-xs font-semibold text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2">
                    {dialogError}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 p-5 pt-0">
                <button
                  onClick={closeListDialog}
                  className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
                >
                  Hủy
                </button>
                <button
                  onClick={submitListDialog}
                  className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold hover:brightness-110 transition-all"
                >
                  {listDialog.type === 'create'
                    ? 'Tạo danh sách'
                    : listDialog.type === 'rename'
                      ? 'Lưu tên'
                      : 'Thêm truyện'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const DeprecatedListsTab = () => {
  const [lists] = useState([
    { id: 'l1', name: 'Yêu thích', count: 5, icon: Star },
    { id: 'l2', name: 'Dự định đọc', count: 12, icon: BookOpen },
    { id: 'l3', name: 'Đã hoàn thành', count: 8, icon: BookOpen },
    { id: 'l4', name: 'Đã bỏ', count: 3, icon: BookOpen },
  ]);

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition-all">
          <Plus className="w-4 h-4" /> Tạo danh sách
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {lists.map(list => (
          <motion.div key={list.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="p-4 rounded-xl bg-card hover:border-primary/30 transition-all cursor-pointer group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <list.icon className="w-4 h-4 text-primary" />
                <h3 className="font-semibold group-hover:text-primary transition-colors">{list.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{list.count} truyện</p>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="p-1.5 rounded-lg hover:bg-secondary transition-colors"><Edit3 className="w-3.5 h-3.5 text-muted-foreground" /></button>
                <button className="p-1.5 rounded-lg hover:bg-secondary transition-colors"><Edit3 className="w-3.5 h-3.5 text-muted-foreground" /></button>
              </div>
            </div>
            <div className="flex gap-1 mt-3">
              <div className="w-8 h-11 rounded bg-secondary/50 flex items-center justify-center text-[9px] font-bold text-muted-foreground">{list.count}</div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
};

const EmptyState = ({ icon, text, sub }: { icon: React.ReactNode; text: string; sub?: string }) => (
  <div className="text-center py-16">
    <div className="flex justify-center mb-4">{icon}</div>
    <p className="text-muted-foreground font-medium">{text}</p>
    {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    <Link to="/manga" className="inline-block mt-4 px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition-all">
      Khám phá truyện
    </Link>
  </div>
);

function timeAgoVi(dateStr: string): string {
  const t = new Date(dateStr).getTime();
  if (!dateStr || Number.isNaN(t)) return 'Vừa xong';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngày trước`;
  return `${Math.floor(days / 7)} tuần trước`;
}

export default Profile;
