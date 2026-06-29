import { create } from 'zustand';
import { User, Notification } from '@/types/manga';
import {
  authApi,
  clearBanLock,
  clearTokens,
  getAccessToken,
  hasSessionHint,
  notificationApi,
  shouldStopRestoringSession,
} from '@/lib/api';

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
  login: (email: string, password: string, recaptchaToken?: string) => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, username: string, recaptchaToken?: string) => Promise<{ success: boolean; error?: string }>;
  logout: (scope?: 'local' | 'global' | 'others', options?: { server?: boolean }) => void;
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
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearRestoreRetry() {
  if (!restoreRetryTimer) return;
  clearTimeout(restoreRetryTimer);
  restoreRetryTimer = null;
}

function scheduleRestoreRetry(loadUser: () => Promise<void>, delayMs = 15_000) {
  if (restoreRetryTimer) return;
  restoreRetryTimer = setTimeout(() => {
    restoreRetryTimer = null;
    loadUser().catch(() => {});
  }, delayMs);
}

function shouldKeepRestoringSession() {
  return hasSessionHint() && !shouldStopRestoringSession();
}

export const useUserStore = create<UserStore>((set, get) => ({
  user: null,
  isLoggedIn: !!getAccessToken() || hasSessionHint(),
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  hasCheckedSession: false,

  login: async (email, password, recaptchaToken) => {
    try {
      const data = await authApi.login(email, password, recaptchaToken);
      if (data.profile) {
        clearRestoreRetry();
        set({ user: mapProfile(data.profile), isLoggedIn: true, hasCheckedSession: true });
        get().fetchNotifications();
        return { success: true };
      }
      return { success: false, error: data.error || 'Login failed' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  register: async (email, password, username, recaptchaToken) => {
    try {
      const data = await authApi.register(email, password, username, undefined, recaptchaToken);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  logout: (scope = 'local', options = {}) => {
    clearRestoreRetry();
    if (options.server !== false) {
      authApi.logout(scope).catch(() => {});
    }
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
    set({ isLoading: true });
    try {
      if (!getAccessToken()) {
        const refreshed = await authApi.refresh();
        if (!refreshed) {
          if (!shouldKeepRestoringSession()) {
            clearRestoreRetry();
            clearTokens();
            set({ user: null, isLoggedIn: false });
            return;
          }

          set({ user: null, isLoggedIn: true });
          scheduleRestoreRetry(() => get().loadUser({ force: true }));
          return;
        }
      }

      const data = await authApi.getMe();
      if (data.profile) {
        clearRestoreRetry();
        const user = mapProfile(data.profile);
        set({ user, isLoggedIn: true, hasCheckedSession: true, isLoading: false });
        void get().fetchNotifications();

        // Stats are optional and must never block route rendering.
        void import('@/lib/api')
          .then(({ userApi }) => userApi.getStats())
          .then((statsData) => {
            const s = statsData?.stats;
            if (!s) return;
            set((state) => {
              if (!state.user || state.user.id !== user.id) return state;
              return {
                user: {
                  ...state.user,
                  stats: {
                    ...state.user.stats,
                    chaptersRead: s.chapters_read ?? state.user.stats.chaptersRead,
                    totalReadingTime: s.total_reading_time ?? state.user.stats.totalReadingTime,
                    commentsPosted: s.comments_posted ?? state.user.stats.commentsPosted,
                    readingStreak: s.reading_streak ?? state.user.stats.readingStreak,
                    weeklyActivity: s.weekly_activity ?? state.user.stats.weeklyActivity,
                  },
                },
              };
            });
          })
          .catch(() => {});
      }
    } catch (e: any) {
      if (e?.message === 'BANNED') {
        // Keep isLoggedIn true so BannedPage shows
        set({ isLoggedIn: true, hasCheckedSession: true });
      } else {
        // Only clear session on definitive auth failures (401), NOT on network
        // errors, timeouts or server errors (5xx) - prevents false logout.
        const msg: string = e?.message || '';
        const isAuthFailure =
          msg.includes('401') ||
          msg.toLowerCase().includes('unauthorized') ||
          msg.toLowerCase().includes('invalid token') ||
          msg.toLowerCase().includes('token expired');

        if (isAuthFailure) {
          if (!shouldKeepRestoringSession()) {
            clearRestoreRetry();
            clearTokens();
            set({ user: null, isLoggedIn: false });
          } else {
            set({ user: null, isLoggedIn: true });
            scheduleRestoreRetry(() => get().loadUser({ force: true }));
          }
        } else if (hasSessionHint() || getAccessToken()) {
          set({ isLoggedIn: true });
          scheduleRestoreRetry(() => get().loadUser({ force: true }));
        }
        // else: network/5xx error - keep the user logged in, just skip setting user
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
