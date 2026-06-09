import { create } from 'zustand';
import { User, Notification } from '@/types/manga';
import { authApi, clearBanLock, clearTokens, getAccessToken, notificationApi } from '@/lib/api';

type AvatarCropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

interface UserStore {
  user: User | null;
  isLoggedIn: boolean;
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  hasCheckedSession: boolean;

  // Auth
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, username: string) => Promise<{ success: boolean; error?: string }>;
  logout: (scope?: 'local' | 'global' | 'others') => void;
  loadUser: (options?: { force?: boolean }) => Promise<void>;

  // Notifications
  fetchNotifications: () => Promise<void>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;

  // Profile
  updateProfile: (data: Partial<Pick<User, 'username' | 'displayName' | 'bio' | 'avatar' | 'nameColor' | 'nameFont' | 'nameEffect'>>) => void;
  uploadAvatar: (file: File, cropArea?: AvatarCropArea) => Promise<{ success: boolean; avatarUrl?: string; error?: string }>;
}

function mapProfile(profile: any): User {
  return {
    id: profile.id || '',
    username: profile.username || '',
    displayName: profile.display_name || profile.displayName || '',
    email: profile.email || '',
    avatar: profile.avatar || '',
    bio: profile.bio || '',
    joinDate: profile.created_at || '',
    role: profile.role || 'reader',
    isVip: profile.is_vip || false,
    vipExpiry: profile.vip_expiry || undefined,
    nameColor: profile.name_color || undefined,
    nameFont: profile.name_font || undefined,
    nameEffect: profile.name_effect || undefined,
    isBanned: profile.is_banned || false,
    banReason: profile.ban_reason || undefined,
    followedManga: [],
    bookmarks: [],
    readingHistory: [],
    comments: [],
    stats: {
      chaptersRead: profile.chapters_read || 0,
      totalReadingTime: profile.total_reading_time || 0,
      commentsPosted: profile.comments_posted || 0,
      readingStreak: profile.reading_streak || 0,
      weeklyActivity: [0, 0, 0, 0, 0, 0, 0],
    },
  };
}

let loadUserInFlight: Promise<void> | null = null;

export const useUserStore = create<UserStore>((set, get) => ({
  user: null,
  isLoggedIn: !!getAccessToken(),
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  hasCheckedSession: false,

  login: async (email, password) => {
    try {
      const data = await authApi.login(email, password);
      if (data.profile) {
        set({ user: mapProfile(data.profile), isLoggedIn: true, hasCheckedSession: true });
        get().fetchNotifications();
        return { success: true };
      }
      return { success: false, error: data.error || 'Login failed' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  register: async (email, password, username) => {
    try {
      const data = await authApi.register(email, password, username);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  logout: (scope = 'local') => {
    authApi.logout(scope).catch(() => {});
    clearTokens();
    clearBanLock();
    set({
      user: null,
      isLoggedIn: false,
      notifications: [],
      unreadCount: 0,
      hasCheckedSession: true,
    });
  },

  loadUser: async (options = {}) => {
    const force = Boolean(options?.force);
    if (!force && loadUserInFlight) {
      return loadUserInFlight;
    }

    const run = (async () => {
    if (!getAccessToken()) {
      const refreshed = await authApi.refresh();
      if (!refreshed) {
        set({ hasCheckedSession: true });
        return;
      }
    }
    set({ isLoading: true });
    try {
      const data = await authApi.getMe();
      if (data.profile) {
        const user = mapProfile(data.profile);

        // Fetch stats (weeklyActivity) in parallel
        try {
          const { userApi } = await import('@/lib/api');
          const [statsData] = await Promise.allSettled([
            userApi.getStats(),
          ]);
          if (statsData.status === 'fulfilled' && statsData.value?.stats) {
            const s = statsData.value.stats;
            user.stats = {
              ...user.stats,
              chaptersRead: s.chapters_read ?? user.stats.chaptersRead,
              totalReadingTime: s.total_reading_time ?? user.stats.totalReadingTime,
              commentsPosted: s.comments_posted ?? user.stats.commentsPosted,
              readingStreak: s.reading_streak ?? user.stats.readingStreak,
              weeklyActivity: s.weekly_activity ?? user.stats.weeklyActivity,
            };
          }
        } catch { /* stats are optional */ }

        set({ user, isLoggedIn: true, hasCheckedSession: true });
        get().fetchNotifications();
      }
    } catch (e: any) {
      if (e?.message === 'BANNED') {
        // Keep isLoggedIn true so BannedPage shows
        set({ isLoggedIn: true, hasCheckedSession: true });
      } else {
        // Only clear session on definitive auth failures (401), NOT on network
        // errors, timeouts or server errors (5xx) — prevents false logout.
        const msg: string = e?.message || '';
        const isAuthFailure =
          msg.includes('401') ||
          msg.toLowerCase().includes('unauthorized') ||
          msg.toLowerCase().includes('invalid token') ||
          msg.toLowerCase().includes('token expired');

        if (isAuthFailure) {
          clearTokens();
          set({ user: null, isLoggedIn: false });
        }
        // else: network/5xx error — keep the user logged in, just skip setting user
      }
    } finally {
      set({ isLoading: false, hasCheckedSession: true });
    }
    })();

    loadUserInFlight = run;
    try {
      return await run;
    } finally {
      if (loadUserInFlight === run) {
        loadUserInFlight = null;
      }
    }
  },

  fetchNotifications: async () => {
    try {
      const data = await notificationApi.getAll();
      const notifs: Notification[] = (data.notifications || []).map((n: any) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        mangaId: n.manga_slug,
        chapterId: n.chapter_id,
        read: n.is_read,
        createdAt: n.created_at,
      }));
      set({ notifications: notifs, unreadCount: data.unread_count || 0 });
    } catch {
      // Not logged in or error
    }
  },

  markNotificationRead: async (id) => {
    set(state => ({
      notifications: state.notifications.map(n => n.id === id ? { ...n, read: true } : n),
      unreadCount: Math.max(0, state.unreadCount - 1),
    }));
    notificationApi.markRead(id).catch(() => {});
  },

  markAllNotificationsRead: () => {
    set(state => ({
      notifications: state.notifications.map(n => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    notificationApi.markAllRead().catch(() => {});
  },

  updateProfile: async (data) => {
    const { user } = get();
    if (!user) return;
    const previousUser = user;
    set({ user: { ...user, ...data } });
    // Persist to backend
    try {
      const { userApi } = await import('@/lib/api');
      const apiData: Record<string, any> = {};
      if (data.displayName !== undefined) apiData.display_name = data.displayName;
      if (data.bio !== undefined) apiData.bio = data.bio;
      if (data.avatar !== undefined) apiData.avatar = data.avatar;
      if (data.nameColor !== undefined) apiData.name_color = data.nameColor;
      if (data.nameFont !== undefined) apiData.name_font = data.nameFont;
      if (data.nameEffect !== undefined) apiData.name_effect = data.nameEffect;
      if (Object.keys(apiData).length > 0) {
        await userApi.updateProfile(apiData);
      }
    } catch {
      set({ user: previousUser });
    }
  },

  uploadAvatar: async (file, cropArea) => {
    const { user } = get();
    if (!user) return { success: false, error: 'Chưa đăng nhập' };

    try {
      const { userApi } = await import('@/lib/api');
      const res = await userApi.uploadAvatar(file, cropArea);
      const avatarUrl = res?.avatar_url || res?.profile?.avatar;
      if (!avatarUrl) return { success: false, error: 'Không nhận được URL avatar' };

      set((state) => ({
        user: state.user ? { ...state.user, avatar: avatarUrl } : state.user,
      }));
      return { success: true, avatarUrl };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Upload avatar thất bại' };
    }
  },
}));
