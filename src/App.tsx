import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { Component, useEffect, lazy, Suspense, useState, type ErrorInfo, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { Clock3, Loader2, Lock, LogIn, RefreshCw, Settings } from "lucide-react";
import Navbar from "./components/manga/Navbar";
import Footer from "./components/manga/Footer";
import ProtectedRoute from "./components/ProtectedRoute";
import GuestRoute from "./components/GuestRoute";
import { useUserStore } from "./store/userStore";
import { useSettingsStore } from "./store/settingsStore";
import { authApi, clearBanLock, FORCE_FORBIDDEN_EVENT, FORCE_LOGOUT_EVENT, FORCE_MAINTENANCE_EVENT, getAccessToken, hasBanLock, systemApi } from "./lib/api";
import type { MaintenanceState } from "./lib/api";

// ─── Lazy-loaded pages (code-split per route) ───
const Index = lazy(() => import("./pages/Index"));
const BrowseManga = lazy(() => import("./pages/BrowseManga"));
const MangaDetail = lazy(() => import("./pages/MangaDetail"));
const ChapterReader = lazy(() => import("./pages/ChapterReader"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const Profile = lazy(() => import("./pages/Profile"));
const PublicProfilePage = lazy(() => import("./pages/PublicProfilePage"));
const BookmarksPage = lazy(() => import("./pages/BookmarksPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const UploadDashboard = lazy(() => import("./pages/UploadDashboard"));
const UploadChapter = lazy(() => import("./pages/UploadChapter"));
const UploadTranslationStudio = lazy(() => import("./pages/UploadTranslationStudio"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));
const AdminChapterReview = lazy(() => import("./pages/AdminChapterReview"));
const RankingsPage = lazy(() => import("./pages/RankingsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const SupportPage = lazy(() => import("./pages/SupportPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const DisclaimerPage = lazy(() => import("./pages/DisclaimerPage"));
const AuthCallbackPage = lazy(() => import("./pages/AuthCallbackPage"));
const FollowingPage = lazy(() => import("./pages/FollowingPage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const FaqPage = lazy(() => import("./pages/FaqPage"));
const BannedPage = lazy(() => import("./pages/BannedPage"));
const ForbiddenPage = lazy(() => import("./pages/ForbiddenPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      gcTime: 8 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    },
  },
});

const PageLoader = () => {
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowRecovery(true), 10_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      {showRecovery ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">Trang đang tải lâu hơn bình thường.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" />
            Tải lại trang
          </button>
        </div>
      ) : null}
    </div>
  );
};

type RouteErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
};

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Route render failed", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <p className="text-base font-bold text-foreground">Không thể tải trang này.</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Có thể phiên bản frontend vừa được cập nhật hoặc trình duyệt đang giữ cache cũ.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" />
            Tải lại trang
          </button>
        </div>
      </div>
    );
  }
}

const cleanMaintenanceText = (value: string | undefined, fallback: string) => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/[ÃÂÄÅÆÐ]/.test(text)) return fallback;
  return text;
};

const MaintenanceLock = ({ maintenance }: { maintenance: MaintenanceState }) => {
  const title = cleanMaintenanceText(maintenance.title, "Website đang bảo trì");
  const message = cleanMaintenanceText(
    maintenance.message,
    "MangaHub đang bảo trì hệ thống. Vui lòng quay lại sau ít phút.",
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg rounded-2xl border border-yellow-500/30 bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-yellow-500/30 bg-yellow-500/10">
          <Settings className="h-7 w-7 text-yellow-300" />
        </div>
        <h1 className="text-2xl font-black">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs font-bold text-yellow-200">
          <Lock className="h-3.5 w-3.5" />
          Chế độ bảo trì đang bật
        </div>
      </div>
    </div>
  );
};

const DEFAULT_MAINTENANCE_TITLE = "Website \u0111ang b\u1ea3o tr\u00ec";
const DEFAULT_MAINTENANCE_MESSAGE =
  "MangaHub \u0111ang b\u1ea3o tr\u00ec h\u1ec7 th\u1ed1ng. Vui l\u00f2ng quay l\u1ea1i sau \u00edt ph\u00fat.";

const cleanMaintenanceDisplayText = (value: string | null | undefined, fallback: string) => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/[ÃÂÄÅÆÐ�]/.test(text)) return fallback;
  return text;
};

const safeMaintenanceImage = (value: string | null | undefined) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://") || raw.startsWith("/")) {
    return raw;
  }
  return "";
};

const formatMaintenanceDate = (value: string | null | undefined) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const getMaintenanceTime = (value: string | null | undefined) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { raw, time: null as number | null, label: raw };
  }
  return {
    raw,
    time: date.getTime(),
    label: new Intl.DateTimeFormat("vi-VN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date),
  };
};

const formatMaintenanceDuration = (start: number | null | undefined, end: number | null | undefined) => {
  if (!Number.isFinite(start || NaN) || !Number.isFinite(end || NaN) || !start || !end || end <= start) {
    return "";
  }
  const totalMinutes = Math.max(1, Math.round((end - start) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    days ? `${days} ngày` : "",
    hours ? `${hours} giờ` : "",
    minutes ? `${minutes} phút` : "",
  ].filter(Boolean);
  return parts.join(" ") || "dưới 1 phút";
};

const formatMaintenanceDurationText = (start: number | null | undefined, end: number | null | undefined) => {
  if (!Number.isFinite(start || NaN) || !Number.isFinite(end || NaN) || !start || !end || end <= start) {
    return "";
  }
  const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    days ? `${days} ng\u00e0y` : "",
    hours ? `${hours} gi\u1edd` : "",
    minutes ? `${minutes} ph\u00fat` : "",
    seconds ? `${seconds} gi\u00e2y` : "",
  ].filter(Boolean);
  return parts.join(" ") || "d\u01b0\u1edbi 1 gi\u00e2y";
};

const getCountdownParts = (value: string | null | undefined, now: number) => {
  if (!value) return null;
  const end = new Date(value).getTime();
  if (!Number.isFinite(end)) return null;
  const remainingSeconds = Math.floor((end - now) / 1000);
  const totalSeconds = Math.max(0, remainingSeconds);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    done: remainingSeconds <= 0,
  };
};

const MaintenancePage = ({ maintenance }: { maintenance: MaintenanceState }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const title = cleanMaintenanceDisplayText(maintenance.title, DEFAULT_MAINTENANCE_TITLE);
  const message = cleanMaintenanceDisplayText(maintenance.message, DEFAULT_MAINTENANCE_MESSAGE);
  const imageUrl = safeMaintenanceImage(maintenance.image_url);
  const startTime = getMaintenanceTime(maintenance.starts_at);
  const endTime = getMaintenanceTime(maintenance.ends_at);
  const startsAt = startTime?.label || "";
  const endsAt = endTime?.label || "";
  const duration = formatMaintenanceDurationText(startTime?.time, endTime?.time);
  const isBeforeMaintenanceStart =
    typeof startTime?.time === "number" && Number.isFinite(startTime.time) && now < startTime.time;
  const countdownTarget = isBeforeMaintenanceStart ? maintenance.starts_at : maintenance.ends_at;
  const countdown = getCountdownParts(countdownTarget, now);
  const countdownTitle = isBeforeMaintenanceStart
    ? "Bảo trì bắt đầu sau"
    : "Dự kiến mở lại sau";
  const progressPercent =
    typeof startTime?.time === "number" &&
    typeof endTime?.time === "number" &&
    Number.isFinite(startTime.time) &&
    Number.isFinite(endTime.time) &&
    endTime.time > startTime.time
      ? Math.max(0, Math.min(100, ((now - startTime.time) / (endTime.time - startTime.time)) * 100))
      : null;
  const countdownItems = countdown
    ? [
        { label: "ng\u00e0y", value: countdown.days },
        { label: "gi\u1edd", value: countdown.hours },
        { label: "ph\u00fat", value: countdown.minutes },
        { label: "gi\u00e2y", value: countdown.seconds },
      ]
    : [];

  return (
    <section className="relative flex min-h-[calc(100vh-3.5rem)] items-center overflow-hidden bg-background px-4 py-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(250,204,21,0.16),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.12),transparent_34%)]" />
      <div className="container relative mx-auto grid items-center gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="order-2 space-y-5 lg:order-1">
          <div className="inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-yellow-200">
            <Lock className="h-3.5 w-3.5" />
            {"Ch\u1ebf \u0111\u1ed9 b\u1ea3o tr\u00ec \u0111ang b\u1eadt"}
          </div>
          <div className="space-y-3">
            <h1 className="max-w-3xl text-3xl font-black leading-tight md:text-5xl">{title}</h1>
            <p className="max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">{message}</p>
          </div>

          {(startsAt || endsAt) && (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              {startsAt && (
                <div className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                    <Clock3 className="h-4 w-4 text-primary" />
                    {"B\u1eaft \u0111\u1ea7u"}
                  </div>
                  <p className="mt-1 text-sm font-bold">{startsAt}</p>
                </div>
              )}
              {endsAt && (
                <div className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                    <Clock3 className="h-4 w-4 text-primary" />
                    {"D\u1ef1 ki\u1ebfn m\u1edf l\u1ea1i"}
                  </div>
                  <p className="mt-1 text-sm font-bold">{endsAt}</p>
                </div>
              )}
            </div>
          )}

          {countdown && !countdown.done && (
            <div className="max-w-xl space-y-2">
              <div className="text-xs font-black uppercase tracking-wide text-yellow-200">
                {countdownTitle}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {countdownItems.map((item) => (
                  <div key={item.label} className="rounded-xl border border-yellow-500/25 bg-yellow-500/10 p-3 text-center">
                    <div className="text-2xl font-black tabular-nums text-yellow-100">
                      {String(item.value).padStart(2, "0")}
                    </div>
                    <div className="mt-1 text-[11px] font-bold uppercase text-yellow-200/80">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="max-w-2xl rounded-xl border border-border bg-card/70 p-4">
            <div className="flex items-center gap-2 text-xs font-black uppercase text-muted-foreground">
              <Clock3 className="h-4 w-4 text-yellow-300" />
              {"Tr\u1ea1ng th\u00e1i th\u1eddi gian"}
            </div>
            <div className="mt-2 space-y-1 text-sm leading-6">
              {duration ? (
                <p className="font-semibold">
                  {"Th\u1eddi gian b\u1ea3o tr\u00ec d\u1ef1 ki\u1ebfn: "}
                  <span className="text-yellow-100">{duration}</span>
                </p>
              ) : null}
              {progressPercent !== null ? (
                <div className="space-y-1.5 py-1">
                  <div className="flex items-center justify-between text-xs font-bold text-muted-foreground">
                    <span>{"Ti\u1ebfn \u0111\u1ed9 theo l\u1ecbch"}</span>
                    <span>{Math.round(progressPercent)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-yellow-400 transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {countdown && !countdown.done ? (
                <p className="font-semibold text-yellow-100">
                  {isBeforeMaintenanceStart
                    ? "Đang đếm ngược đến thời gian bắt đầu bảo trì."
                    : "Đang đếm ngược đến thời gian mở lại."}
                </p>
              ) : endTime?.raw && !endTime.time ? (
                <p className="font-semibold text-amber-200">
                  {"M\u1ed1c m\u1edf l\u1ea1i ch\u01b0a \u0111\u00fang \u0111\u1ecbnh d\u1ea1ng: "}
                  <span className="break-all">{endTime.raw}</span>
                </p>
              ) : endTime?.time ? (
                <p className="font-semibold text-amber-200">
                  {"\u0110\u00e3 qu\u00e1 m\u1ed1c d\u1ef1 ki\u1ebfn m\u1edf l\u1ea1i, vui l\u00f2ng ch\u1edd th\u00f4ng b\u00e1o m\u1edbi."}
                </p>
              ) : (
                <p className="font-semibold text-muted-foreground">
                  {"Admin ch\u01b0a \u0111\u1eb7t th\u1eddi gian m\u1edf l\u1ea1i."}
                </p>
              )}
              {!startTime?.time && !endTime?.time ? (
                <p className="text-xs text-muted-foreground">
                  {"Trang s\u1ebd t\u1ef1 c\u1eadp nh\u1eadt khi admin b\u1ed5 sung l\u1ecbch b\u1ea3o tr\u00ec."}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <LogIn className="h-4 w-4" />
              {"\u0110\u0103ng nh\u1eadp admin"}
            </Link>
            <span className="text-xs font-semibold text-muted-foreground">
              {"Ch\u1ec9 t\u00e0i kho\u1ea3n admin c\u00f3 th\u1ec3 truy c\u1eadp trong th\u1eddi gian b\u1ea3o tr\u00ec."}
            </span>
          </div>
        </div>

        <div className="order-1 lg:order-2">
          <div className="relative mx-auto aspect-[4/3] max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            {imageUrl ? (
              <img src={imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 via-slate-800 to-stone-900">
                <div className="text-center">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl border border-yellow-500/30 bg-yellow-500/10">
                    <Settings className="h-10 w-10 text-yellow-300" />
                  </div>
                  <p className="mt-4 text-sm font-bold text-white/80">MangaHub</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

const ScrollToTop = () => {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
};

const AuthLoader = ({ maintenanceLocked = false }: { maintenanceLocked?: boolean } = {}) => {
  const loadUser = useUserStore(s => s.loadUser);
  const loadSettings = useSettingsStore(s => s.loadSettings);
  const logout = useUserStore(s => s.logout);
  const fetchNotifications = useUserStore(s => s.fetchNotifications);
  const isLoggedIn = useUserStore(s => s.isLoggedIn);
  const user = useUserStore(s => s.user);
  const hasCheckedSession = useUserStore(s => s.hasCheckedSession);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!hasCheckedSession) {
      loadUser();
    }
  }, [hasCheckedSession, loadUser]);

  useEffect(() => {
    if (hasCheckedSession && isLoggedIn && !user) {
      loadUser();
    }
  }, [hasCheckedSession, isLoggedIn, user, loadUser]);

  useEffect(() => {
    if (!maintenanceLocked && isLoggedIn && user) {
      loadSettings();
    }
  }, [isLoggedIn, user?.id, loadSettings, maintenanceLocked]);

  useEffect(() => {
    const handleForceLogout = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === 'banned') {
        navigate('/banned', { replace: true });
        return;
      }
      logout();
      navigate('/login', { replace: true });
    };
    window.addEventListener(FORCE_LOGOUT_EVENT, handleForceLogout);
    return () => window.removeEventListener(FORCE_LOGOUT_EVENT, handleForceLogout);
  }, [logout, navigate]);

  useEffect(() => {
    const handleForceForbidden = (_e: Event) => {
      navigate('/forbidden', { replace: true });
    };
    window.addEventListener(FORCE_FORBIDDEN_EVENT, handleForceForbidden);
    return () => window.removeEventListener(FORCE_FORBIDDEN_EVENT, handleForceForbidden);
  }, [navigate]);

  useEffect(() => {
    if (maintenanceLocked || !isLoggedIn) return;
    let isChecking = false;
    const checkBanStatus = () => {
      if (isChecking || !getAccessToken() || document.hidden) return;
      isChecking = true;
      authApi.ping().then(() => {
        if (hasBanLock()) {
          clearBanLock();
          loadUser();
          if (location.pathname === '/banned') {
            navigate('/', { replace: true });
          }
        }
      }).catch(() => {}).finally(() => {
        isChecking = false;
      });
    };
    checkBanStatus();
    const timer = window.setInterval(checkBanStatus, 60000);
    window.addEventListener('focus', checkBanStatus);
    document.addEventListener('visibilitychange', checkBanStatus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', checkBanStatus);
      document.removeEventListener('visibilitychange', checkBanStatus);
    };
  }, [isLoggedIn, loadUser, location.pathname, navigate, maintenanceLocked]);

  useEffect(() => {
    if (maintenanceLocked || !isLoggedIn) return;
    let isFetching = false;
    const syncNotifications = () => {
      if (isFetching || document.hidden) return;
      isFetching = true;
      fetchNotifications().finally(() => {
        isFetching = false;
      });
    };
    syncNotifications();
    const timer = window.setInterval(syncNotifications, 30000);
    window.addEventListener('focus', syncNotifications);
    document.addEventListener('visibilitychange', syncNotifications);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', syncNotifications);
      document.removeEventListener('visibilitychange', syncNotifications);
    };
  }, [isLoggedIn, fetchNotifications, maintenanceLocked]);

  return null;
};

const isOAuthPayloadOnRoot = (location: ReturnType<typeof useLocation>) => {
  if (location.pathname !== "/") return false;
  const params = new URLSearchParams(location.search);
  return (
    params.has("code") ||
    params.has("error") ||
    location.hash.includes("access_token=") ||
    location.hash.includes("refresh_token=")
  );
};

const AppContent = () => {
  const location = useLocation();
  const user = useUserStore(s => s.user);
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [maintenanceChecked, setMaintenanceChecked] = useState(false);
  const lockedByBan = hasBanLock();
  const allowWhenLocked = ['/banned', '/forbidden', '/login', '/register', '/forgot-password', '/auth/callback', '/support'];

  useEffect(() => {
    let cancelled = false;
    const loadMaintenance = () => {
      systemApi.getMaintenance()
        .then((data) => {
          if (cancelled) return;
          const next = data?.maintenance || data;
          setMaintenance(next?.enabled ? next : null);
        })
        .catch(() => {
          if (!cancelled) setMaintenance(null);
        })
        .finally(() => {
          if (!cancelled) setMaintenanceChecked(true);
        });
    };
    loadMaintenance();
    const timer = window.setInterval(loadMaintenance, 30000);
    window.addEventListener("focus", loadMaintenance);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", loadMaintenance);
    };
  }, []);

  useEffect(() => {
    const handleMaintenance = (event: Event) => {
      const next = (event as CustomEvent<MaintenanceState>).detail;
      setMaintenance(next?.enabled ? next : null);
      setMaintenanceChecked(true);
    };
    window.addEventListener(FORCE_MAINTENANCE_EVENT, handleMaintenance);
    return () => window.removeEventListener(FORCE_MAINTENANCE_EVENT, handleMaintenance);
  }, []);

  if (user?.isBanned && location.pathname !== '/banned') {
    return <Navigate to="/banned" replace />;
  }
  if (isOAuthPayloadOnRoot(location)) {
    return <Navigate to={`/auth/callback${location.search}${location.hash}`} replace />;
  }
  if (lockedByBan && !allowWhenLocked.includes(location.pathname)) {
    return <Navigate to="/banned" replace />;
  }
  if (!maintenanceChecked) {
    return (
      <div className="min-h-screen bg-background">
        <ScrollToTop />
        <AuthLoader />
        <PageLoader />
      </div>
    );
  }
  const isAdmin = user?.role === "admin";
  const allowMaintenanceAuthPath = ["/login", "/auth/callback"].includes(location.pathname);
  const showMaintenanceLock =
    maintenance?.enabled && !isAdmin && !allowMaintenanceAuthPath;
  if (showMaintenanceLock) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <ScrollToTop />
        <AuthLoader maintenanceLocked />
        <Navbar maintenanceMode />
        <main className="flex-1">
          <MaintenancePage maintenance={maintenance!} />
        </main>
      </div>
    );
  }
  const isReader = location.pathname.startsWith('/chapter/');
  const isAdminReview = location.pathname.startsWith('/admin/review/');
  const isBanned = location.pathname === '/banned';
  const isForbidden = location.pathname === '/forbidden';
  const isAuthCallback = location.pathname === '/auth/callback';
  const hideChrome = isReader || isAuthCallback || isAdminReview || isBanned || isForbidden;
  const maintenanceChrome = Boolean(maintenance?.enabled && !isAdmin);

  return (
    <div className="flex flex-col min-h-screen">
      <ScrollToTop />
      <AuthLoader maintenanceLocked={Boolean(maintenance?.enabled && !isAdmin)} />
      {!hideChrome && <Navbar maintenanceMode={maintenanceChrome} />}
      <main className="flex-1">
        <RouteErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageLoader />}>
            <AnimatePresence mode="wait">
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<Index />} />
                <Route path="/manga" element={<BrowseManga />} />
                <Route path="/manga/:source/:id" element={<MangaDetail />} />
                <Route path="/manga/:id" element={<MangaDetail />} />
                <Route path="/chapter/:id" element={<ChapterReader />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/profile/:userId" element={<PublicProfilePage />} />
                <Route path="/u/:userId" element={<PublicProfilePage />} />
                <Route path="/bookmarks" element={<ProtectedRoute><BookmarksPage /></ProtectedRoute>} />
                <Route path="/history" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
                <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
                <Route path="/upload" element={<ProtectedRoute allowedRoles={['uploader','moderator','admin']}><UploadDashboard /></ProtectedRoute>} />
                <Route path="/upload/new" element={<ProtectedRoute allowedRoles={['uploader','moderator','admin']}><UploadChapter /></ProtectedRoute>} />
                <Route path="/upload/editor" element={<ProtectedRoute allowedRoles={['uploader','moderator','admin']}><UploadTranslationStudio /></ProtectedRoute>} />
                <Route path="/admin" element={<ProtectedRoute allowedRoles={['moderator','admin']}><AdminPanel /></ProtectedRoute>} />
                <Route path="/admin/review/:id" element={<ProtectedRoute allowedRoles={['moderator','admin']}><AdminChapterReview /></ProtectedRoute>} />
                <Route path="/rankings" element={<RankingsPage />} />
                <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
                <Route path="/register" element={<GuestRoute><RegisterPage /></GuestRoute>} />
                <Route path="/forgot-password" element={<GuestRoute><ForgotPasswordPage /></GuestRoute>} />
                <Route path="/auth/callback" element={<AuthCallbackPage />} />
                <Route path="/support" element={<SupportPage />} />
                <Route path="/contact" element={<ContactPage />} />
                <Route path="/following" element={<ProtectedRoute><FollowingPage /></ProtectedRoute>} />
                <Route path="/report" element={<ProtectedRoute><ReportPage /></ProtectedRoute>} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/faq" element={<FaqPage />} />
                <Route path="/disclaimer" element={<DisclaimerPage />} />
                <Route path="/banned" element={<BannedPage />} />
                <Route path="/forbidden" element={<ForbiddenPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AnimatePresence>
          </Suspense>
        </RouteErrorBoundary>
      </main>
      {!hideChrome && !maintenanceChrome && <Footer />}
    </div>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
