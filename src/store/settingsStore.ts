import { create } from 'zustand';
import { UserSettings, ReaderSettings } from '@/types/manga';
import { useReaderStore } from '@/store/readerStore';

const defaultReaderSettings: ReaderSettings = {
  readingMode: 'vertical',
  pageDirection: 'ltr',
  imageFit: 'width',
  imageLoading: 'preload',
  autoHideToolbar: true,
  showPageNumber: true,
  showProgressBar: true,
  autoBookmark: true,
  autoFollow: false,
};

const defaultSettings: UserSettings = {
  account: {
    username: '',
    displayName: '',
    bio: '',
    email: '',
  },
  reader: defaultReaderSettings,
  notifications: {
    newChapter: true,
    commentReply: true,
    systemAnnouncement: true,
    emailNotifications: false,
  },
  privacy: {
    profileVisibility: 'public',
    showReadingHistory: true,
    showFollowedManga: true,
    showComments: true,
    showMatureContent: false,
  },
};

let syncTimer: ReturnType<typeof setTimeout> | null = null;

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function applyReaderSettingsToReaderStore(reader: ReaderSettings) {
  const readerStore = useReaderStore.getState();
  readerStore.setMode(reader.readingMode);
  readerStore.setPageDirection(reader.pageDirection);
  readerStore.setImageFit(reader.imageFit);
  readerStore.setShowToolbar(!reader.autoHideToolbar);
  readerStore.setShowPageNumber(reader.showPageNumber);
  readerStore.setShowProgressBar(reader.showProgressBar);
}

function debouncedSync(settings: UserSettings) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const { userApi } = await import('@/lib/api');
      await userApi.updateSettings({
        reading_mode: settings.reader.readingMode,
        page_direction: settings.reader.pageDirection,
        image_fit: settings.reader.imageFit,
        image_loading: settings.reader.imageLoading,
        auto_hide_toolbar: settings.reader.autoHideToolbar,
        show_page_number: settings.reader.showPageNumber,
        show_progress_bar: settings.reader.showProgressBar,
        auto_bookmark: settings.reader.autoBookmark,
        auto_follow: settings.reader.autoFollow,
        notify_new_chapter: settings.notifications.newChapter,
        notify_comment_reply: settings.notifications.commentReply,
        notify_system: settings.notifications.systemAnnouncement,
        notify_email: settings.notifications.emailNotifications,
        profile_visibility: settings.privacy.profileVisibility,
        show_reading_history: settings.privacy.showReadingHistory,
        show_followed_manga: settings.privacy.showFollowedManga,
        show_comments: settings.privacy.showComments,
        show_mature_content: settings.privacy.showMatureContent,
      });
    } catch { /* local update still applies */ }
  }, 1500);
}

interface SettingsStore {
  settings: UserSettings;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  updateAccount: (data: Partial<UserSettings['account']>) => void;
  updateReader: (data: Partial<ReaderSettings>) => void;
  updateNotifications: (data: Partial<UserSettings['notifications']>) => void;
  updatePrivacy: (data: Partial<UserSettings['privacy']>) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  loaded: false,

  loadSettings: async () => {
    if (get().loaded) return;
    try {
      const { userApi } = await import('@/lib/api');
      const data = await userApi.getSettings();
      const s = data.settings || data;
      if (s) {
        const current = get().settings;
        const nextReader: ReaderSettings = {
          readingMode: s.reading_mode || current.reader.readingMode,
          pageDirection: s.page_direction || current.reader.pageDirection,
          imageFit: s.image_fit || current.reader.imageFit,
          imageLoading: s.image_loading || current.reader.imageLoading,
          autoHideToolbar: s.auto_hide_toolbar ?? current.reader.autoHideToolbar,
          showPageNumber: s.show_page_number ?? current.reader.showPageNumber,
          showProgressBar: s.show_progress_bar ?? current.reader.showProgressBar,
          autoBookmark: s.auto_bookmark ?? current.reader.autoBookmark,
          autoFollow: s.auto_follow ?? current.reader.autoFollow,
        };

        const nextSettings: UserSettings = {
          ...current,
          reader: nextReader,
          notifications: {
            newChapter: toBoolean(s.notify_new_chapter, current.notifications.newChapter),
            commentReply: toBoolean(s.notify_comment_reply, current.notifications.commentReply),
            systemAnnouncement: toBoolean(s.notify_system, current.notifications.systemAnnouncement),
            emailNotifications: toBoolean(s.notify_email, current.notifications.emailNotifications),
          },
          privacy: {
            profileVisibility: s.profile_visibility === 'private' ? 'private' : 'public',
            showReadingHistory: toBoolean(s.show_reading_history, current.privacy.showReadingHistory),
            showFollowedManga: toBoolean(s.show_followed_manga, current.privacy.showFollowedManga),
            showComments: toBoolean(s.show_comments, current.privacy.showComments),
            showMatureContent: toBoolean(s.show_mature_content, current.privacy.showMatureContent),
          },
        };

        set({ loaded: true, settings: nextSettings });
        applyReaderSettingsToReaderStore(nextReader);
      }
    } catch { set({ loaded: true }); }
  },

  updateAccount: (data) => set(s => ({ settings: { ...s.settings, account: { ...s.settings.account, ...data } } })),

  updateReader: (data) => {
    set(s => ({ settings: { ...s.settings, reader: { ...s.settings.reader, ...data } } }));
    const updated = get().settings;
    applyReaderSettingsToReaderStore(updated.reader);
    debouncedSync(updated);
  },

  updateNotifications: (data) => {
    set(s => {
      const updated = { ...s.settings, notifications: { ...s.settings.notifications, ...data } };
      debouncedSync(updated);
      return { settings: updated };
    });
  },

  updatePrivacy: (data) => {
    set(s => {
      const updated = { ...s.settings, privacy: { ...s.settings.privacy, ...data } };
      debouncedSync(updated);
      return { settings: updated };
    });
  },

  resetSettings: () => set({ settings: defaultSettings }),
}));
