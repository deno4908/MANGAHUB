import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Menu, X, User, Home, Compass, History, Bell, Shuffle, Settings, LogOut, LogIn, Bookmark, Trophy, LifeBuoy, Heart } from 'lucide-react';
import { useUserStore } from '@/store/userStore';
import { mangaApi } from '@/lib/api';
import { adaptMangaItem } from '@/lib/adapters';
import { Manga } from '@/types/manga';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { getMangaDetailPath } from '@/lib/mangaLinks';
import BrandLogo from '@/components/manga/BrandLogo';

const MAX_SUGGESTIONS = 6;
const MAX_SUGGESTION_CACHE = 60;

const normalizeSearchKey = (value: string) => String(value || '').trim().toLowerCase();

const dedupeMangaSuggestions = (items: Manga[]): Manga[] => {
  const seen = new Set<string>();
  const deduped: Manga[] = [];
  for (const item of items) {
    const key = String(item?.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
};

function compactAuthorText(author: string): string {
  const parts = String(author || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')}...`;
}

function chapterBadgeText(manga: Manga): string {
  const latest = manga.chapters[manga.chapters.length - 1];
  if (!latest) return 'Đang cập nhật';
  // -1 = MangaDex placeholder — show title directly
  if (latest.number === -1) return String(latest.title || 'MangaDex').trim();
  if (Number.isFinite(latest.number) && latest.number >= 0) return `Chương ${latest.number}`;
  const title = String(latest.title || '').trim();
  return title || 'Đang cập nhật';
}

type NavbarProps = {
  maintenanceMode?: boolean;
};

const Navbar = ({ maintenanceMode = false }: NavbarProps) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [suggestions, setSuggestions] = useState<Manga[]>([]);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [loadingRandom, setLoadingRandom] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const searchRequestSeqRef = useRef(0);
  const suggestionCacheRef = useRef<Map<string, Manga[]>>(new Map());
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoggedIn, notifications, markNotificationRead, markAllNotificationsRead, logout } = useUserStore();
  const unreadCount = notifications.filter(n => !n.read).length;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (maintenanceMode) return;
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchQuery(''); setShowSearch(false); setSuggestions([]);
    }
  };

  useEffect(() => {
    if (maintenanceMode) {
      setSuggestions([]);
      return;
    }
    const keyword = searchQuery.trim();
    const normalizedKeyword = normalizeSearchKey(keyword);
    if (keyword.length > 1) {
      const requestSeq = searchRequestSeqRef.current + 1;
      searchRequestSeqRef.current = requestSeq;

      const cachedExact = suggestionCacheRef.current.get(normalizedKeyword);
      if (cachedExact?.length) {
        setSuggestions(cachedExact.slice(0, MAX_SUGGESTIONS));
      } else {
        let bestPrefixItems: Manga[] = [];
        let bestPrefixLen = 0;
        for (const [cacheKey, cacheItems] of suggestionCacheRef.current.entries()) {
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
            setSuggestions(quickFromPrefix.slice(0, MAX_SUGGESTIONS));
          }
        }
      }

      const timer = setTimeout(async () => {
        const updateCache = (key: string, items: Manga[]) => {
          const map = suggestionCacheRef.current;
          map.set(key, items.slice(0, 12));
          if (map.size > MAX_SUGGESTION_CACHE) {
            const oldestKey = map.keys().next().value;
            if (oldestKey) map.delete(oldestKey);
          }
        };

        const mapItems = (payload: any): Manga[] =>
          dedupeMangaSuggestions(((payload?.data?.items || []) as any[]).map(adaptMangaItem));

        let quickItems: Manga[] = [];
        try {
          const quickPayload = await mangaApi.search(keyword, 1, {
            includeMangaDex: false,
            attachRatings: false,
            skipAuth: true,
            timeoutMs: 1800,
          });
          quickItems = mapItems(quickPayload);

          if (requestSeq === searchRequestSeqRef.current) {
            if (quickItems.length > 0) {
              setSuggestions(quickItems.slice(0, MAX_SUGGESTIONS));
            }
            updateCache(normalizedKeyword, quickItems);
          }
        } catch {
          // best effort
        }

        try {
          const enrichedPayload = await mangaApi.search(keyword, 1, {
            includeMangaDex: true,
            attachRatings: false,
            mangaDexLimit: 8,
            mangaDexTimeoutMs: 2600,
            skipAuth: true,
            timeoutMs: 3600,
          });
          const enrichedItems = mapItems(enrichedPayload);
          const mergedItems = dedupeMangaSuggestions([...enrichedItems, ...quickItems]);

          if (requestSeq === searchRequestSeqRef.current) {
            if (mergedItems.length > 0) {
              setSuggestions(mergedItems.slice(0, MAX_SUGGESTIONS));
            } else if (!quickItems.length) {
              setSuggestions([]);
            }
            updateCache(normalizedKeyword, mergedItems.length ? mergedItems : quickItems);
          }
        } catch {
          if (requestSeq === searchRequestSeqRef.current && !quickItems.length) {
            setSuggestions([]);
          }
        }
      }, 90);
      return () => {
        clearTimeout(timer);
      };
    }
    searchRequestSeqRef.current += 1;
    setSuggestions([]);
  }, [searchQuery, maintenanceMode]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSuggestions([]);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotifications(false);
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setShowProfileMenu(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  useEffect(() => { setIsMenuOpen(false); setShowProfileMenu(false); setShowNotifications(false); }, [location.pathname]);

  const handleRandom = async () => {
    if (maintenanceMode) return;
    if (loadingRandom) return;
    setLoadingRandom(true);
    try {
      const data = await mangaApi.getRandom();
      const previewManga = data?.item ? adaptMangaItem(data.item) : null;
      const identifier = previewManga?.id || data?.id || data?.item?._id || data?.item?.id || data?.slug;
      if (identifier) {
        navigate(getMangaDetailPath(identifier, previewManga?.source || data.source), {
          state: previewManga ? { previewManga } : undefined,
        });
      }
    } catch { /* ignore */ }
    finally { setLoadingRandom(false); }
  };

  const navLinks = [
    { to: '/', label: 'Trang chủ', icon: Home },
    { to: '/manga', label: 'Khám phá', icon: Compass },
    { to: '/rankings', label: 'Bảng xếp hạng', icon: Trophy },
  ];

  const profileLinks = [
    { to: '/profile', label: 'Trang cá nhân', icon: User },
    { to: '/bookmarks', label: 'Đã lưu', icon: Bookmark },
    { to: '/following', label: 'Đang theo dõi', icon: Heart },
    { to: '/history', label: 'Lịch sử', icon: History },
    { to: '/settings', label: 'Cài đặt', icon: Settings },
    { to: '/support', label: 'Hỗ trợ', icon: LifeBuoy },
  ];

  const isActive = (path: string) => location.pathname === path;

  if (maintenanceMode) {
    return (
      <nav className="sticky top-0 z-50 h-14 border-b border-border bg-card">
        <div className="container mx-auto h-full px-4">
          <div className="flex h-full items-center justify-between gap-3">
            <BrandLogo />
            {isLoggedIn ? (
              <button
                type="button"
                onClick={() => {
                  logout();
                  setShowProfileMenu(false);
                  navigate("/login", { replace: true });
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
                {"\u0110\u0103ng xu\u1ea5t"}
              </button>
            ) : (
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <LogIn className="h-4 w-4" />
                {"\u0110\u0103ng nh\u1eadp"}
              </Link>
            )}
          </div>
        </div>
      </nav>
    );
  }

  return (
    <nav className="sticky top-0 z-50 bg-card border-b border-border h-14">
      <div className="container mx-auto px-4 h-full">
        <div className="flex items-center justify-between h-full gap-3">
          {/* Logo */}
          <BrandLogo />

          {/* Nav links */}
          <div className="hidden lg:flex items-center gap-1">
            {navLinks.map(link => (
              <Link key={link.to} to={link.to}
                className={`px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  isActive(link.to) ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}>
                {link.label}
              </Link>
            ))}
            <button onClick={handleRandom} disabled={loadingRandom}
              className="flex items-center gap-1 px-3.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              <Shuffle className="w-3.5 h-3.5" /> {loadingRandom ? 'Đang chọn...' : 'Ngẫu nhiên'}
            </button>
          </div>

          {/* Search */}
          <div ref={searchRef} className="hidden sm:block flex-1 max-w-sm mx-4 relative">
            <form onSubmit={handleSearch}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Tìm truyện, tác giả..."
                  className="w-full pl-9 pr-4 py-1.5 rounded-lg bg-muted border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all" />
              </div>
            </form>
            <AnimatePresence>
              {suggestions.length > 0 && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className="absolute top-full left-0 right-0 mt-1.5 bg-card rounded-lg border border-border p-1 shadow-elevated z-50">
                  {suggestions.map(m => (
                    <Link key={m.id} to={getMangaDetailPath(m.id)} onClick={() => { setSearchQuery(''); setSuggestions([]); }}
                      className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted transition-colors">
                      <OptimizedImage src={m.cover} alt="" className="w-8 h-11 rounded object-cover border border-border" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold line-clamp-1">{m.title}</p>
                        <p className="text-[10px] text-muted-foreground line-clamp-1">{compactAuthorText(m.author)} · {chapterBadgeText(m)}</p>
                      </div>
                    </Link>
                  ))}
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const q = searchQuery.trim();
                      if (!q) return;
                      setSearchQuery('');
                      setSuggestions([]);
                      navigate(`/search?q=${encodeURIComponent(q)}`);
                    }}
                    className="block w-full text-center text-xs text-primary font-semibold py-2 rounded-md hover:bg-primary/5 transition-colors"
                  >
                    Xem tất cả kết quả →
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-1">
            <button className="sm:hidden p-2 hover:bg-muted rounded-lg transition-colors" onClick={() => setShowSearch(!showSearch)}>
              <Search className="w-4 h-4 text-muted-foreground" />
            </button>
            {isLoggedIn ? (
              <>
                {/* Notifications */}
                <div ref={notifRef} className="relative">
                  <button onClick={() => setShowNotifications(!showNotifications)} className="p-2 hover:bg-muted rounded-lg transition-colors relative">
                    <Bell className="w-4 h-4 text-muted-foreground" />
                    {unreadCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary text-[9px] font-bold flex items-center justify-center text-primary-foreground">
                        {unreadCount}
                      </span>
                    )}
                  </button>
                  <AnimatePresence>
                    {showNotifications && (
                      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                        className="fixed sm:absolute inset-x-3 sm:inset-x-auto top-14 sm:top-full sm:right-0 sm:mt-2 sm:w-80 bg-card rounded-lg border border-border shadow-elevated z-50 overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                          <p className="text-sm font-bold">Thông báo</p>
                          {unreadCount > 0 && <button onClick={markAllNotificationsRead} className="text-[10px] text-primary font-semibold hover:underline">Đã đọc hết</button>}
                        </div>
                        <div className="max-h-80 overflow-y-auto">
                          {notifications.length > 0 ? notifications.map(n => (
                            <button key={n.id} onClick={() => { markNotificationRead(n.id); if (n.chapterId) navigate(`/chapter/${n.chapterId}`); else if (n.mangaId) navigate(getMangaDetailPath(n.mangaId)); setShowNotifications(false); }}
                              className={`w-full text-left px-4 py-3 border-b border-border/50 last:border-0 hover:bg-muted transition-colors ${!n.read ? 'bg-primary/3' : ''}`}>
                              <p className="text-xs font-bold">{n.title}</p>
                              <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{n.message}</p>
                              <p className="text-[10px] text-muted-foreground mt-1">{timeAgoVi(n.createdAt)}</p>
                            </button>
                          )) : <div className="px-4 py-8 text-center text-muted-foreground text-sm">Không có thông báo</div>}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {/* Profile dropdown */}
                <div ref={profileRef} className="relative">
                  <button onClick={() => setShowProfileMenu(!showProfileMenu)} className="p-2 hover:bg-muted rounded-lg transition-colors">
                    <User className="w-4 h-4 text-muted-foreground" />
                  </button>
                  <AnimatePresence>
                    {showProfileMenu && (
                      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                        className="absolute top-full right-0 mt-2 w-48 bg-card rounded-lg border border-border p-1 shadow-elevated z-50">
                        {profileLinks.map(link => (
                          <Link key={link.to} to={link.to}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                              isActive(link.to) ? 'text-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                            }`}>
                            <link.icon className="w-4 h-4" />{link.label}
                          </Link>
                        ))}
                        <div className="border-t border-border my-1" />
                        <button onClick={() => { logout(); setShowProfileMenu(false); }} className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors w-full">
                          <LogOut className="w-4 h-4" /> Đăng xuất
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </>
            ) : (
              <Link to="/login" className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                Đăng nhập
              </Link>
            )}
            <button className="lg:hidden p-2 hover:bg-muted rounded-lg transition-colors" onClick={() => setIsMenuOpen(!isMenuOpen)}>
              {isMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile search */}
      <AnimatePresence>
        {showSearch && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="sm:hidden border-t border-border bg-card">
            <form onSubmit={handleSearch} className="p-3">
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Tìm truyện..."
                className="w-full px-4 py-2 rounded-lg bg-muted border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20" autoFocus />
            </form>
            {suggestions.length > 0 && (
              <div className="border-t border-border max-h-72 overflow-y-auto">
                {suggestions.map(m => (
                  <Link key={m.id} to={getMangaDetailPath(m.id)} onClick={() => { setSearchQuery(''); setSuggestions([]); setShowSearch(false); }}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted transition-colors">
                    <OptimizedImage src={m.cover} alt="" className="w-8 h-11 rounded object-cover border border-border" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold line-clamp-1">{m.title}</p>
                      <p className="text-[10px] text-muted-foreground line-clamp-1">{compactAuthorText(m.author)} · {chapterBadgeText(m)}</p>
                    </div>
                  </Link>
                ))}
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const q = searchQuery.trim();
                    if (!q) return;
                    setSearchQuery('');
                    setSuggestions([]);
                    setShowSearch(false);
                    navigate(`/search?q=${encodeURIComponent(q)}`);
                  }}
                  className="block w-full text-center text-xs text-primary font-semibold py-2.5 hover:bg-primary/5 transition-colors border-t border-border"
                >
                  Xem tất cả kết quả →
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile menu */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="lg:hidden border-t border-border overflow-hidden bg-card">
            <div className="container mx-auto px-4 py-2 space-y-0.5">
              {navLinks.map(link => (
                <Link key={link.to} to={link.to}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive(link.to) ? 'text-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                  <link.icon className="w-4 h-4" />{link.label}
                </Link>
              ))}
              <button onClick={handleRandom} disabled={loadingRandom} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors w-full disabled:opacity-60 disabled:cursor-not-allowed">
                <Shuffle className="w-4 h-4" /> {loadingRandom ? 'Đang chọn...' : 'Ngẫu nhiên'}
              </button>
              <div className="border-t border-border my-1" />
              {profileLinks.map(link => (
                <Link key={link.to} to={link.to}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive(link.to) ? 'text-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                  <link.icon className="w-4 h-4" />{link.label}
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
};

function timeAgoVi(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

export default Navbar;
