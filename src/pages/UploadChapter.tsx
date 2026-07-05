import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { groupApi, mangaApi, uploadApi } from '@/lib/api';
import { useCategories } from '@/hooks/useApi';
import { adaptMangaDetail, adaptMangaItem } from '@/lib/adapters';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { toast } from 'sonner';
import { LANGUAGES } from '@/types/upload';
import type { Manga } from '@/types/manga';
import { useTranslationStudioStore } from '@/store/translationStudioStore';
import {
  Upload, ArrowLeft, ImagePlus, FileArchive, X, Eye,
  GripVertical, AlertTriangle, BookPlus, FileUp, BookOpen, Search,
  Loader2, ChevronLeft, ChevronRight, Plus, Download, Pencil
} from 'lucide-react';

interface UploadedImage {
  id: string;
  file: File | null;
  preview: string;
  fallbackPreview?: string;
  name: string;
  size: number;
}

interface MangaDexChapterOption {
  id: string;
  chapterNumber: string;
  chapterKey: string;
  chapterTitle: string;
  language: string;
  publishAt: string;
  label: string;
}

type UploadMode = 'chapter' | 'manga';

// MANGA_TYPES is a UI constant since types are not API-provided
const MANGA_TYPES = [
  { value: 'manga', label: 'Manga' },
  { value: 'manhwa', label: 'Manhwa' },
  { value: 'webtoon', label: 'Webtoon' },
];

const MAX_MANGA_SUGGESTIONS = 8;
const MAX_MANGA_SEARCH_CACHE = 60;
const MANGADEX_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_PLACEHOLDERS = new Set([
  'chua co tieu de',
  'chưa có tiêu đề',
  'dang cap nhat',
  'dang cap nhat tieu de',
  'đang cập nhật',
  'đang cập nhật tiêu đề',
  'untitled',
]);

const normalizeSearchKey = (value: string): string =>
  String(value || '').trim().toLowerCase();

const compactAuthorText = (author: string): string => {
  const parts = String(author || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')}...`;
};

const languageLabelFromCode = (code: string): string => {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) return '';
  const matched = LANGUAGES.find((item) => String(item.code || '').trim().toLowerCase() === normalized);
  return matched?.label || normalized.toUpperCase();
};

const normalizeLooseText = (value: string): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const isInvalidDisplayTitle = (value: string): boolean => {
  const normalized = normalizeLooseText(value);
  if (!normalized) return true;
  if (TITLE_PLACEHOLDERS.has(normalized)) return true;
  return false;
};

const humanizeSlugTitle = (slug: string): string => {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return '';
  const raw = normalized.startsWith('mdx-') ? normalized.slice(4) : normalized;
  if (MANGADEX_ID_RE.test(raw)) return '';
  if (!normalized.includes('-')) return '';
  const words = normalized
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.join(' ');
};

const toMangaDexId = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  const embeddedMatch = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (embeddedMatch && MANGADEX_ID_RE.test(embeddedMatch[0])) {
    return embeddedMatch[0].toLowerCase();
  }
  if (normalized.startsWith('mdx-')) {
    const raw = normalized.slice(4);
    return MANGADEX_ID_RE.test(raw) ? raw : '';
  }
  return MANGADEX_ID_RE.test(normalized) ? normalized : '';
};

const chapterSortValue = (chapterNumber: string): number => {
  const parsed = Number(String(chapterNumber || '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : -1;
};

const normalizeOtruyenSlugInput = (value: string): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (toMangaDexId(raw)) return '';

  let candidate = raw;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      const parts = parsed.pathname.split('/').filter(Boolean);
      candidate = String(parts[parts.length - 1] || '').toLowerCase();
    } catch {
      // Keep original candidate.
    }
  }

  if (candidate.includes('/')) {
    const parts = candidate.split('/').filter(Boolean);
    candidate = String(parts[parts.length - 1] || '').toLowerCase();
  }

  return candidate
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const isLikelyOtruyenSlugInput = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (toMangaDexId(raw)) return false;
  const uuidLike = /^[0-9a-f-]{24,}$/i.test(raw) && (raw.match(/-/g) || []).length >= 3;
  if (uuidLike) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  if (raw.includes('/')) return true;
  if (raw.includes(' ')) return false;
  return /^[a-z0-9-]{4,}$/i.test(raw) && raw.includes('-');
};

const buildMangaDexSuggestionFromDetail = (mangaId: string, payload: any): Manga | null => {
  const item = (payload?.manga || {}) as any;
  const title = String(item?.title || '').trim();
  if (!title) return null;

  const chapterRows = Array.isArray(item?.chapters) ? item.chapters : [];
  const topChapter = chapterRows[0];
  const chapterNumberRaw = Number(String(topChapter?.chapter || '').replace(',', '.').trim());
  const chapterNumber = Number.isFinite(chapterNumberRaw) ? chapterNumberRaw : 0;

  return {
    id: mangaId,
    title,
    altTitle: '',
    author: String(item?.authors_text || 'MangaDex').trim() || 'MangaDex',
    artist: String(item?.authors_text || 'MangaDex').trim() || 'MangaDex',
    description: String(item?.description || '').trim(),
    cover: String(item?.cover_url || '').trim() || '/no-cover.svg',
    coverProxy: '/no-cover.svg',
    status: String(item?.status || '').trim().toLowerCase() === 'completed' ? 'completed' : 'ongoing',
    type: 'manga',
    genres: Array.isArray(item?.genres) ? item.genres.map((genre: unknown) => String(genre || '').trim()).filter(Boolean) : [],
    tags: [],
    rating: 0,
    ratingCount: 0,
    myRating: null,
    follows: 0,
    views: Number(item?.view_count || item?.views || 0) || 0,
    year: Number(item?.year) || new Date().getFullYear(),
    chapters: topChapter
      ? [{
          id: String(topChapter?.id || `mdx-${mangaId}`),
          mangaId,
          number: chapterNumber,
          title: String(topChapter?.title || topChapter?.chapter_with_groups || '').trim(),
          pages: [],
          uploadDate: String(topChapter?.publish_at || topChapter?.created_at || item?.updated_at || '').trim(),
          scanlationGroup: '',
        }]
      : [],
    lastUpdated: String(item?.updated_at || '').trim(),
    contentRating: String(item?.content_rating || '').trim().toLowerCase(),
  };
};

const normalizeChapterKey = (value: unknown): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const parsed = Number(raw.replace(',', '.'));
  if (!Number.isFinite(parsed)) return raw;
  if (Number.isInteger(parsed)) return String(parsed);

  return String(parsed)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
};

const pickRawSearchTitle = (raw: any): string => {
  const candidates: string[] = [];

  const directTitle = raw?.title;
  if (typeof directTitle === 'string') candidates.push(directTitle);
  if (directTitle && typeof directTitle === 'object') {
    candidates.push(
      String(directTitle.vi || ''),
      String(directTitle.en || ''),
      String(directTitle.ja || ''),
      String(directTitle['ja-ro'] || ''),
      String(directTitle.jp || ''),
    );
  }

  if (Array.isArray(raw?.origin_name)) {
    for (const value of raw.origin_name) {
      candidates.push(String(value || ''));
    }
  }

  candidates.push(
    String(raw?.name || ''),
    String(raw?.manga_title || ''),
  );

  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    if (isInvalidDisplayTitle(text)) continue;
    return text;
  }

  return '';
};

const resolveMangaDisplayTitle = (item: Manga, raw?: any): string => {
  const title = String(item?.title || '').trim();
  if (title && !isInvalidDisplayTitle(title)) return title;

  const altTitle = String(item?.altTitle || '').trim();
  if (altTitle && !isInvalidDisplayTitle(altTitle)) return altTitle;

  const rawTitle = pickRawSearchTitle(raw || {});
  if (rawTitle) return rawTitle;

  const fallback = humanizeSlugTitle(String(item?.id || ''));
  return fallback;
};

const dedupeMangaOptions = (items: Manga[], rawRows?: any[]): Manga[] => {
  const seen = new Set<string>();
  const output: Manga[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = String(item?.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const resolvedTitle = resolveMangaDisplayTitle(item, rawRows?.[index]);
    if (!resolvedTitle) continue;

    seen.add(key);
    output.push({
      ...item,
      title: resolvedTitle,
    });
  }

  return output;
};

const mapSearchPayloadToMangaOptions = (payload: any): Manga[] => {
  const rows = ((payload?.data?.items || []) as any[]);
  const adapted = rows.map((row) => adaptMangaItem(row));
  return dedupeMangaOptions(adapted, rows);
};

const rankMangaSuggestions = (items: Manga[], query: string): Manga[] => {
  const normalizedQuery = normalizeSearchKey(query);
  if (!items.length) return [];

  const scoreItem = (item: Manga): number => {
    const title = normalizeSearchKey(item?.title || '');
    const altTitle = normalizeSearchKey(item?.altTitle || '');
    const author = normalizeSearchKey(item?.author || '');
    const id = normalizeSearchKey(item?.id || '');
    const isMangaDex = Boolean(toMangaDexId(item?.id || ''));

    let relevanceScore = 3;
    if (!normalizedQuery) {
      relevanceScore = 2;
    } else if (id === normalizedQuery) {
      relevanceScore = 0;
    } else if (title.startsWith(normalizedQuery) || altTitle.startsWith(normalizedQuery)) {
      relevanceScore = 0;
    } else if (title.includes(normalizedQuery) || altTitle.includes(normalizedQuery)) {
      relevanceScore = 1;
    } else if (author.includes(normalizedQuery) || id.includes(normalizedQuery)) {
      relevanceScore = 2;
    }

    const sourceBias = isMangaDex ? 0 : 3;
    return relevanceScore + sourceBias;
  };

  return [...items].sort((a, b) => {
    const scoreDiff = scoreItem(a) - scoreItem(b);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a?.title || '').localeCompare(String(b?.title || ''), 'vi');
  });
};

const dedupeGroups = (items: any[]): any[] => {
  const seen = new Set<string>();
  const output: any[] = [];

  for (const group of Array.isArray(items) ? items : []) {
    const id = String(group?.id || '').trim();
    const name = String(group?.name || '').trim();
    const key = id || (name ? `name:${name.toLowerCase()}` : '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(group);
  }

  return output;
};

const normalizeGroupName = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const UploadChapter = () => {
  const { data: categories = [] } = useCategories();
  const navigate = useNavigate();
  const location = useLocation();
  const startStudioSession = useTranslationStudioStore((state) => state.startSession);
  const studioSessionId = useTranslationStudioStore((state) => state.sessionId);
  const studioImages = useTranslationStudioStore((state) => state.images);
  const [mode, setMode] = useState<UploadMode>('chapter');

  // Chapter fields
  const [mangaId, setMangaId] = useState('');
  const [selectedMangaTitle, setSelectedMangaTitle] = useState('');
  const [mangaSearchQuery, setMangaSearchQuery] = useState('');
  const [mangaSuggestions, setMangaSuggestions] = useState<Manga[]>([]);
  const [isSearchingManga, setIsSearchingManga] = useState(false);
  const [chapterNumber, setChapterNumber] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [mangaDexChapterOptions, setMangaDexChapterOptions] = useState<MangaDexChapterOption[]>([]);
  const [selectedMangaDexChapterId, setSelectedMangaDexChapterId] = useState('');
  const [isLoadingMangaDexChapters, setIsLoadingMangaDexChapters] = useState(false);
  const [mangaDexChapterHint, setMangaDexChapterHint] = useState('');
  const [mangaDexLanguageFilter, setMangaDexLanguageFilter] = useState('all');
  const [language, setLanguage] = useState('vi');
  const [isPreparingSelectedManga, setIsPreparingSelectedManga] = useState(false);
  const [groups, setGroups] = useState<any[]>([]);
  const [groupInput, setGroupInput] = useState('');
  const [showCreateGroupForm, setShowCreateGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const mangaSearchRequestSeqRef = useRef(0);
  const mangaSearchCacheRef = useRef<Map<string, Manga[]>>(new Map());

  useEffect(() => {
    groupApi.getMyGroups().then(d => {
      const g = dedupeGroups(d.groups || []);
      setGroups(g);
    }).catch(() => {});
  }, []);

  const groupSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const output: Array<{ id: string; name: string; value: string }> = [];

    for (const group of groups) {
      const id = String(group?.id || '').trim();
      const name = String(group?.name || '').trim();
      const value = name || id;
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      output.push({ id, name, value });
    }

    return output;
  }, [groups]);

  const resolvedGroupId = useMemo(() => {
    const raw = String(groupInput || '').trim();
    if (!raw) return '';

    const normalized = raw.toLowerCase();
    const idMatch = groups.find((group: any) =>
      String(group?.id || '').trim().toLowerCase() === normalized,
    );
    if (idMatch?.id) return String(idMatch.id);

    const nameMatch = groups.find((group: any) =>
      String(group?.name || '').trim().toLowerCase() === normalized,
    );
    if (nameMatch?.id) return String(nameMatch.id);

    return raw;
  }, [groupInput, groups]);

  const handleCreateGroupInline = async () => {
    const name = String(newGroupName || '').trim();
    const description = String(newGroupDescription || '').trim();

    if (name.length < 3) {
      toast.error('Tên nhóm phải có ít nhất 3 ký tự');
      return;
    }

    const normalizedName = normalizeGroupName(name);
    const hasSameName = groups.some((group: any) =>
      normalizeGroupName(group?.name) === normalizedName,
    );
    if (hasSameName) {
      toast.error('Tên nhóm dịch đã tồn tại, vui lòng chọn tên khác');
      return;
    }

    setIsCreatingGroup(true);
    try {
      const payload = await groupApi.create({
        name,
        description: description || undefined,
      });

      const createdGroup = payload?.group;
      const refreshed = await groupApi.getMyGroups().catch(() => null);
      if (Array.isArray(refreshed?.groups)) {
        setGroups(dedupeGroups(refreshed.groups));
      } else if (createdGroup?.id) {
        setGroups((prev) => {
          return dedupeGroups([createdGroup, ...prev]);
        });
      }

      const pickedValue = String(createdGroup?.name || name || '').trim();
      if (pickedValue) {
        setGroupInput(pickedValue);
      }

      setNewGroupName('');
      setNewGroupDescription('');
      setShowCreateGroupForm(false);
      toast.success('Đã tạo nhóm dịch mới');
    } catch (error: any) {
      toast.error(error?.message || 'Không thể tạo nhóm dịch mới');
    } finally {
      setIsCreatingGroup(false);
    }
  };

  useEffect(() => {
    const keyword = mangaSearchQuery.trim();
    const normalizedKeyword = normalizeSearchKey(keyword);
    if (mode !== 'chapter' || keyword.length < 2) {
      mangaSearchRequestSeqRef.current += 1;
      setMangaSuggestions([]);
      setIsSearchingManga(false);
      return;
    }

    if (mangaId && selectedMangaTitle && keyword.toLowerCase() === selectedMangaTitle.trim().toLowerCase()) {
      setMangaSuggestions([]);
      setIsSearchingManga(false);
      return;
    }

    const requestSeq = mangaSearchRequestSeqRef.current + 1;
    mangaSearchRequestSeqRef.current = requestSeq;

    const cachedExact = mangaSearchCacheRef.current.get(normalizedKeyword);
    if (cachedExact?.length) {
      setMangaSuggestions(cachedExact.slice(0, MAX_MANGA_SUGGESTIONS));
    } else {
      let bestPrefixItems: Manga[] = [];
      let bestPrefixLen = 0;
      for (const [cacheKey, cacheItems] of mangaSearchCacheRef.current.entries()) {
        if (cacheKey.length < 2) continue;
        if (!normalizedKeyword.startsWith(cacheKey)) continue;
        if (cacheKey.length <= bestPrefixLen) continue;
        bestPrefixLen = cacheKey.length;
        bestPrefixItems = cacheItems;
      }

      if (bestPrefixItems.length > 0) {
        const quickFromPrefix = bestPrefixItems.filter((item) => {
          const title = String(item?.title || '').toLowerCase();
          const author = String(item?.author || '').toLowerCase();
          const id = String(item?.id || '').toLowerCase();
          return (
            title.includes(normalizedKeyword) ||
            author.includes(normalizedKeyword) ||
            id.includes(normalizedKeyword)
          );
        });

        if (quickFromPrefix.length > 0) {
          setMangaSuggestions(quickFromPrefix.slice(0, MAX_MANGA_SUGGESTIONS));
        }
      }
    }

    setIsSearchingManga(true);
    const isDirectMangaDexIdLookup = Boolean(toMangaDexId(keyword));

    const timer = window.setTimeout(async () => {
      const updateCache = (key: string, items: Manga[]) => {
        const map = mangaSearchCacheRef.current;
        map.set(key, items.slice(0, 12));
        if (map.size > MAX_MANGA_SEARCH_CACHE) {
          const oldestKey = map.keys().next().value;
          if (oldestKey) map.delete(oldestKey);
        }
      };

      const directMangaDexId = toMangaDexId(keyword);
      const normalizedOtruyenSlug = normalizeOtruyenSlugInput(keyword);
      const shouldTryOtruyenSlug = !directMangaDexId && isLikelyOtruyenSlugInput(keyword) && normalizedOtruyenSlug.length >= 4;
      const directItems: Manga[] = [];

      const commitDirectItems = () => {
        if (requestSeq !== mangaSearchRequestSeqRef.current) return;
        if (!directItems.length) return;
        const directDeduped = rankMangaSuggestions(dedupeMangaOptions(directItems), normalizedKeyword);
        if (directDeduped.length === 0) return;
        setMangaSuggestions(directDeduped.slice(0, MAX_MANGA_SUGGESTIONS));
        updateCache(normalizedKeyword, directDeduped);
      };

      const directLookupTask = (async () => {
        if (!directMangaDexId && !shouldTryOtruyenSlug) return;
        await Promise.allSettled([
          ...(directMangaDexId
            ? [
                (async () => {
                  let payload: any = null;
                  try {
                    payload = await mangaApi.getMangaDexLookup(
                      directMangaDexId,
                      { timeoutMs: 3000, skipAuth: true },
                    );
                  } catch {
                    // Backward-compatible fallback when lookup route is not available yet.
                    payload = await mangaApi.getMangaDexDetail(
                      directMangaDexId,
                      1,
                      'all',
                      { timeoutMs: 5000, skipAuth: true },
                    );
                  }
                  const mapped = buildMangaDexSuggestionFromDetail(directMangaDexId, payload);
                  if (mapped) {
                    directItems.push(mapped);
                    commitDirectItems();
                  }
                })(),
              ]
            : []),
          ...(shouldTryOtruyenSlug
            ? [
                (async () => {
                  const payload = await mangaApi.getDetail(normalizedOtruyenSlug);
                  const mapped = adaptMangaDetail(payload);
                  if (mapped?.id) {
                    directItems.push(mapped);
                    commitDirectItems();
                  }
                })(),
              ]
            : []),
        ]);
        commitDirectItems();
      })();

      let quickItems: Manga[] = [];
      try {
        const quickPayload = await mangaApi.search(keyword, 1, {
          includeMangaDex: false,
          attachRatings: false,
          skipAuth: true,
          timeoutMs: 1800,
        });
        quickItems = mapSearchPayloadToMangaOptions(quickPayload).slice(0, 12);

        if (requestSeq === mangaSearchRequestSeqRef.current) {
          if (quickItems.length > 0) {
            const rankedQuickItems = rankMangaSuggestions(quickItems, normalizedKeyword);
            setMangaSuggestions(rankedQuickItems.slice(0, MAX_MANGA_SUGGESTIONS));
          }
          updateCache(normalizedKeyword, quickItems);
        }
      } catch {
        // Best effort quick phase.
      }

      try {
        const enrichedPayload = await mangaApi.search(keyword, 1, {
          includeMangaDex: true,
          attachRatings: false,
          mangaDexLimit: 12,
          mangaDexTimeoutMs: 1800,
          mangaDexTranslatedLanguage: 'all',
          mangaDexAttachLatest: false,
          skipAuth: true,
          timeoutMs: 2600,
        });
        const enrichedItems = mapSearchPayloadToMangaOptions(enrichedPayload);
        const mergedItems = rankMangaSuggestions(
          dedupeMangaOptions([...directItems, ...enrichedItems, ...quickItems]),
          normalizedKeyword,
        ).slice(0, 12);

        if (requestSeq === mangaSearchRequestSeqRef.current) {
          if (mergedItems.length > 0) {
            setMangaSuggestions(mergedItems.slice(0, MAX_MANGA_SUGGESTIONS));
          } else if (!quickItems.length) {
            setMangaSuggestions([]);
          }
          updateCache(normalizedKeyword, mergedItems.length ? mergedItems : quickItems);
        }
      } catch {
        if (requestSeq === mangaSearchRequestSeqRef.current && !quickItems.length) {
          setMangaSuggestions([]);
        }
      } finally {
        void directLookupTask;
        if (requestSeq === mangaSearchRequestSeqRef.current) {
          setIsSearchingManga(false);
        }
      }
    }, isDirectMangaDexIdLookup ? 0 : 90);

    return () => {
      window.clearTimeout(timer);
    };
  }, [mangaSearchQuery, mode, mangaId, selectedMangaTitle]);

  const selectedMangaDexId = toMangaDexId(mangaId);
  const isMangaDexSelected = Boolean(selectedMangaDexId);

  useEffect(() => {
    if (mode !== 'chapter' || !mangaId) {
      setIsPreparingSelectedManga(false);
      return;
    }

    if (isMangaDexSelected) {
      if (isLoadingMangaDexChapters) {
        setIsPreparingSelectedManga(true);
        return;
      }

      const timer = window.setTimeout(() => {
        setIsPreparingSelectedManga(false);
      }, 220);
      return () => {
        window.clearTimeout(timer);
      };
    }

    const timer = window.setTimeout(() => {
      setIsPreparingSelectedManga(false);
    }, 320);
    return () => {
      window.clearTimeout(timer);
    };
  }, [mode, mangaId, isMangaDexSelected, isLoadingMangaDexChapters]);

  useEffect(() => {
    if (mode !== 'chapter' || !selectedMangaDexId) {
      setMangaDexChapterOptions([]);
      setSelectedMangaDexChapterId('');
      setIsLoadingMangaDexChapters(false);
      setMangaDexChapterHint('');
      setMangaDexLanguageFilter('all');
      return;
    }

    let cancelled = false;
    setIsLoadingMangaDexChapters(true);
    setMangaDexChapterOptions([]);
    setSelectedMangaDexChapterId('');
    setMangaDexChapterHint('');
    setMangaDexLanguageFilter('all');
    setChapterNumber('');

    const loadChapters = async () => {
      try {
        const [nonViPayload, viPayload] = await Promise.all([
          mangaApi.getMangaDexDetail(selectedMangaDexId, 300, 'non_vi'),
          mangaApi.getMangaDexDetail(selectedMangaDexId, 300, 'vi'),
        ]);

        const nonViRows = Array.isArray(nonViPayload?.manga?.chapters)
          ? (nonViPayload.manga.chapters as any[])
          : [];
        const viRows = Array.isArray(viPayload?.manga?.chapters)
          ? (viPayload.manga.chapters as any[])
          : [];

        const existingChapterKeys = new Set(
          viRows
            .map((chapter) => normalizeChapterKey(chapter?.chapter))
            .filter(Boolean),
        );

        const options = nonViRows
          .map((chapter) => {
            const chapterId = String(chapter?.id || '').trim();
            const chapterNumber = String(chapter?.chapter || '').trim();
            const chapterKey = normalizeChapterKey(chapterNumber);
            const chapterTitle = String(chapter?.title || '').trim();
            const languageCode = String(chapter?.translated_language || '').trim().toLowerCase();
            const publishAt = String(chapter?.publish_at || chapter?.created_at || '').trim();
            if (!chapterId) return null;
            if (!chapterNumber) return null;
            if (!chapterKey) return null;
            if (!languageCode || languageCode === 'vi') return null;

            const label = `Ch. ${chapterNumber}${chapterTitle ? ` - ${chapterTitle}` : ''} [${languageCode}]`;
            return {
              id: chapterId,
              chapterNumber,
              chapterKey,
              chapterTitle,
              language: languageCode,
              publishAt,
              label,
            } as MangaDexChapterOption;
          })
          .filter((option): option is MangaDexChapterOption => Boolean(option))
          .filter((option) => !existingChapterKeys.has(option.chapterKey));

        const deduped = Array.from(new Map(options.map((option) => [option.id, option])).values());
        deduped.sort((a, b) => {
          const byChapter = chapterSortValue(b.chapterNumber) - chapterSortValue(a.chapterNumber);
          if (byChapter !== 0) return byChapter;
          return Date.parse(b.publishAt || '') - Date.parse(a.publishAt || '');
        });

        if (!cancelled) {
          setMangaDexChapterOptions(deduped);
          if (!deduped.length) {
            setMangaDexChapterHint(
              nonViRows.length > 0
                ? 'Không còn chapter non-Vi mới (khác chapter hiện có) để dịch.'
                : 'Không có chapter MangaDex non-Vi để chọn cho truyện này.',
            );
          }
        }
      } catch {
        if (!cancelled) {
          setMangaDexChapterOptions([]);
          setMangaDexChapterHint('Không tải được danh sách chapter MangaDex non-Vi.');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingMangaDexChapters(false);
        }
      }
    };

    void loadChapters();

    return () => {
      cancelled = true;
    };
  }, [mode, selectedMangaDexId]);

  useEffect(() => {
    if (!isMangaDexSelected) return;
    // MangaDex flow here is for translation to Vietnamese chapters.
    setLanguage('vi');
  }, [isMangaDexSelected]);

  const availableMangaDexLanguages = useMemo(
    () => Array.from(new Set(mangaDexChapterOptions.map((chapter) => chapter.language))).sort((a, b) => a.localeCompare(b)),
    [mangaDexChapterOptions],
  );

  const visibleMangaDexChapterOptions = useMemo(() => {
    if (mangaDexLanguageFilter === 'all') return mangaDexChapterOptions;
    return mangaDexChapterOptions.filter((chapter) => chapter.language === mangaDexLanguageFilter);
  }, [mangaDexChapterOptions, mangaDexLanguageFilter]);

  useEffect(() => {
    if (!selectedMangaDexChapterId) return;
    const stillVisible = visibleMangaDexChapterOptions.some((chapter) => chapter.id === selectedMangaDexChapterId);
    if (stillVisible) return;
    setSelectedMangaDexChapterId('');
    setChapterNumber('');
    setChapterTitle('');
  }, [selectedMangaDexChapterId, visibleMangaDexChapterOptions]);

  // Manga fields
  const [mangaTitle, setMangaTitle] = useState('');
  const [mangaAuthor, setMangaAuthor] = useState('');
  const [mangaArtist, setMangaArtist] = useState('');
  const [mangaType, setMangaType] = useState('manga');
  const [mangaDescription, setMangaDescription] = useState('');
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [mangaStatus, setMangaStatus] = useState<'ongoing' | 'completed'>('ongoing');

  // Shared
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [coverImage, setCoverImage] = useState<UploadedImage | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [mangaDexChapterPreviewImages, setMangaDexChapterPreviewImages] = useState<UploadedImage[]>([]);
  const [isLoadingMangaDexChapterPreview, setIsLoadingMangaDexChapterPreview] = useState(false);
  const [mangaDexChapterPreviewHint, setMangaDexChapterPreviewHint] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const mangaDexChapterPreviewRequestSeqRef = useRef(0);

  useEffect(() => {
    if (!isMangaDexSelected || !selectedMangaDexChapterId) {
      mangaDexChapterPreviewRequestSeqRef.current += 1;
      setMangaDexChapterPreviewImages([]);
      setIsLoadingMangaDexChapterPreview(false);
      setMangaDexChapterPreviewHint('');
      return;
    }

    const requestSeq = mangaDexChapterPreviewRequestSeqRef.current + 1;
    mangaDexChapterPreviewRequestSeqRef.current = requestSeq;
    setIsLoadingMangaDexChapterPreview(true);
    setMangaDexChapterPreviewImages([]);
    setMangaDexChapterPreviewHint('');

    const loadChapterPreviewImages = async () => {
      try {
        let payload = await mangaApi.getMangaDexChapterPages(selectedMangaDexChapterId, 'saver', true, 20_000);
        if (requestSeq !== mangaDexChapterPreviewRequestSeqRef.current) return;

        let previewUrls = Array.isArray(payload?.image_urls)
          ? payload.image_urls
              .map((url: unknown) => String(url || '').trim())
              .filter(Boolean)
          : [];

        if (!previewUrls.length) {
          payload = await mangaApi.getMangaDexChapterPages(selectedMangaDexChapterId, 'data', true, 20_000);
          if (requestSeq !== mangaDexChapterPreviewRequestSeqRef.current) return;
          previewUrls = Array.isArray(payload?.image_urls)
            ? payload.image_urls
                .map((url: unknown) => String(url || '').trim())
                .filter(Boolean)
            : [];
        }

        const fallbackUrls = Array.isArray(payload?.fallback_image_urls)
          ? payload.fallback_image_urls
              .map((url: unknown) => String(url || '').trim())
              .filter(Boolean)
          : [];

        const previewRows: UploadedImage[] = previewUrls.map((url, index) => ({
          id: `mdx-preview-${selectedMangaDexChapterId}-${index}`,
          file: null,
          preview: url,
          fallbackPreview: fallbackUrls[index] || undefined,
          name: `Trang ${index + 1}`,
          size: 0,
        }));

        setMangaDexChapterPreviewImages(previewRows);
        setPreviewMode(true);

        if (!previewRows.length) {
          const apiError = String(payload?.error || '').trim();
          setMangaDexChapterPreviewHint(
            apiError || 'Không lấy được ảnh từ chapter MangaDex đã chọn.',
          );
        }
      } catch {
        if (requestSeq !== mangaDexChapterPreviewRequestSeqRef.current) return;
        setMangaDexChapterPreviewImages([]);
        setMangaDexChapterPreviewHint('Không tải được ảnh chapter MangaDex.');
      } finally {
        if (requestSeq === mangaDexChapterPreviewRequestSeqRef.current) {
          setIsLoadingMangaDexChapterPreview(false);
        }
      }
    };

    void loadChapterPreviewImages();
  }, [isMangaDexSelected, selectedMangaDexChapterId]);

  const shouldShowMangaDexChapterPreview = Boolean(
    isMangaDexSelected && selectedMangaDexChapterId && images.length === 0,
  );
  const previewImages = shouldShowMangaDexChapterPreview
    ? mangaDexChapterPreviewImages
    : images;
  const isThumbnailPreviewMode = shouldShowMangaDexChapterPreview || previewMode;
  const activePreviewImage =
    lightboxIndex !== null && lightboxIndex >= 0 && lightboxIndex < previewImages.length
      ? previewImages[lightboxIndex]
      : null;
  const studioRouteState = location.state as
    | { studioApplied?: boolean; studioSessionId?: string }
    | null;

  useEffect(() => {
    if (!studioRouteState?.studioApplied) return;
    if (!studioRouteState.studioSessionId) return;
    if (studioRouteState.studioSessionId !== studioSessionId) return;
    if (!studioImages.length) return;

    setImages(
      studioImages.map((item, index) => ({
        id: String(item?.id || `studio-${index}`),
        file: item?.file || null,
        preview: String(item?.preview || ''),
        name: String(item?.name || `Trang ${index + 1}`),
        size: Number(item?.size || item?.file?.size || 0),
      })),
    );
    setPreviewMode(true);
    setLightboxIndex(null);
    toast.success('Da nhan anh tu Translation Studio');
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate, studioImages, studioRouteState, studioSessionId]);

  useEffect(() => {
    if (!images.length && !shouldShowMangaDexChapterPreview) {
      setPreviewMode(false);
    }
  }, [images.length, shouldShowMangaDexChapterPreview]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    if (!previewImages.length) {
      setLightboxIndex(null);
      return;
    }
    if (lightboxIndex > previewImages.length - 1) {
      setLightboxIndex(previewImages.length - 1);
    }
  }, [lightboxIndex, previewImages.length]);

  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightboxIndex(null);
        return;
      }
      if (event.key === 'ArrowLeft') {
        setLightboxIndex((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
        return;
      }
      if (event.key === 'ArrowRight') {
        setLightboxIndex((prev) => (prev === null ? prev : Math.min(previewImages.length - 1, prev + 1)));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [lightboxIndex, previewImages.length]);

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const newImages: UploadedImage[] = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .map((f, i) => ({
        id: `img-${Date.now()}-${i}`,
        file: f,
        preview: URL.createObjectURL(f),
        name: f.name,
        size: f.size,
      }));
    setImages(prev => [...prev, ...newImages]);
    if (newImages.length > 0) {
      setPreviewMode(true);
    }
  };

  const handleCoverSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (!f.type.startsWith('image/')) return;
    setCoverImage({
      id: `cover-${Date.now()}`,
      file: f,
      preview: URL.createObjectURL(f),
      name: f.name,
      size: f.size,
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const removeImage = (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
  };

  const toggleGenre = (genre: string) => {
    setSelectedGenres(prev =>
      prev.includes(genre) ? prev.filter(g => g !== genre) : [...prev, genre]
    );
  };

  const handleSubmit = async (status: 'draft' | 'pending') => {
    setUploading(true);
    setUploadProgress(0);
    try {
      const files = images.map(img => img.file).filter(Boolean) as File[];
      const hasMangaDexPreview = isMangaDexSelected && mangaDexChapterPreviewImages.length > 0 && files.length === 0;

      if (mode === 'chapter' && (files.length > 0 || hasMangaDexPreview)) {
        let pageUrls: string[] = [];

        if (files.length > 0) {
          // User uploaded their own images — upload to storage
          setUploadProgress(10);
          const uploadResult = await uploadApi.uploadImages(mangaId, chapterNumber, files);
          setUploadProgress(60);
          pageUrls = uploadResult.urls || uploadResult.pages || [];
        } else if (hasMangaDexPreview) {
          // MangaDex source — download images then upload to Supabase Storage
          setUploadProgress(5);
          const previewSources = mangaDexChapterPreviewImages
            .map(img => [img.preview, img.fallbackPreview].filter(Boolean) as string[])
            .filter(sources => sources.length > 0);

          // Download all preview images as blobs and convert to File objects
          const downloadedFiles: File[] = [];
          for (let i = 0; i < previewSources.length; i++) {
            for (const sourceUrl of previewSources[i]) {
              try {
                const response = await fetch(sourceUrl);
                if (!response.ok) continue;
                const blob = await response.blob();
                const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
                const fileName = `${String(i + 1).padStart(3, '0')}.${ext}`;
                downloadedFiles.push(new File([blob], fileName, { type: blob.type || 'image/jpeg' }));
                break;
              } catch {
                // Try the next source for this page.
              }
            }
            // Update progress as we download (5% - 40%)
            setUploadProgress(5 + Math.round((i / previewSources.length) * 35));
          }

          if (downloadedFiles.length === 0) {
            throw new Error('Không tải được ảnh từ MangaDex. Vui lòng thử lại.');
          }

          // Upload downloaded files to Supabase Storage
          setUploadProgress(45);
          const uploadResult = await uploadApi.uploadImages(mangaId, chapterNumber, downloadedFiles);
          setUploadProgress(60);
          pageUrls = uploadResult.urls || uploadResult.pages || [];
        }

        await uploadApi.create({
          manga_slug: mangaId,
          manga_title: selectedMangaTitle || mangaSearchQuery.trim() || mangaId,
          chapter_number: chapterNumber,
          chapter_title: chapterTitle || `Chương ${chapterNumber}`,
          language,
          group_id: resolvedGroupId || undefined,
          pages: pageUrls,
          status,
        });
        setUploadProgress(100);
        toast.success(status === 'pending' ? 'Đã gửi duyệt thành công!' : 'Đã lưu bản nháp!');
        setTimeout(() => navigate('/upload'), 1500);
      } else if (mode === 'manga' && coverImage?.file) {
        setUploadProgress(20);
        await uploadApi.createManga({
          title: mangaTitle.trim(),
          author: mangaAuthor.trim(),
          artist: mangaArtist.trim(),
          mangaType,
          publishStatus: mangaStatus,
          description: mangaDescription.trim(),
          genres: selectedGenres,
          language,
          groupId: resolvedGroupId || undefined,
          status,
          cover: coverImage.file,
        });
        setUploadProgress(100);
        toast.success(status === 'pending' ? 'Đã gửi duyệt truyện mới!' : 'Đã lưu bản nháp truyện!');
        setTimeout(() => navigate('/upload'), 1500);
      }
    } catch (err: any) {
      toast.error(err.message || 'Upload thất bại. Vui lòng thử lại.');
    } finally {
      setUploading(false);
    }
  };

  const hasAnyChapterImages = images.length > 0 || (isMangaDexSelected && mangaDexChapterPreviewImages.length > 0);
  const isChapterValid = isMangaDexSelected
    ? Boolean(mangaId && selectedMangaDexChapterId && chapterNumber && hasAnyChapterImages)
    : Boolean(mangaId && chapterNumber && hasAnyChapterImages);
  const isMangaValid = mangaTitle.trim() && mangaAuthor.trim() && selectedGenres.length > 0 && coverImage;
  const isValid = mode === 'chapter' ? isChapterValid : isMangaValid;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const hasChapterImages = mode === 'chapter' && previewImages.length > 0;

  const handleEnterEditMode = () => {
    if (!previewImages.length) return;
    setLightboxIndex(null);
    const nextSessionId = startStudioSession(
      previewImages.map((image, index) => ({
        id: String(image?.id || `studio-${index}`),
        file: image?.file || null,
        preview: String(image?.preview || ''),
        name: String(image?.name || `Trang ${index + 1}`),
        size: Number(image?.size || image?.file?.size || 0),
      })),
      lightboxIndex !== null ? lightboxIndex : 0,
      '/upload/new',
    );

    navigate('/upload/editor', {
      state: {
        studioSessionId: nextSessionId,
      },
    });
  };

  const detectImageExtension = (image: UploadedImage, blob: Blob): string => {
    const normalizeExt = (value: string): string => {
      const raw = String(value || '').trim().toLowerCase();
      if (!raw) return '';
      if (raw === 'jpeg') return 'jpg';
      if (raw === 'svg+xml') return 'svg';
      return raw;
    };

    const fromName = String(image?.name || '').match(/\.([a-zA-Z0-9]+)$/);
    const byName = normalizeExt(fromName?.[1] || '');
    if (byName) return byName;

    const byType = normalizeExt(String(blob?.type || '').split('/')[1] || '');
    if (byType) return byType;

    try {
      const url = new URL(String(image?.preview || ''), window.location.origin);
      const fromUrl = String(url.pathname || '').match(/\.([a-zA-Z0-9]+)$/);
      const byUrl = normalizeExt(fromUrl?.[1] || '');
      if (byUrl) return byUrl;
    } catch {
      // Keep fallback.
    }

    return 'jpg';
  };

  const handleDownloadImagesZip = async () => {
    if (!previewImages.length) return;

    setIsDownloadingZip(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();

      let addedCount = 0;
      let failedCount = 0;
      for (let index = 0; index < previewImages.length; index += 1) {
        const image = previewImages[index];
        try {
          let blob: Blob;
          if (image.file) {
            blob = image.file;
          } else {
            const response = await fetch(image.preview);
            if (!response.ok) {
              throw new Error(`Không tải được ảnh trang ${index + 1}`);
            }
            blob = await response.blob();
          }

          const ext = detectImageExtension(image, blob);
          const fileName = `${String(index + 1).padStart(3, '0')}.${ext}`;
          zip.file(fileName, blob);
          addedCount += 1;
        } catch {
          failedCount += 1;
        }
      }

      if (addedCount === 0) {
        throw new Error('Không thể nén ảnh nào. Vui lòng kiểm tra lại nguồn ảnh.');
      }

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const rawBase = String(selectedMangaTitle || mangaSearchQuery || mangaId || 'chapter').trim();
      const safeBase = rawBase
        .replace(/[^a-zA-Z0-9\s-]+/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      const safeChapter = String(chapterNumber || 'x')
        .replace(/[^a-zA-Z0-9.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      const downloadName = `${safeBase || 'chapter'}-chapter-${safeChapter || 'x'}.zip`;

      const objectUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);

      if (failedCount > 0) {
        toast.success(`Đã tải ZIP (${addedCount}/${previewImages.length} ảnh). Một số ảnh không tải được.`);
      } else {
        toast.success(`Đã tải ZIP thành công (${addedCount} ảnh).`);
      }
    } catch (error: any) {
      toast.error(error?.message || 'Không thể tạo file ZIP.');
    } finally {
      setIsDownloadingZip(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link to="/upload" className="p-2 rounded-lg hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            <div>
              <h1 className="text-xl font-bold">Upload nội dung mới</h1>
              <p className="text-xs text-muted-foreground mt-0.5">Tải lên truyện hoặc chapter mới</p>
            </div>
          </div>
        </div>

        {/* Mode tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMode('chapter')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              mode === 'chapter'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileUp className="w-4 h-4" /> Upload Chapter
          </button>
          <button
            onClick={() => setMode('manga')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              mode === 'manga'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            <BookPlus className="w-4 h-4" /> Upload Truyện mới
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Form */}
          <div className="lg:col-span-1 space-y-4">
            <AnimatePresence mode="wait">
              {mode === 'chapter' ? (
                <motion.div key="chapter-form" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}>
                  <div className="bg-card border border-border rounded-xl p-4 space-y-4">
                    <h2 className="font-bold text-sm flex items-center gap-2">
                      <FileUp className="w-4 h-4 text-primary" /> Thông tin chapter
                    </h2>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Truyện *</label>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                          type="text"
                          value={mangaSearchQuery}
                          onChange={e => {
                            setMangaSearchQuery(e.target.value);
                            setSelectedMangaTitle('');
                            setMangaId('');
                            setIsPreparingSelectedManga(false);
                            setMangaDexChapterOptions([]);
                            setSelectedMangaDexChapterId('');
                            setChapterNumber('');
                            setChapterTitle('');
                            setMangaDexLanguageFilter('all');
                          }}
                          placeholder="Tìm theo tên, MangaDex ID, hoặc OTruyen slug..."
                          className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>

                      {isSearchingManga && (
                        <p className="text-[11px] text-muted-foreground mt-1">Đang tìm truyện...</p>
                      )}

                      {mangaSuggestions.length > 0 && (
                        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-card divide-y divide-border">
                          {mangaSuggestions.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setIsPreparingSelectedManga(true);
                                setMangaId(item.id);
                                setSelectedMangaTitle(item.title);
                                setMangaSearchQuery(item.title);
                                setMangaSuggestions([]);
                                setMangaDexChapterOptions([]);
                                setSelectedMangaDexChapterId('');
                                setChapterNumber('');
                                setChapterTitle('');
                                setMangaDexLanguageFilter('all');
                              }}
                              className="w-full flex items-center gap-2.5 text-left px-3 py-2.5 hover:bg-secondary/60 transition-colors"
                            >
                              <OptimizedImage
                                src={item.cover}
                                fallbackSrc={item.coverProxy || '/no-cover.svg'}
                                alt={item.title}
                                className="w-9 h-12 rounded object-cover border border-border shrink-0"
                                priority={false}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold line-clamp-1">{item.title}</p>
                                <p className="text-[11px] text-muted-foreground line-clamp-1">{compactAuthorText(item.author || 'Chưa rõ tác giả')}</p>
                              </div>
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${toMangaDexId(item.id) ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                                {toMangaDexId(item.id) ? 'MangaDex' : 'OTruyen'}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      {mangaId ? (
                        <p className="text-[11px] text-muted-foreground mt-1.5">
                          Đã chọn: <span className="font-semibold text-foreground">{selectedMangaTitle || mangaSearchQuery || mangaId}</span>
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground mt-1.5">Hãy chọn truyện từ danh sách gợi ý.</p>
                      )}
                      {mangaId && !isMangaDexSelected && (
                        <p className="text-[11px] text-amber-500 mt-1">
                          Truyện đang chọn không phải MangaDex. Hãy chọn mục có nhãn MangaDex để hiện danh sách chapter dịch.
                        </p>
                      )}
                      {mangaId && isPreparingSelectedManga && (
                        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                          <span>Đang tải dữ liệu truyện, vui lòng chờ...</span>
                        </div>
                      )}
                    </div>

                    {isMangaDexSelected && (
                      <div className="space-y-2">
                        <label className="text-xs text-muted-foreground font-medium mb-1 block">Chapter hiện có (MangaDex) *</label>
                        <div className="space-y-2">
                          <div>
                            <label className="text-[11px] text-muted-foreground font-medium mb-1 block">Lọc ngôn ngữ chapter</label>
                            <select
                              value={mangaDexLanguageFilter}
                              onChange={(e) => setMangaDexLanguageFilter(e.target.value)}
                              disabled={isPreparingSelectedManga || isLoadingMangaDexChapters || availableMangaDexLanguages.length === 0}
                              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                            >
                              <option value="all">Tất cả non-Vi</option>
                              {availableMangaDexLanguages.map((langCode) => (
                                <option key={langCode} value={langCode}>
                                  {languageLabelFromCode(langCode)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground font-medium mb-1 block">Chọn chapter để dịch</label>
                            <select
                              value={selectedMangaDexChapterId}
                              onChange={(e) => {
                                const selectedId = e.target.value;
                                setSelectedMangaDexChapterId(selectedId);
                                const option = visibleMangaDexChapterOptions.find((chapter) => chapter.id === selectedId);
                                if (!option) {
                                  setChapterNumber('');
                                  setChapterTitle('');
                                  return;
                                }
                                setChapterNumber(option.chapterNumber);
                                setChapterTitle(option.chapterTitle || `MangaDex chapter ${option.chapterNumber}`);
                              }}
                              disabled={isPreparingSelectedManga || isLoadingMangaDexChapters || visibleMangaDexChapterOptions.length === 0}
                              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                            >
                              <option value="">
                                {isLoadingMangaDexChapters
                                  ? 'Đang tải chapter MangaDex...'
                                  : 'Chọn chapter non-Vi chưa có'}
                              </option>
                              {visibleMangaDexChapterOptions.map((chapter) => (
                                <option key={chapter.id} value={chapter.id}>
                                  {chapter.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {!isLoadingMangaDexChapters && visibleMangaDexChapterOptions.length === 0 && (
                          <p className="text-[11px] text-muted-foreground mt-1.5">
                            {mangaDexChapterHint}
                          </p>
                        )}
                      </div>
                    )}

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Số chương *</label>
                      <input
                        type={isMangaDexSelected ? 'text' : 'number'}
                        value={chapterNumber}
                        onChange={e => setChapterNumber(e.target.value)}
                        disabled={isPreparingSelectedManga}
                        readOnly={isMangaDexSelected}
                        placeholder={isMangaDexSelected ? 'Tự động từ chapter MangaDex đã chọn' : '21'}
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 read-only:opacity-70 disabled:opacity-60"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Tiêu đề</label>
                      <input type="text" value={chapterTitle} onChange={e => setChapterTitle(e.target.value)}
                        disabled={isPreparingSelectedManga}
                        placeholder="Tiêu đề chương (tuỳ chọn)" className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60" />
                    </div>

                    {!isMangaDexSelected && (
                      <div>
                        <label className="text-xs text-muted-foreground font-medium mb-1 block">Ngôn ngữ</label>
                        <select value={language} onChange={e => setLanguage(e.target.value)} disabled={isPreparingSelectedManga}
                          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60">
                          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Nhóm dịch</label>
                      <input
                        type="text"
                        value={groupInput}
                        onChange={(e) => setGroupInput(e.target.value)}
                        disabled={isPreparingSelectedManga}
                        list="uploader-group-suggestions"
                        placeholder="Nhập ID hoặc tên nhóm dịch (tuỳ chọn)"
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                      />
                      {groupSuggestions.length > 0 && (
                        <datalist id="uploader-group-suggestions">
                          {groupSuggestions.map((group) => (
                            <option key={`group-suggestion-${group.id || group.value}`} value={group.value}>
                              {group.id ? `ID: ${group.id}` : ''}
                            </option>
                          ))}
                        </datalist>
                      )}
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="text-[10px] text-muted-foreground">
                          Có thể nhập ID hoặc tên nhóm. Nếu trùng tên nhóm của bạn, hệ thống sẽ tự đổi sang ID nhóm.
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowCreateGroupForm((prev) => !prev)}
                          disabled={isPreparingSelectedManga}
                          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary text-muted-foreground hover:text-foreground text-[10px] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <Plus className="w-3 h-3" />
                          {showCreateGroupForm ? 'Ẩn tạo nhóm' : 'Tạo nhóm mới'}
                        </button>
                      </div>

                      {showCreateGroupForm && (
                        <div className="mt-2 rounded-lg border border-border bg-secondary/20 p-2.5 space-y-2">
                          <input
                            type="text"
                            value={newGroupName}
                            onChange={(e) => setNewGroupName(e.target.value)}
                            disabled={isPreparingSelectedManga}
                            placeholder="Tên nhóm mới (ít nhất 3 ký tự)"
                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                          />
                          <textarea
                            value={newGroupDescription}
                            onChange={(e) => setNewGroupDescription(e.target.value)}
                            disabled={isPreparingSelectedManga}
                            placeholder="Mô tả nhóm (tuỳ chọn)"
                            rows={2}
                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none disabled:opacity-60"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                if (isCreatingGroup || isPreparingSelectedManga) return;
                                setShowCreateGroupForm(false);
                              }}
                              disabled={isPreparingSelectedManga}
                              className="px-2.5 py-1.5 rounded-md bg-secondary text-muted-foreground hover:text-foreground text-[11px] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              Hủy
                            </button>
                            <button
                              type="button"
                              onClick={handleCreateGroupInline}
                              disabled={isPreparingSelectedManga || isCreatingGroup || String(newGroupName || '').trim().length < 3}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              {isCreatingGroup ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                              Tạo nhóm
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="manga-form" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}>
                  <div className="bg-card border border-border rounded-xl p-4 space-y-4">
                    <h2 className="font-bold text-sm flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-primary" /> Thông tin truyện
                    </h2>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Tên truyện *</label>
                      <input type="text" value={mangaTitle} onChange={e => setMangaTitle(e.target.value)}
                        placeholder="Nhập tên truyện" className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Tác giả *</label>
                      <input type="text" value={mangaAuthor} onChange={e => setMangaAuthor(e.target.value)}
                        placeholder="Tên tác giả" className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Họa sĩ</label>
                      <input type="text" value={mangaArtist} onChange={e => setMangaArtist(e.target.value)}
                        placeholder="Tên họa sĩ (tuỳ chọn)" className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Loại truyện</label>
                      <select value={mangaType} onChange={e => setMangaType(e.target.value)}
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                        {MANGA_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Trạng thái</label>
                      <div className="flex gap-2">
                        {(['ongoing', 'completed'] as const).map(s => (
                          <button key={s} onClick={() => setMangaStatus(s)}
                            className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                              mangaStatus === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                            }`}>
                            {s === 'ongoing' ? 'Đang tiến hành' : 'Hoàn thành'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1 block">Mô tả</label>
                      <textarea value={mangaDescription} onChange={e => setMangaDescription(e.target.value)}
                        placeholder="Mô tả nội dung truyện..." rows={3}
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" />
                    </div>

                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1.5 block">Thể loại *</label>
                      <div className="flex flex-wrap gap-1.5">
                        {categories.map(cat => (
                          <button key={cat.slug} onClick={() => toggleGenre(cat.name)}
                            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                              selectedGenres.includes(cat.name)
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-secondary text-muted-foreground hover:text-foreground'
                            }`}>
                            {cat.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Cover image */}
                    <div>
                      <label className="text-xs text-muted-foreground font-medium mb-1.5 block">Ảnh bìa *</label>
                      {coverImage ? (
                        <div className="relative w-32">
                          <img src={coverImage.preview} alt="Cover" className="w-32 h-44 object-cover rounded-lg border border-border" />
                          <button onClick={() => setCoverImage(null)}
                            className="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-destructive text-destructive-foreground">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <label className="flex flex-col items-center justify-center w-32 h-44 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/40 transition-colors">
                          <ImagePlus className="w-6 h-6 text-muted-foreground mb-1" />
                          <span className="text-[10px] text-muted-foreground">Chọn ảnh bìa</span>
                          <input type="file" accept="image/*" className="hidden" onChange={e => handleCoverSelect(e.target.files)} />
                        </label>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Actions */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              {mode === 'chapter' ? (
                <>
                  <button onClick={() => handleSubmit('pending')} disabled={!isValid || uploading}
                    className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                    <Upload className="w-4 h-4" /> Gửi duyệt chapter
                  </button>
                  <button onClick={() => handleSubmit('draft')} disabled={!isValid || uploading}
                    className="w-full px-4 py-2.5 rounded-xl bg-secondary border border-border text-sm font-bold hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                    Lưu bản nháp
                  </button>

                  {uploading && (
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Đang tải lên...</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full bg-secondary rounded-full h-2">
                        <motion.div className="bg-emerald-500 h-full rounded-full" animate={{ width: `${uploadProgress}%` }} />
                      </div>
                    </div>
                  )}

                  {!isValid && !uploading && (
                    <p className="text-[10px] text-yellow-400 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      {mode === 'chapter' ? 'Cần chọn truyện, số chapter và ít nhất 1 ảnh' : 'Cần nhập tên, tác giả, thể loại và ảnh bìa'}
                    </p>
                  )}

                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-[10px] text-muted-foreground font-medium">Công cụ hỗ trợ</p>
                    <button
                      onClick={handleEnterEditMode}
                      disabled={!hasChapterImages || isPreparingSelectedManga || isDownloadingZip}
                      className="w-full px-4 py-2 rounded-xl bg-primary/10 border border-primary/20 text-primary text-xs font-bold hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Mở Translation Studio
                    </button>

                    <button
                      onClick={handleDownloadImagesZip}
                      disabled={!hasChapterImages || isPreparingSelectedManga || isDownloadingZip}
                      className="w-full px-4 py-2 rounded-xl bg-secondary border border-border text-xs font-bold hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isDownloadingZip ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                      {isDownloadingZip ? 'Đang nén ZIP...' : 'Tải xuống ZIP'}
                    </button>

                    {!hasChapterImages && (
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Cần có ít nhất 1 ảnh để dùng công cụ hỗ trợ
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button onClick={() => handleSubmit('pending')} disabled={!isValid || uploading}
                    className="w-full px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                    <Upload className="w-4 h-4" /> Gửi duyệt
                  </button>
                  <button onClick={() => handleSubmit('draft')} disabled={!isValid || uploading}
                    className="w-full px-4 py-2.5 rounded-xl bg-secondary border border-border text-sm font-bold hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    Lưu bản nháp
                  </button>

                  {uploading && (
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Đang tải lên...</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full bg-secondary rounded-full h-2">
                        <motion.div className="bg-primary h-full rounded-full" animate={{ width: `${uploadProgress}%` }} />
                      </div>
                    </div>
                  )}

                  {!isValid && (
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Cần nhập tên, tác giả, chọn thể loại và ảnh bìa
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Image upload area - only for chapter mode */}
          {mode === 'chapter' && (
            <div className="lg:col-span-2">
              <div className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-bold text-sm">Ảnh truyện ({previewImages.length} trang)</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        if (shouldShowMangaDexChapterPreview) return;
                        setPreviewMode(!previewMode);
                      }}
                      disabled={shouldShowMangaDexChapterPreview || images.length === 0}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        isThumbnailPreviewMode ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                      }`}>
                      <Eye className="w-3 h-3" /> {isThumbnailPreviewMode ? 'Thu nhỏ' : 'Xem trước'}
                    </button>
                    <label className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-secondary text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                      <FileArchive className="w-3 h-3" /> ZIP
                      <input type="file" accept=".zip" className="hidden" />
                    </label>
                  </div>
                </div>

                {/* Drop zone / MangaDex source preview */}
                {shouldShowMangaDexChapterPreview ? (
                  <div className="border border-border rounded-xl p-4 bg-secondary/20">
                    {isLoadingMangaDexChapterPreview && (
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-5">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Đang tải ảnh chapter MangaDex...
                      </div>
                    )}

                    {!isLoadingMangaDexChapterPreview && mangaDexChapterPreviewHint && !mangaDexChapterPreviewImages.length && (
                      <p className="text-xs text-muted-foreground">{mangaDexChapterPreviewHint}</p>
                    )}

                    {!isLoadingMangaDexChapterPreview && mangaDexChapterPreviewImages.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Đã tải ảnh chapter MangaDex. Bấm vào ảnh nhỏ bên dưới để phóng to xem chi tiết.
                      </p>
                    )}

                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      className={`mt-3 border-2 border-dashed rounded-xl p-5 text-center transition-all ${
                        isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                      }`}
                    >
                      <p className="text-xs text-muted-foreground mb-2">Muốn dùng ảnh bản dịch riêng? Kéo thả hoặc chọn ảnh tại đây.</p>
                      <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold cursor-pointer hover:bg-primary/90 transition-colors">
                        <ImagePlus className="w-4 h-4" /> Chọn ảnh
                        <input type="file" accept="image/*" multiple className="hidden" onChange={e => handleFileSelect(e.target.files)} />
                      </label>
                    </div>
                  </div>
                ) : (
                  <div
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                      isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                    }`}>
                    <ImagePlus className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground mb-2">Kéo thả ảnh vào đây hoặc</p>
                    <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold cursor-pointer hover:bg-primary/90 transition-colors">
                      <ImagePlus className="w-4 h-4" /> Chọn ảnh
                      <input type="file" accept="image/*" multiple className="hidden" onChange={e => handleFileSelect(e.target.files)} />
                    </label>
                    <p className="text-[10px] text-muted-foreground mt-2">JPG, PNG, WEBP • Tối đa 10MB/ảnh</p>
                  </div>
                )}

                {/* Image list */}
                {images.length > 0 && !isThumbnailPreviewMode && (
                  <Reorder.Group axis="y" values={images} onReorder={setImages} className="mt-4 space-y-1.5">
                    {images.map((img, i) => (
                      <Reorder.Item key={img.id} value={img}>
                        <div className="flex items-center gap-3 bg-secondary/30 rounded-lg px-3 py-2 cursor-grab active:cursor-grabbing">
                          <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="text-xs font-bold text-muted-foreground w-6">{i + 1}</span>
                          <img src={img.preview} alt="" className="w-10 h-14 object-cover rounded" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium line-clamp-1">{img.name}</p>
                            <p className="text-[10px] text-muted-foreground">{formatSize(img.size)}</p>
                          </div>
                          <button onClick={() => removeImage(img.id)} className="p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                )}

                {/* Thumbnail preview mode */}
                {previewImages.length > 0 && isThumbnailPreviewMode && (
                  <div className="mt-4">
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                      {previewImages.map((img, i) => (
                        <div key={img.id} className="relative group">
                          <button
                            type="button"
                            onClick={() => setLightboxIndex(i)}
                            className="w-full overflow-hidden rounded-lg border border-border bg-secondary/20"
                          >
                            <img
                              src={img.preview}
                              alt={`Trang ${i + 1}`}
                              loading="lazy"
                              onError={(event) => {
                                const fallback = img.fallbackPreview;
                                if (fallback && event.currentTarget.src !== fallback) {
                                  event.currentTarget.src = fallback;
                                }
                              }}
                              className="w-full aspect-[3/4] object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                            />
                            <div className="absolute top-1.5 left-1.5 bg-card/85 backdrop-blur-sm px-1.5 py-0.5 rounded text-[10px] font-bold">
                              {i + 1}
                            </div>
                          </button>

                          {!!img.file && (
                            <button
                              type="button"
                              onClick={() => removeImage(img.id)}
                              className="absolute top-1.5 right-1.5 z-10 p-1 rounded-md bg-card/90 text-muted-foreground hover:text-destructive hover:bg-card transition-colors"
                              aria-label={`Xóa trang ${i + 1}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {shouldShowMangaDexChapterPreview && (
                      <p className="text-[11px] text-muted-foreground mt-2">
                        Đây là ảnh gốc MangaDex để tham khảo. Bạn vẫn có thể tải ảnh bản dịch của mình ở khung phía trên.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Manga mode - preview panel */}
          {mode === 'manga' && (
            <div className="lg:col-span-2">
              <div className="bg-card border border-border rounded-xl p-6">
                <h2 className="font-bold text-sm mb-4 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-primary" /> Xem trước
                </h2>
                <div className="flex gap-5">
                  {coverImage ? (
                    <img src={coverImage.preview} alt="Cover preview" className="w-36 h-52 object-cover rounded-lg border border-border shrink-0" />
                  ) : (
                    <div className="w-36 h-52 bg-secondary rounded-lg border border-border flex items-center justify-center shrink-0">
                      <BookOpen className="w-8 h-8 text-muted-foreground/30" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-bold line-clamp-2">{mangaTitle || 'Tên truyện'}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{mangaAuthor || 'Tác giả'}{mangaArtist ? ` • ${mangaArtist}` : ''}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary uppercase">{mangaType}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${mangaStatus === 'ongoing' ? 'bg-green-500/10 text-green-600' : 'bg-blue-500/10 text-blue-600'}`}>
                        {mangaStatus === 'ongoing' ? 'Đang tiến hành' : 'Hoàn thành'}
                      </span>
                    </div>
                    {mangaDescription && (
                      <p className="text-xs text-muted-foreground mt-3 line-clamp-4">{mangaDescription}</p>
                    )}
                    {selectedGenres.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {selectedGenres.map(g => (
                          <span key={g} className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-secondary text-muted-foreground">{g}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activePreviewImage && lightboxIndex !== null && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm p-3 sm:p-6"
              onClick={() => setLightboxIndex(null)}
            >
              <div className="h-full max-w-6xl mx-auto flex items-center justify-center relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(null);
                  }}
                  className="absolute top-2 right-2 sm:top-0 sm:right-0 p-2 rounded-lg bg-card/90 text-foreground hover:bg-card transition-colors z-20"
                  aria-label="Đóng xem ảnh"
                >
                  <X className="w-5 h-5" />
                </button>

                <button
                  type="button"
                  disabled={lightboxIndex <= 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
                  }}
                  className="absolute left-0 sm:left-2 p-2 rounded-lg bg-card/90 text-foreground hover:bg-card transition-colors disabled:opacity-40 disabled:cursor-not-allowed z-20"
                  aria-label="Ảnh trước"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>

                <button
                  type="button"
                  disabled={lightboxIndex >= previewImages.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex((prev) => (prev === null ? prev : Math.min(previewImages.length - 1, prev + 1)));
                  }}
                  className="absolute right-0 sm:right-2 p-2 rounded-lg bg-card/90 text-foreground hover:bg-card transition-colors disabled:opacity-40 disabled:cursor-not-allowed z-20"
                  aria-label="Ảnh kế tiếp"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>

                <div
                  className="max-h-full max-w-full"
                  onClick={(e) => e.stopPropagation()}
                >
                  <img
                    src={activePreviewImage.preview}
                    alt={activePreviewImage.name || `Trang ${lightboxIndex + 1}`}
                    onError={(event) => {
                      const fallback = activePreviewImage.fallbackPreview;
                      if (fallback && event.currentTarget.src !== fallback) {
                        event.currentTarget.src = fallback;
                      }
                    }}
                    className="max-h-[86vh] max-w-[88vw] object-contain rounded-lg shadow-2xl"
                  />
                  <div className="mt-2 text-center text-xs text-white/90 font-semibold">
                    Trang {lightboxIndex + 1} / {previewImages.length}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

        </div>
      </div>
    </div>
  );
};

export default UploadChapter;
