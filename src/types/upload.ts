export interface ScanlationGroup {
  id: string;
  name: string;
  logo: string;
  description: string;
  members: GroupMember[];
  projects: string[]; // manga IDs
  totalUploads: number;
  createdAt: string;
}

export interface GroupMember {
  userId: string;
  username: string;
  avatar: string;
  role: 'owner' | 'admin' | 'uploader' | 'member';
  joinedAt: string;
}

export interface ChapterUpload {
  id: string;
  mangaId: string;
  mangaTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  language: string;
  groupId: string;
  groupName: string;
  uploaderId: string;
  uploaderName: string;
  status: 'draft' | 'pending' | 'published' | 'rejected';
  pages: UploadPage[];
  createdAt: string;
  publishedAt?: string;
  rejectionReason?: string;
}

export interface UploadPage {
  id: string;
  url: string;
  fileName: string;
  order: number;
  size: number; // bytes
}

export interface ModerationAction {
  id: string;
  chapterUploadId: string;
  action: 'approve' | 'reject' | 'edit';
  moderatorId: string;
  reason?: string;
  createdAt: string;
}

export const LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];
