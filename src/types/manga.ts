export interface Manga {
  id: string;
  /** Source-native human slug. OTruyen detail APIs still resolve by slug. */
  slug?: string;
  source?: 'truyenqq' | 'mangadex' | 'uploaded';
  title: string;
  altTitle?: string;
  author: string;
  artist: string;
  description: string;
  cover: string;
  /** Proxy URL used as fallback when direct cover (e.g. MangaDex CDN) fails */
  coverProxy?: string;
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  type: 'manga' | 'manhwa' | 'webtoon';
  genres: string[];
  tags: string[];
  rating: number;
  ratingCount: number;
  myRating?: number | null;
  follows: number;
  views: number;
  localViewCount?: number;
  local_view_count?: number;
  view_count?: number;
  popularityScore?: number;
  mangadexPopularityScore?: number;
  year: number;
  chapters: Chapter[];
  chapterAvailability?: 'empty' | 'unavailable';
  lastUpdated: string;
  availableTranslatedLanguages?: string[];
  contentRating?: string;
  isMature?: boolean;
  is_mature?: boolean;
  isFeatured?: boolean;
  featuredAt?: string;
  adminNotes?: string;
  externalUrl?: string;
}

export type ChapterTranslationSource = 'mangadex' | 'local' | 'truyenqq';

export interface Chapter {
  id: string;
  mangaId: string;
  number: number;
  title: string;
  pages: string[];
  uploadDate: string;
  scanlationGroup: string;
  translationSource?: ChapterTranslationSource;
  translationSourceLabel?: string;
  isUserUpload?: boolean;
  scanlationGroups?: Array<{
    id: string;
    name: string;
    website?: string;
    discord?: string;
  }>;
  translatedLanguage?: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  avatar: string;
  bio: string;
  joinDate: string;
  role: 'reader' | 'uploader' | 'moderator' | 'admin';
  isVip?: boolean;
  vipExpiry?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  isBanned?: boolean;
  banReason?: string;
  
  followedManga: string[];
  bookmarks: string[];
  readingHistory: ReadingHistoryItem[];
  comments: UserComment[];
  stats: UserStats;
}

export interface UserStats {
  chaptersRead: number;
  totalReadingTime: number; // minutes
  commentsPosted: number;
  readingStreak: number;
  weeklyActivity: number[]; // 7 days
}

export interface UserComment {
  id: string;
  mangaId: string;
  chapterId: string;
  content: string;
  imageUrl?: string;
  createdAt: string;
  likes: number;
  reactions?: Record<string, number>;
}

export interface ReadingHistoryItem {
  mangaId: string;
  chapterId: string;
  page: number;
  readAt: string;
  progress: number; // 0-100
}

export interface Comment {
  id: string;
  userId: string;
  chapterId?: string;
  chapterLabel?: string;
  username: string;
  profileUsername?: string;
  avatar: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  content: string;
  imageUrl?: string;
  createdAt: string;
  likes: number;
  reactions?: Record<string, number>;
  myReaction?: string | null;
  replies: Comment[];
  role?: 'admin' | 'moderator' | 'uploader' | 'reader';
  isVip?: boolean;
  isLiked?: boolean;
}

export interface Notification {
  id: string;
  type: 'new_chapter' | 'reply' | 'system' | 'follow_update';
  title: string;
  message: string;
  mangaId?: string;
  chapterId?: string;
  read: boolean;
  createdAt: string;
}

export interface ReaderSettings {
  readingMode: ReadingMode;
  pageDirection: 'ltr' | 'rtl';
  imageFit: 'width' | 'height' | 'original';
  imageLoading: 'standard' | 'preload' | 'aggressive';
  autoHideToolbar: boolean;
  showPageNumber: boolean;
  showProgressBar: boolean;
  autoBookmark: boolean;
  autoFollow: boolean;
}

export interface UserSettings {
  account: {
    username: string;
    displayName: string;
    bio: string;
    email: string;
  };
  reader: ReaderSettings;
  notifications: {
    newChapter: boolean;
    commentReply: boolean;
    systemAnnouncement: boolean;
    emailNotifications: boolean;
  };
  privacy: {
    profileVisibility: 'public' | 'private';
    showReadingHistory: boolean;
    showFollowedManga: boolean;
    showComments: boolean;
    showMatureContent: boolean;
    silentViewTracking?: boolean;
  };
}

export type ReadingMode = 'vertical' | 'horizontal' | 'webtoon';
export type SortOption = 'popular' | 'latest' | 'rating' | 'alphabetical';
export type MangaStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
