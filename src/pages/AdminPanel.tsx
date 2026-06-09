import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { adminApi, emitHomepageRefresh } from "@/lib/api";
import { useUserStore } from "@/store/userStore";
import OptimizedImage from "@/components/ui/OptimizedImage";
import { Switch } from "@/components/ui/switch";
import MaintenanceImageEditorModal, {
  MaintenanceImageCropArea,
} from "@/components/admin/MaintenanceImageEditorModal";
import { useIsMobile } from "@/hooks/use-mobile";
import { getMangaDetailPath } from "@/lib/mangaLinks";
import {
  Shield,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  Users,
  BookOpen,
  AlertTriangle,
  Search,
  BarChart3,
  Settings,
  Lock,
  Bell,
  Trash2,
  Edit,
  Ban,
  UserCheck,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  Activity,
  FileText,
  Download,
  MessageSquare,
  Flag,
  Layers,
  Globe,
  Upload,
  Star,
  ArrowUpDown,
  RefreshCw,
  Zap,
  Monitor,
  Smartphone,
  X,
  Check,
  UserPlus,
  EyeOff,
  ExternalLink,
  PinIcon,
  StickyNote,
} from "lucide-react";

type AdminTab =
  | "overview"
  | "users"
  | "manga"
  | "manga_approval"
  | "chapters"
  | "reports"
  | "comments"
  | "announcements"
  | "analytics"
  | "settings"
  | "security";

const normalizePermissionText = (value: unknown): string =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return "";
};

const isPermissionDeniedError = (error: unknown): boolean => {
  const message = normalizePermissionText(getErrorMessage(error));
  if (!message) return false;
  return (
    message.includes("forbidden") ||
    message.includes("permission denied") ||
    message.includes("khong co quyen") ||
    message.includes("yeu cau quyen") ||
    message.includes("truy cap bi tu choi")
  );
};

const TABS: { key: AdminTab; label: string; icon: any }[] = [
  { key: "overview", label: "Tổng quan", icon: BarChart3 },
  { key: "users", label: "Người dùng", icon: Users },
  { key: "manga", label: "Truyện", icon: BookOpen },
  { key: "manga_approval", label: "Duyệt truyện", icon: CheckCircle },
  { key: "chapters", label: "Chapters", icon: Layers },

  { key: "reports", label: "Báo cáo", icon: Flag },
  { key: "comments", label: "Bình luận", icon: MessageSquare },
  { key: "announcements", label: "Thông báo", icon: Bell },
  { key: "analytics", label: "Thống kê", icon: TrendingUp },
  { key: "settings", label: "Cài đặt", icon: Settings },
  { key: "security", label: "Bảo mật", icon: Lock },
];

type AnnouncementFormState = {
  title: string;
  message: string;
  announcement_type: string;
  show_popup: boolean;
  is_active: boolean;
  image_url: string;
  cta_label: string;
  cta_url: string;
  popup_size: string;
  popup_dismissible: boolean;
  popup_expires_hours: number;
  priority: number;
};

const DEFAULT_ANNOUNCEMENT_FORM: AnnouncementFormState = {
  title: "",
  message: "",
  announcement_type: "system",
  show_popup: true,
  is_active: true,
  image_url: "",
  cta_label: "",
  cta_url: "",
  popup_size: "standard",
  popup_dismissible: true,
  popup_expires_hours: 24,
  priority: 0,
};

const announcementTypeOptions = [
  { value: "system", label: "Hệ thống" },
  { value: "maintenance", label: "Bảo trì" },
  { value: "event", label: "Event" },
  { value: "warning", label: "Cảnh báo" },
];

const announcementStatusOptions = [
  { value: "all", label: "Tất cả" },
  { value: "active", label: "Đang hiện" },
  { value: "inactive", label: "Đã tắt" },
  { value: "scheduled", label: "Đã hẹn lịch" },
  { value: "expired", label: "Hết hạn" },
];

const PermissionDeniedPanel = ({
  title,
  message,
  onRetry,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
}) => (
  <div className="bg-card border border-border rounded-xl p-6">
    <div className="flex items-start gap-3">
      <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400">
        <Lock className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <h2 className="text-lg font-bold">Không đủ quyền truy cập</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Bạn không có quyền dùng tab {title}. Vui lòng liên hệ admin để được cấp quyền phù hợp.
        </p>
        {message ? (
          <p className="text-xs text-amber-300/90 mt-2 break-words">Chi tiết: {message}</p>
        ) : null}
        {onRetry ? (
          <button
            onClick={onRetry}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Thử lại
          </button>
        ) : null}
      </div>
    </div>
  </div>
);

const violationTypeLabels: Record<string, string> = {
  manga: "Vi phạm truyện",
  chapter: "Vi phạm chapter",
  comment: "Vi phạm bình luận",
  user: "Vi phạm người dùng",
  bug: "Báo lỗi hệ thống",
  account: "Vấn đề tài khoản",
  content: "Vi phạm nội dung",
  missing_pages: "Thiếu trang / Hình lỗi",
  wrong_order: "Sai thứ tự trang",
  wrong_chapter: "Sai chương / Trùng nội dung",
  translation: "Lỗi dịch thuật",
  other: "Khác",
};

// Reusable Components
const StatCard = ({
  icon: Icon,
  label,
  value,
  color,
  trend,
}: {
  icon: any;
  label: string;
  value: string | number;
  color: string;
  trend?: string;
}) => (
  <motion.div
    whileHover={{ y: -2 }}
    className="bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors"
  >
    <div className="flex items-center justify-between mb-2">
      <Icon className={`w-5 h-5 ${color}`} />
      {trend && (
        <span className="text-[10px] font-bold text-green-400 flex items-center gap-0.5">
          <TrendingUp className="w-3 h-3" />
          {trend}
        </span>
      )}
    </div>
    <p className="text-2xl font-bold">{value}</p>
    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
  </motion.div>
);

const ConfirmModal = ({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  destructive,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) => (
  <AnimatePresence>
    {open && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        >
          <h3 className="text-lg font-bold mb-2">{title}</h3>
          <p className="text-sm text-muted-foreground mb-5">{message}</p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-secondary text-sm font-bold hover:bg-secondary/80 transition-colors"
            >
              Hủy
            </button>
            <button
              onClick={onConfirm}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/80" : "bg-primary text-primary-foreground hover:bg-primary/80"}`}
            >
              Xác nhận
            </button>
          </div>
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
);

const PriorityBadge = ({
  priority,
}: {
  priority: "high" | "medium" | "low";
}) => {
  const styles = {
    high: "text-red-400 bg-red-400/10",
    medium: "text-yellow-400 bg-yellow-400/10",
    low: "text-muted-foreground bg-secondary",
  };
  const labels = { high: "Cao", medium: "Trung bình", low: "Thấp" };
  return (
    <span
      className={`text-[10px] font-bold px-2 py-0.5 rounded ${styles[priority]}`}
    >
      {labels[priority]}
    </span>
  );
};

const RoleBadge = ({ role }: { role: string }) => {
  const styles: Record<string, string> = {
    admin: "text-red-400 bg-red-400/10",
    moderator: "text-purple-400 bg-purple-400/10",
    uploader: "text-yellow-400 bg-yellow-400/10",
    reader: "text-muted-foreground bg-secondary",
    owner: "text-red-400 bg-red-400/10",
    member: "text-muted-foreground bg-secondary",
  };
  return (
    <span
      className={`text-[10px] font-bold px-2 py-0.5 rounded capitalize ${styles[role] || styles.reader}`}
    >
      {role}
    </span>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  const styles: Record<string, string> = {
    active: "text-green-400 bg-green-400/10",
    banned: "text-red-400 bg-red-400/10",
    pending: "text-yellow-400 bg-yellow-400/10",
    published: "text-green-400 bg-green-400/10",
    rejected: "text-red-400 bg-red-400/10",
    draft: "text-muted-foreground bg-secondary",
    resolved: "text-green-400 bg-green-400/10",
    ongoing: "text-green-400 bg-green-400/10",
    completed: "text-blue-400 bg-blue-400/10",
    hiatus: "text-yellow-400 bg-yellow-400/10",
  };
  const labels: Record<string, string> = {
    active: "Hoạt động",
    banned: "Đã ban",
    pending: "Chờ duyệt",
    published: "Đã xuất bản",
    rejected: "Từ chối",
    draft: "Nháp",
    resolved: "Đã xử lý",
    ongoing: "Đang ra",
    completed: "Hoàn thành",
    hiatus: "Sắp ra mắt",
  };
  return (
    <span
      className={`text-[10px] font-bold px-2 py-0.5 rounded ${styles[status] || ""}`}
    >
      {labels[status] || status}
    </span>
  );
};

const SimpleBarChart = ({
  data,
  labels,
  maxH = 100,
}: {
  data: number[];
  labels: string[];
  maxH?: number;
}) => {
  const normalizedData = (Array.isArray(data) && data.length > 0 ? data : [0]).map(
    (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
  );
  const max = Math.max(1, ...normalizedData);
  return (
    <div className="flex items-end gap-1.5 h-[120px]">
      {normalizedData.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${v > 0 ? Math.max((v / max) * maxH, 4) : 2}px` }}
            transition={{ delay: i * 0.05, type: "spring" }}
            className="w-full bg-primary/60 rounded-t hover:bg-primary transition-colors cursor-default relative group"
          >
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-card border border-border rounded px-1.5 py-0.5 text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              {v.toLocaleString()}
            </div>
          </motion.div>
          <span className="text-[10px] text-muted-foreground">{labels[i] || ""}</span>
        </div>
      ))}
    </div>
  );
};

const SearchInput = ({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) => (
  <div className="relative flex-1 max-w-sm">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
    />
  </div>
);

const ExpandableText = ({
  text,
  className = "",
}: {
  text?: string;
  className?: string;
}) => {
  const [expanded, setExpanded] = useState(false);
  const value = String(text || "").trim();
  const canToggle = value.length > 220 || value.includes("\n");

  if (!value) {
    return <p className={className}>—</p>;
  }

  return (
    <div>
      <p
        className={`${className} ${!expanded && canToggle ? "line-clamp-4 md:line-clamp-5" : ""}`}
      >
        {value}
      </p>
      {canToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-bold text-primary hover:underline"
        >
          {expanded ? "Thu gọn" : "Hiển thêm"}
        </button>
      )}
    </div>
  );
};

// ── Proper sub-components for user modals (hooks must be at top-level of component) ──

const UserCommentsModalContent = ({
  userId, user, onClose,
}: { userId: string; user: any; onClose: () => void }) => {
  const [userComments, setUserComments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminApi.getUserComments(userId)
      .then((d) => setUserComments(d.comments || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <>
      <div className="p-5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h3 className="font-bold">Bình luận của {user.name}</h3>
            <p className="text-xs text-muted-foreground">{user.comments} bình luận</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4 overflow-y-auto flex-1 space-y-2 min-h-[200px]">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">Đang tải...</div>
        ) : userComments.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">Chưa có bình luận nào.</p>
        ) : userComments.map((c: any) => (
          <div key={c.id} className="p-3 rounded-xl bg-secondary/40 border border-border/50 hover:bg-secondary/60 transition-colors group">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-purple-400">{c.manga_slug}</p>
                <p className="text-sm mt-1">{c.content}</p>
              </div>
              <button className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-[10px] text-muted-foreground">
                {c.created_at ? new Date(c.created_at).toLocaleString("vi") : ""}
              </span>
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <Star className="w-3 h-3" /> {c.likes || 0} likes
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-border flex justify-between items-center">
        <span className="text-[10px] text-muted-foreground">Hiển thị {userComments.length} / {user.comments}</span>
        <button onClick={onClose} className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors">Đóng</button>
      </div>
    </>
  );
};

const UserHistoryModalContent = ({
  userId, user, onClose,
}: { userId: string; user: any; onClose: () => void }) => {
  const [userHistory, setUserHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminApi.getUserHistory(userId)
      .then((d) => setUserHistory(d.history || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <>
      <div className="p-5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
            <FileText className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-bold">Lịch sử đọc</h3>
            <p className="text-xs text-muted-foreground">{user.name} · {user.chaptersRead} chapters</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4 overflow-y-auto flex-1 space-y-2 min-h-[200px]">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">Đang tải...</div>
        ) : userHistory.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">Chưa có lịch sử đọc.</p>
        ) : userHistory.map((h: any) => (
          <div key={h.id} className="p-3 rounded-xl bg-secondary/40 border border-border/50 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-xs font-black shrink-0">
              {Math.round(h.progress || 0)}%
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{h.manga_title || h.manga_slug}</p>
              <p className="text-[10px] text-muted-foreground">
                {h.chapter_name} · {h.read_at ? new Date(h.read_at).toLocaleString("vi") : ""}
              </p>
              <div className="h-1.5 bg-secondary rounded-full mt-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${(h.progress || 0) >= 100 ? "bg-emerald-400" : "bg-primary"}`}
                  style={{ width: `${h.progress || 0}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-border flex justify-between items-center">
        <span className="text-[10px] text-muted-foreground">Gần đây nhất · {userHistory.length} mục</span>
        <button onClick={onClose} className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors">Đóng</button>
      </div>
    </>
  );
};

// ── VIP Plan selector used inside UserCard ───────────────────────────────────
const VIP_PLANS = [
  { value: 1,  label: "1 tháng" },
  { value: 3,  label: "3 tháng" },
  { value: 6,  label: "6 tháng" },
  { value: 12, label: "1 năm" },
];

const VipGrantBox = ({ userId, onGrant }: { userId: string; onGrant: (months: number) => void }) => {
  const [plan, setPlan] = useState(1);
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-secondary border border-border text-xs font-bold">
      <div className="w-8 h-8 rounded-lg bg-yellow-400/10 flex items-center justify-center">
        <Star className="w-4 h-4 text-yellow-400" />
      </div>
      <select
        value={plan}
        onChange={(e) => setPlan(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        className="w-full text-[10px] bg-background border border-border rounded px-1 py-0.5 focus:outline-none"
      >
        {VIP_PLANS.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>
      <button
        onClick={(e) => { e.stopPropagation(); onGrant(plan); }}
        className="w-full text-[10px] py-0.5 rounded bg-yellow-400/20 hover:bg-yellow-400/30 text-yellow-400 transition-colors"
      >
        Cấp VIP
      </button>
    </div>
  );
};

// ===================== MAIN COMPONENT =====================
const AdminPanel = () => {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modal, setModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    destructive?: boolean;
    onConfirm: () => void;
  }>({ open: false, title: "", message: "", onConfirm: () => {} });
  const [banModal, setBanModal] = useState<{
    open: boolean;
    userId: string;
    userName: string;
  }>({ open: false, userId: "", userName: "" });
  const [banReason, setBanReason] = useState("");
  const [banCustomReason, setBanCustomReason] = useState("");
  const [banDuration, setBanDuration] = useState("permanent");

  // User management state
  const [userFilter, setUserFilter] = useState<
    "all" | "active" | "banned" | "admin" | "uploader"
  >("all");
  const [userActions, setUserActions] = useState<Record<string, string>>({});

  // Chapter moderation state
  const [chapterActions, setChapterActions] = useState<
    Record<string, "approve" | "reject">
  >({});
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);

  // Report state
  const [reportFilter, setReportFilter] = useState<
    "all" | "chapter" | "comment" | "manga" | "user"
  >("all");
  const [reportActions, setReportActions] = useState<Record<string, string>>(
    {},
  );

  // Manga approval state
  const [mangaApprovalActions, setMangaApprovalActions] = useState<
    Record<string, "approved" | "rejected">
  >({});

  // --- API data state ---
  const [apiUsers, setApiUsers] = useState<any[]>([]);
  const [apiReports, setApiReports] = useState<any[]>([]);
  const [apiUploads, setApiUploads] = useState<any[]>([]);
  const [apiAuditLog, setApiAuditLog] = useState<any[]>([]);
  const [apiStats, setApiStats] = useState<any>({});
  const [apiAnalytics, setApiAnalytics] = useState<any>({});
  const [tabDeniedMap, setTabDeniedMap] = useState<Partial<Record<AdminTab, string>>>({});

  // Notify modal state
  const [notifyModal, setNotifyModal] = useState(false);
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyMessage, setNotifyMessage] = useState("");
  const [notifyTarget, setNotifyTarget] = useState("all");
  const [notifyKind, setNotifyKind] = useState("system");
  const [notifyShowPopup, setNotifyShowPopup] = useState(false);
  const [notifyPopupHours, setNotifyPopupHours] = useState(24);
  const [notifyImageUrl, setNotifyImageUrl] = useState("");
  const [notifyCtaLabel, setNotifyCtaLabel] = useState("");
  const [notifyCtaUrl, setNotifyCtaUrl] = useState("");
  const [notifyPopupSize, setNotifyPopupSize] = useState("standard");
  const [notifyPopupDismissible, setNotifyPopupDismissible] = useState(true);
  const [notifyPriority, setNotifyPriority] = useState(0);
  const [notifyUploadingImage, setNotifyUploadingImage] = useState(false);
  const [notifySending, setNotifySending] = useState(false);

  const markTabDenied = useCallback((tab: AdminTab, error: unknown) => {
    if (!isPermissionDeniedError(error)) return;
    const message = getErrorMessage(error) || "Không có quyền truy cập";
    setTabDeniedMap((prev) => {
      if (prev[tab] === message) return prev;
      return { ...prev, [tab]: message };
    });
  }, []);

  const clearTabDenied = useCallback((tab: AdminTab) => {
    setTabDeniedMap((prev) => {
      if (!prev[tab]) return prev;
      const next = { ...prev };
      delete next[tab];
      return next;
    });
  }, []);

  const fetchOverviewCoreData = useCallback(async () => {
    let deniedError: unknown = null;

    try {
      const statsData = await adminApi.getStats();
      setApiStats(statsData.stats || {});
    } catch (err) {
      if (isPermissionDeniedError(err) && !deniedError) {
        deniedError = err;
      }
    }

    try {
      const auditData = await adminApi.getAuditLog(1);
      setApiAuditLog(auditData.logs || []);
    } catch (err) {
      if (isPermissionDeniedError(err) && !deniedError) {
        deniedError = err;
      }
    }

    if (deniedError) {
      markTabDenied("overview", deniedError);
      return;
    }

    clearTabDenied("overview");
  }, [clearTabDenied, markTabDenied]);

  // Always load on mount: stats + audit log (needed for overview)
  useEffect(() => {
    void fetchOverviewCoreData();
    // Auto-refresh stats every 2 minutes
    const statsTimer = setInterval(() => {
      void fetchOverviewCoreData();
    }, 2 * 60 * 1000);
    return () => clearInterval(statsTimer);
  }, [fetchOverviewCoreData]);

  // Auto-refresh pending uploads count every 90 seconds for the sidebar badge
  useEffect(() => {
    const fetchUploads = () => {
      adminApi
        .getUploads(1)
        .then((d) => setApiUploads(d.uploads || []))
        .catch(() => {});
    };
    const uploadsTimer = setInterval(fetchUploads, 90 * 1000);
    return () => clearInterval(uploadsTimer);
  }, []);

  // Load lazily based on active tab — only fetch once per tab
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set());

  // Warm analytics in background so overview weekly chart feels faster.
  useEffect(() => {
    if (loadedTabs.has("analytics")) return;
    let cancelled = false;

    adminApi
      .getAnalytics()
      .then((d) => {
        if (cancelled) return;
        clearTabDenied("analytics");
        setApiAnalytics(d.analytics || {});
        setLoadedTabs((prev) => {
          if (prev.has("analytics")) return prev;
          return new Set([...prev, "analytics"]);
        });
      })
      .catch(() => {
        // Ignore warmup failures; tab-driven fetch will retry on demand.
      });

    return () => {
      cancelled = true;
    };
  }, [clearTabDenied, loadedTabs]);

  useEffect(() => {
    if (loadedTabs.has(activeTab)) return;
    setLoadedTabs((prev) => new Set([...prev, activeTab]));

    if (activeTab === "users") {
      adminApi
        .getUsers(1)
        .then((d) => {
          clearTabDenied("users");
          setApiUsers(d.users || []);
        })
        .catch((err) => markTabDenied("users", err));
    } else if (activeTab === "reports") {
      adminApi
        .getReports(1)
        .then((d) => {
          clearTabDenied("reports");
          setApiReports(d.reports || []);
        })
        .catch((err) => markTabDenied("reports", err));
    } else if (activeTab === "chapters" || activeTab === "manga_approval") {
      adminApi
        .getUploads(1)
        .then((d) => {
          clearTabDenied("chapters");
          clearTabDenied("manga_approval");
          setApiUploads(d.uploads || []);
        })
        .catch((err) => {
          markTabDenied("chapters", err);
          markTabDenied("manga_approval", err);
        });
    } else if (activeTab === "analytics") {
      adminApi
        .getAnalytics()
        .then((d) => {
          clearTabDenied("analytics");
          setApiAnalytics(d.analytics || {});
        })
        .catch((err) => markTabDenied("analytics", err));
    }
  }, [activeTab, clearTabDenied, loadedTabs, markTabDenied]);

  const pendingUploads = apiUploads.filter((u) => u.status === "pending");

  const filteredUsers = useMemo(() => {
    let users = apiUsers.map((u) => ({
      ...u,
      name: u.display_name || u.username || "",
      status:
        userActions[u.id] === "banned"
          ? ("banned" as const)
          : userActions[u.id] === "active"
            ? ("active" as const)
            : u.is_banned
              ? ("banned" as const)
              : ("active" as const),
      joined: u.created_at ? u.created_at.split("T")[0] : "",
      chaptersRead: u.chapters_read || 0,
      comments: u.comments_posted || 0,
      bookmarks: 0,
    }));
    if (userFilter === "active")
      users = users.filter((u) => u.status === "active");
    else if (userFilter === "banned")
      users = users.filter((u) => u.status === "banned");
    else if (userFilter === "admin")
      users = users.filter((u) => u.role === "admin");
    else if (userFilter === "uploader")
      users = users.filter((u) => u.role === "uploader");
    if (searchQuery)
      users = users.filter(
        (u) =>
          u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (u.email || "").toLowerCase().includes(searchQuery.toLowerCase()),
      );
    return users;
  }, [userFilter, searchQuery, apiUsers, userActions]);

  const filteredReports = useMemo(() => {
    const detectViolationType = (r: any) => {
      const title = String(r.title || "");
      const commentReasonMatch = title.match(/Báo cáo bình luận:\s*(.+)$/i);
      if (commentReasonMatch?.[1]) return commentReasonMatch[1].trim();

      const reportType = String(r.report_type || "").toLowerCase();
      if (violationTypeLabels[reportType])
        return violationTypeLabels[reportType];

      return reportType || "Chưa xác định";
    };

    let reports = apiReports.map((r) => ({
      ...r,
      type: r.report_type || "other",
      target: r.target_id || r.title || "",
      reporter: r.profiles?.display_name || r.profiles?.username || "",
      reason:
        r.description ||
        r.reason ||
        r.admin_note ||
        r.title ||
        "Không có lý do",
      violationType: detectViolationType(r),
      priority: "medium" as const,
      createdAt: r.created_at ? r.created_at.split("T")[0] : "",
    }));
    if (reportFilter !== "all")
      reports = reports.filter((r) => r.type === reportFilter);
    return reports;
  }, [reportFilter, apiReports]);

  const showConfirm = (
    title: string,
    message: string,
    onConfirm: () => void | Promise<void>,
    destructive = false,
  ) => {
    setModal({
      open: true,
      title,
      message,
      destructive,
      onConfirm: async () => {
        try {
          await onConfirm();
        } finally {
          setModal((m) => ({ ...m, open: false }));
        }
      },
    });
  };

  const handleBanUser = (userId: string, name: string) => {
    setBanReason("");
    setBanCustomReason("");
    setBanDuration("permanent");
    setBanModal({ open: true, userId, userName: name });
  };

  const confirmBan = async () => {
    const reason = banReason === "other" ? banCustomReason : banReason;
    if (!reason) return;
    try {
      await adminApi.banUser(banModal.userId, reason);
      setApiUsers((prev) =>
        prev.map((u) =>
          u.id === banModal.userId
            ? { ...u, is_banned: true, ban_reason: reason }
            : u,
        ),
      );
      setUserActions((prev) => ({ ...prev, [banModal.userId]: "banned" }));
      setApiStats((prev: any) => ({
        ...prev,
        banned_users: (prev?.banned_users || 0) + 1,
      }));
      setBanModal({ open: false, userId: "", userName: "" });
      toast.success(`Đã ban "${banModal.userName}"`);
    } catch (err: any) {
      toast.error(err.message || "Không thể ban user");
    }
  };

  const handleUnbanUser = async (userId: string) => {
    await adminApi.unbanUser(userId);
    setApiUsers((prev) =>
      prev.map((u) =>
        u.id === userId ? { ...u, is_banned: false, ban_reason: null } : u,
      ),
    );
    setUserActions((prev) => ({ ...prev, [userId]: "active" }));
    setApiStats((prev: any) => ({
      ...prev,
      banned_users: Math.max(0, (prev?.banned_users || 0) - 1),
    }));
  };

  const handleVipToggle = async (userId: string, isVip: boolean, planMonths?: number) => {
    try {
      let vipExpiry: string | undefined;
      if (isVip && planMonths) {
        const exp = new Date();
        exp.setMonth(exp.getMonth() + planMonths);
        vipExpiry = exp.toISOString();
      }
      await adminApi.setVip(userId, isVip, vipExpiry);
      setApiUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, is_vip: isVip, vip_expiry: vipExpiry ?? null } : u)),
      );
      toast.success(isVip ? `Đã cấp VIP ${planMonths} tháng` : "Đã thu hồi VIP");
    } catch (err: any) {
      toast.error(err.message || "Không thể thay đổi VIP");
    }
  };

  const handleRoleChange = (userId: string, newRole: string) => {
    setApiUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
    );
  };

  const handleChapterAction = (id: string, action: "approve" | "reject") => {
    const label = action === "approve" ? "duyệt" : "từ chối";
    showConfirm(
      `${action === "approve" ? "Duyệt" : "Từ chối"} chapter`,
      `Bạn có chắc muốn ${label} chapter này?`,
      async () => {
        try {
          await adminApi.reviewUpload(id, action);
          setChapterActions((prev) => ({ ...prev, [id]: action }));
          toast.success(`Đã ${label} chapter`);
        } catch (err: any) {
          toast.error(err.message || `Không thể ${label} chapter`);
        }
      },
      action === "reject",
    );
  };

  const handleBulkChapterAction = (action: "approve" | "reject") => {
    if (selectedChapters.length === 0) return;
    const label = action === "approve" ? "duyệt" : "từ chối";
    showConfirm(
      `${action === "approve" ? "Duyệt" : "Từ chối"} hàng loạt`,
      `Bạn có chắc muốn ${label} ${selectedChapters.length} chapter?`,
      async () => {
        const newActions: Record<string, "approve" | "reject"> = {};
        await Promise.allSettled(
          selectedChapters.map((id) => adminApi.reviewUpload(id, action)),
        );
        selectedChapters.forEach((id) => {
          newActions[id] = action;
        });
        setChapterActions((prev) => ({ ...prev, ...newActions }));
        setSelectedChapters([]);
        toast.success(`Đã ${label} ${selectedChapters.length} chapter`);
      },
      action === "reject",
    );
  };

  const handleChapterDelete = (id: string) => {
    showConfirm(
      "Xóa chapter",
      "Bạn có chắc muốn xóa chapter này? Ảnh trong Supabase Storage cũng sẽ bị xóa.",
      async () => {
        try {
          await adminApi.deleteUpload(id);
          setApiUploads((prev) => prev.filter((u) => u.id !== id));
          toast.success("Đã xóa chapter và ảnh");
        } catch (err: any) {
          toast.error(err.message || "Không thể xóa chapter");
        }
      },
      true,
    );
  };

  const handleChapterHide = (id: string) => {
    showConfirm(
      "Ẩn chapter",
      "Bạn có chắc muốn ẩn chapter này? Chapter sẽ chuyển về trạng thái từ chối.",
      async () => {
        try {
          await adminApi.reviewUpload(id, "reject", "Ẩn bởi admin");
          setApiUploads((prev) =>
            prev.map((u) => (u.id === id ? { ...u, status: "rejected" } : u)),
          );
          toast.success("Đã ẩn chapter");
        } catch (err: any) {
          toast.error(err.message || "Không thể ẩn chapter");
        }
      },
      true,
    );
  };

  const handleNotifyBannerUpload = async (file?: File | null) => {
    if (!file) return;
    setNotifyUploadingImage(true);
    try {
      const res = await adminApi.uploadAnnouncementImage(file);
      setNotifyImageUrl(res.image_url || "");
      toast.success("Đã upload ảnh banner");
    } catch (err: any) {
      toast.error(err.message || "Upload ảnh banner thất bại");
    } finally {
      setNotifyUploadingImage(false);
    }
  };

  const renderContent = () => {
    const deniedMessage = tabDeniedMap[activeTab];
    if (deniedMessage) {
      const tabLabel = TABS.find((tab) => tab.key === activeTab)?.label || activeTab;
      return (
        <PermissionDeniedPanel
          title={tabLabel}
          message={deniedMessage}
          onRetry={() => {
            clearTabDenied(activeTab);
            if (activeTab === "overview") {
              void fetchOverviewCoreData();
              return;
            }
            setLoadedTabs((prev) => {
              const next = new Set(prev);
              next.delete(activeTab);
              return next;
            });
          }}
        />
      );
    }

    switch (activeTab) {
      case "overview":
        return (
          <OverviewSection
            pendingCount={pendingUploads.length}
            auditLog={apiAuditLog}
            stats={apiStats}
            analytics={apiAnalytics}
            onNavigate={(tab) => setActiveTab(tab as AdminTab)}
            onNotify={() => setNotifyModal(true)}
          />
        );
      case "users":
        return (
          <UsersSection
            users={filteredUsers}
            filter={userFilter}
            setFilter={setUserFilter}
            search={searchQuery}
            setSearch={setSearchQuery}
            onBan={handleBanUser}
            onUnban={handleUnbanUser}
            userActions={userActions}
            onVipToggle={handleVipToggle}
            onRoleChange={handleRoleChange}
          />
        );
      case "manga":
        return (
          <MangaSection
            search={searchQuery}
            setSearch={setSearchQuery}
            showConfirm={showConfirm}
          />
        );
      case "manga_approval":
        return (
          <MangaApprovalSection
            actions={mangaApprovalActions}
            setActions={setMangaApprovalActions}
            showConfirm={showConfirm}
          />
        );
      case "chapters":
        return (
          <ChaptersSection
            actions={chapterActions}
            onAction={handleChapterAction}
            selected={selectedChapters}
            setSelected={setSelectedChapters}
            onBulk={handleBulkChapterAction}
            uploads={apiUploads}
            onDelete={handleChapterDelete}
            onHide={handleChapterHide}
          />
        );

      case "reports":
        return (
          <ReportsSection
            reports={filteredReports}
            filter={reportFilter}
            setFilter={setReportFilter}
            actions={reportActions}
            setActions={setReportActions}
            showConfirm={showConfirm}
            auditLog={apiAuditLog}
          />
        );
      case "comments":
        return <CommentsSection />;
      case "announcements":
        return <AnnouncementsSection onQuickNotify={() => setNotifyModal(true)} />;
      case "analytics":
        return <AnalyticsSection stats={apiStats} analytics={apiAnalytics} />;
      case "settings":
        return <SettingsSection onNavigate={setActiveTab} />;
      case "security":
        return <SecuritySection />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside
        className={`${sidebarOpen ? "w-56" : "w-14"} hidden md:flex flex-col border-r border-border bg-card/50 transition-all duration-300 sticky top-14 h-[calc(100vh-3.5rem)]`}
      >
        <div className="p-3 border-b border-border flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/20">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          {sidebarOpen && (
            <span className="text-sm font-bold">Admin Panel</span>
          )}
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setActiveTab(t.key);
                setSearchQuery("");
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === t.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <t.icon className="w-4 h-4 shrink-0" />
              {sidebarOpen && <span>{t.label}</span>}
              {t.key === "chapters" &&
                pendingUploads.length > 0 &&
                sidebarOpen && (
                  <span className="ml-auto text-[10px] font-bold bg-yellow-400/20 text-yellow-400 px-1.5 py-0.5 rounded">
                    {pendingUploads.length}
                  </span>
                )}
              {t.key === "reports" &&
                apiReports.filter((r) => r.status === "pending").length > 0 &&
                sidebarOpen && (
                  <span className="ml-auto text-[10px] font-bold bg-red-400/20 text-red-400 px-1.5 py-0.5 rounded">
                    {apiReports.filter((r) => r.status === "pending").length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-3 border-t border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight
            className={`w-4 h-4 transition-transform ${sidebarOpen ? "rotate-180" : ""}`}
          />
        </button>
      </aside>

      {/* Mobile bottom nav — all tabs with horizontal scroll */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-card/95 backdrop-blur border-t border-border flex overflow-x-auto scrollbar-none">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setActiveTab(t.key);
              setSearchQuery("");
            }}
            className={`flex-none min-w-[56px] flex flex-col items-center gap-0.5 py-2.5 px-2 text-[9px] font-semibold transition-colors relative ${
              activeTab === t.key ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {activeTab === t.key && (
              <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-full" />
            )}
            <t.icon className="w-4 h-4" />
            <span className="truncate max-w-[52px] text-center">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Main content */}
      <main className="flex-1 min-h-screen pb-20 md:pb-0 overflow-x-hidden">
        <div className="px-3 py-4 sm:px-5 md:px-8 md:py-6 max-w-6xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <ConfirmModal
        open={modal.open}
        title={modal.title}
        message={modal.message}
        destructive={modal.destructive}
        onConfirm={modal.onConfirm}
        onCancel={() => setModal((m) => ({ ...m, open: false }))}
      />

      {/* Ban User Modal */}
      <AnimatePresence>
        {banModal.open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() =>
              setBanModal({ open: false, userId: "", userName: "" })
            }
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card border border-border rounded-2xl w-full max-w-md max-h-[85vh] overflow-hidden shadow-2xl flex flex-col"
            >
              {/* Header */}
              <div className="bg-destructive/5 border-b border-border px-5 py-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center">
                  <Ban className="w-5 h-5 text-destructive" />
                </div>
                <div>
                  <h3 className="font-bold text-foreground">Ban người dùng</h3>
                  <p className="text-xs text-muted-foreground">
                    Đình chỉ tài khoản{" "}
                    <span className="font-bold text-foreground">
                      {banModal.userName}
                    </span>
                  </p>
                </div>
              </div>

              <div className="p-5 space-y-4 overflow-y-auto flex-1">
                {/* Ban Reason */}
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-2 block">
                    Lý do ban <span className="text-destructive">*</span>
                  </label>
                  <div className="space-y-1.5">
                    {[
                      { value: "spam", label: "Spam / Quảng cáo" },
                      {
                        value: "harassment",
                        label: "Quấy rối người dùng khác",
                      },
                      {
                        value: "inappropriate",
                        label: "Nội dung không phù hợp",
                      },
                      { value: "fake_account", label: "Tài khoản giả mạo" },
                      { value: "copyright", label: "Vi phạm bản quyền" },
                      {
                        value: "multiple_violations",
                        label: "Tái phạm nhiều lần",
                      },
                      { value: "other", label: "Lý do khác" },
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer transition-all border ${banReason === opt.value ? "border-destructive/50 bg-destructive/5" : "border-transparent hover:bg-secondary/50"}`}
                      >
                        <input
                          type="radio"
                          name="banReason"
                          value={opt.value}
                          checked={banReason === opt.value}
                          onChange={() => setBanReason(opt.value)}
                          className="accent-destructive w-3.5 h-3.5"
                        />
                        <span className="text-sm font-medium">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Custom reason */}
                {banReason === "other" && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    className="overflow-hidden"
                  >
                    <textarea
                      value={banCustomReason}
                      onChange={(e) => setBanCustomReason(e.target.value)}
                      placeholder="Nhập lý do cụ thể..."
                      rows={3}
                      className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-destructive/50 resize-none placeholder:text-muted-foreground"
                    />
                  </motion.div>
                )}

                {/* Duration */}
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-2 block">
                    Thời hạn ban
                  </label>
                  <select
                    value={banDuration}
                    onChange={(e) => setBanDuration(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-destructive/50"
                  >
                    <option value="7d">7 ngày</option>
                    <option value="30d">30 ngày</option>
                    <option value="90d">90 ngày</option>
                    <option value="permanent">Vĩnh viễn</option>
                  </select>
                </div>

                {/* Warning */}
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                  <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-yellow-600 dark:text-yellow-400">
                    Người dùng sẽ bị chặn truy cập hệ thống và nhận thông báo về
                    việc bị ban cùng lý do.
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
                <button
                  onClick={() =>
                    setBanModal({ open: false, userId: "", userName: "" })
                  }
                  className="px-4 py-2 rounded-xl bg-secondary text-sm font-bold hover:bg-secondary/80 transition-colors"
                >
                  Hủy
                </button>
                <button
                  onClick={confirmBan}
                  disabled={
                    !banReason ||
                    (banReason === "other" && !banCustomReason.trim())
                  }
                  className="px-4 py-2 rounded-xl bg-destructive text-destructive-foreground text-sm font-bold hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Ban className="w-3.5 h-3.5" /> Xác nhận ban
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Notify Modal */}
      <AnimatePresence>
        {notifyModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setNotifyModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[88vh] overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-cyan-500/20 flex items-center justify-center">
                    <Bell className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h3 className="font-bold">Gửi thông báo hệ thống</h3>
                    <p className="text-xs text-muted-foreground">
                      Broadcast tới người dùng
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setNotifyModal(false)}
                  className="p-1.5 rounded-lg hover:bg-secondary"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-5 space-y-4 overflow-y-auto">
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                    Gửi đến
                  </label>
                  <select
                    value={notifyTarget}
                    onChange={(e) => setNotifyTarget(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="all">Tất cả người dùng</option>
                    <option value="reader">Reader</option>
                    <option value="uploader">Uploader</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                      Loại thông báo
                    </label>
                    <select
                      value={notifyKind}
                      onChange={(e) => setNotifyKind(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="system">Hệ thống</option>
                      <option value="maintenance">Bảo trì</option>
                      <option value="event">Event</option>
                      <option value="warning">Cảnh báo</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                      Popup home
                    </label>
                    <label className="flex h-[42px] items-center justify-between gap-3 px-3 rounded-xl bg-secondary border border-border cursor-pointer">
                      <span className="text-sm font-semibold">Hiện cho cả khách</span>
                      <input
                        type="checkbox"
                        checked={notifyShowPopup}
                        onChange={(e) => setNotifyShowPopup(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                    </label>
                  </div>
                </div>
                {notifyShowPopup ? (
                  <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 space-y-3">
                    <div className="grid sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                          Thời hạn popup
                        </label>
                        <select
                          value={notifyPopupHours}
                          onChange={(e) => setNotifyPopupHours(Number(e.target.value))}
                          className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        >
                          <option value={6}>6 giờ</option>
                          <option value={24}>24 giờ</option>
                          <option value={72}>3 ngày</option>
                          <option value={168}>7 ngày</option>
                          <option value={720}>30 ngày</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                          Kích thước
                        </label>
                        <select
                          value={notifyPopupSize}
                          onChange={(e) => setNotifyPopupSize(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        >
                          <option value="compact">Compact</option>
                          <option value="standard">Standard</option>
                          <option value="wide">Wide + ảnh</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                          Ưu tiên
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          value={notifyPriority}
                          onChange={(e) => setNotifyPriority(Number(e.target.value))}
                          className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                        Ảnh popup (URL, không bắt buộc)
                      </label>
                      <div className="flex gap-2">
                        <input
                          value={notifyImageUrl}
                          onChange={(e) => setNotifyImageUrl(e.target.value)}
                          placeholder="https://.../banner.jpg"
                          className="min-w-0 flex-1 px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-secondary px-3 py-2.5 text-xs font-bold hover:bg-secondary/80 border border-border whitespace-nowrap">
                          {notifyUploadingImage ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Upload className="w-3.5 h-3.5" />
                          )}
                          Upload
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            className="hidden"
                            disabled={notifyUploadingImage}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.currentTarget.value = "";
                              void handleNotifyBannerUpload(file);
                            }}
                          />
                        </label>
                      </div>
                      {notifyImageUrl ? (
                        <img
                          src={notifyImageUrl}
                          alt="Preview banner"
                          className="mt-2 h-24 w-full rounded-xl object-cover border border-border"
                        />
                      ) : null}
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                          Nút CTA
                        </label>
                        <input
                          value={notifyCtaLabel}
                          onChange={(e) => setNotifyCtaLabel(e.target.value)}
                          placeholder="VD: Xem sự kiện"
                          className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                          Link CTA
                        </label>
                        <input
                          value={notifyCtaUrl}
                          onChange={(e) => setNotifyCtaUrl(e.target.value)}
                          placeholder="/manga hoặc https://..."
                          className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                    </div>
                    <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-secondary border border-border cursor-pointer">
                      <span className="text-sm font-semibold">Cho phép người dùng đóng popup</span>
                      <input
                        type="checkbox"
                        checked={notifyPopupDismissible}
                        onChange={(e) => setNotifyPopupDismissible(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                    </label>
                    <p className="text-[11px] text-muted-foreground">
                      Popup chỉ hiện ở trang home. Nếu người dùng đóng, cùng một thông báo sẽ không hiện lại.
                    </p>
                  </div>
                ) : null}
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                    Tiêu đề *
                  </label>
                  <input
                    value={notifyTitle}
                    onChange={(e) => setNotifyTitle(e.target.value)}
                    placeholder="Tiêu đề thông báo..."
                    className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                    Nội dung *
                  </label>
                  <textarea
                    value={notifyMessage}
                    onChange={(e) => setNotifyMessage(e.target.value)}
                    rows={4}
                    placeholder="Nội dung thông báo..."
                    className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                </div>
              </div>
              <div className="p-4 border-t border-border flex gap-2 justify-end">
                <button
                  onClick={() => setNotifyModal(false)}
                  className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
                >
                  Hủy
                </button>
                <button
                  disabled={
                    !notifyTitle.trim() ||
                    !notifyMessage.trim() ||
                    notifySending
                  }
                  onClick={async () => {
                    if (!notifyTitle.trim() || !notifyMessage.trim()) return;
                    setNotifySending(true);
                    try {
                      const res = await adminApi.notifyAll({
                        title: notifyTitle,
                        message: notifyMessage,
                        target: notifyTarget,
                        notify_type: "system",
                        announcement_type: notifyKind,
                        show_popup: notifyShowPopup,
                        popup_expires_hours: notifyPopupHours,
                        image_url: notifyImageUrl.trim() || null,
                        cta_label: notifyCtaLabel.trim() || null,
                        cta_url: notifyCtaUrl.trim() || null,
                        popup_size: notifyPopupSize,
                        popup_dismissible: notifyPopupDismissible,
                        priority: notifyPriority,
                      });
                      toast.success(res.message || `Đã gửi thông báo!`);
                      setNotifyModal(false);
                      setNotifyTitle("");
                      setNotifyMessage("");
                      setNotifyKind("system");
                      setNotifyShowPopup(false);
                      setNotifyPopupHours(24);
                      setNotifyImageUrl("");
                      setNotifyCtaLabel("");
                      setNotifyCtaUrl("");
                      setNotifyPopupSize("standard");
                      setNotifyPopupDismissible(true);
                      setNotifyPriority(0);
                    } catch (err: any) {
                      toast.error(err.message || "Gửi thông báo thất bại");
                    } finally {
                      setNotifySending(false);
                    }
                  }}
                  className="px-4 py-2 rounded-xl bg-cyan-500 text-white text-xs font-bold hover:bg-cyan-600 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {notifySending ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Đang
                      gửi...
                    </>
                  ) : (
                    <>
                      <Bell className="w-3.5 h-3.5" /> Gửi thông báo
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ===================== ANNOUNCEMENTS SECTION =====================
const getAnnouncementStatus = (announcement: any) => {
  const now = Date.now();
  const startsAt = announcement.starts_at ? new Date(announcement.starts_at).getTime() : 0;
  const expiresAt = announcement.expires_at ? new Date(announcement.expires_at).getTime() : 0;
  if (!announcement.is_active) return { label: "Đã tắt", className: "bg-muted text-muted-foreground" };
  if (startsAt && startsAt > now) return { label: "Hẹn lịch", className: "bg-blue-500/15 text-blue-400" };
  if (expiresAt && expiresAt <= now) return { label: "Hết hạn", className: "bg-red-500/15 text-red-400" };
  return { label: "Đang hiện", className: "bg-emerald-500/15 text-emerald-400" };
};

const formatAdminDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const AnnouncementsSection = ({ onQuickNotify }: { onQuickNotify: () => void }) => {
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AnnouncementFormState>({ ...DEFAULT_ANNOUNCEMENT_FORM });

  const totalPages = Math.max(1, Math.ceil(total / 20));

  const loadAnnouncements = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getAnnouncements(page, status);
      setAnnouncements(data.announcements || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      toast.error(err.message || "Không thể tải thông báo");
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements]);

  const resetForm = () => {
    setEditingId(null);
    setForm({ ...DEFAULT_ANNOUNCEMENT_FORM });
  };

  const buildPayload = () => ({
    ...form,
    title: form.title.trim(),
    message: form.message.trim(),
    image_url: form.image_url.trim() || null,
    cta_label: form.cta_label.trim() || null,
    cta_url: form.cta_url.trim() || null,
    popup_expires_hours: Number(form.popup_expires_hours) || 24,
    priority: Number(form.priority) || 0,
    target: "all",
  });

  const saveAnnouncement = async () => {
    if (!form.title.trim() || !form.message.trim()) {
      toast.error("Nhập tiêu đề và nội dung thông báo đã nha");
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingId) {
        await adminApi.updateAnnouncement(editingId, payload);
        toast.success("Đã cập nhật thông báo");
      } else {
        await adminApi.createAnnouncement(payload);
        toast.success("Đã tạo thông báo");
      }
      resetForm();
      setPage(1);
      await loadAnnouncements();
    } catch (err: any) {
      toast.error(err.message || "Lưu thông báo thất bại");
    } finally {
      setSaving(false);
    }
  };

  const editAnnouncement = (announcement: any) => {
    const expiresAt = announcement.expires_at ? new Date(announcement.expires_at).getTime() : 0;
    const remainingHours = expiresAt
      ? Math.max(1, Math.min(720, Math.round((expiresAt - Date.now()) / 3_600_000)))
      : 24;
    setEditingId(announcement.id);
    setForm({
      title: announcement.title || "",
      message: announcement.message || "",
      announcement_type: announcement.announcement_type || "system",
      show_popup: announcement.show_popup !== false,
      is_active: announcement.is_active !== false,
      image_url: announcement.image_url || "",
      cta_label: announcement.cta_label || "",
      cta_url: announcement.cta_url || "",
      popup_size: announcement.popup_size || "standard",
      popup_dismissible: announcement.popup_dismissible !== false,
      popup_expires_hours: remainingHours,
      priority: Number(announcement.priority || 0),
    });
  };

  const toggleAnnouncement = async (announcement: any) => {
    try {
      const nextActive = !announcement.is_active;
      await adminApi.updateAnnouncement(announcement.id, { is_active: nextActive });
      setAnnouncements((prev) =>
        prev.map((item) => (item.id === announcement.id ? { ...item, is_active: nextActive } : item)),
      );
      toast.success(nextActive ? "Đã bật thông báo" : "Đã tắt thông báo");
    } catch (err: any) {
      toast.error(err.message || "Không thể đổi trạng thái");
    }
  };

  const uploadBannerImage = async (file?: File | null) => {
    if (!file) return;
    setUploadingImage(true);
    try {
      const res = await adminApi.uploadAnnouncementImage(file);
      setForm((prev) => ({ ...prev, image_url: res.image_url || "" }));
      toast.success("Đã upload ảnh banner");
    } catch (err: any) {
      toast.error(err.message || "Upload ảnh banner thất bại");
    } finally {
      setUploadingImage(false);
    }
  };

  const deleteAnnouncement = (announcement: any) => {
    setDeleteTarget(announcement);
  };

  const confirmDeleteAnnouncement = async () => {
    if (!deleteTarget?.id) return;
    setDeletingId(deleteTarget.id);
    try {
      await adminApi.deleteAnnouncement(deleteTarget.id);
      toast.success("Đã xóa thông báo");
      setDeleteTarget(null);
      await loadAnnouncements();
    } catch (err: any) {
      toast.error(err.message || "Không thể xóa thông báo");
    } finally {
      setDeletingId(null);
    }
  };

  const previewType = announcementTypeOptions.find((item) => item.value === form.announcement_type)?.label || "Thông báo";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Thông báo home</h1>
          <p className="text-sm text-muted-foreground">
            Tạo popup cho khách lẫn người đã đăng nhập. Tab này chỉ admin truy cập được.
          </p>
        </div>
        <button
          onClick={onQuickNotify}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90"
        >
          <Bell className="w-4 h-4" />
          Gửi nhanh inbox + popup
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-black">{editingId ? "Sửa thông báo" : "Tạo thông báo mới"}</h2>
              <p className="text-xs text-muted-foreground">Ảnh/CTA là tuỳ chọn, dùng cho popup đẹp hơn.</p>
            </div>
            {editingId ? (
              <button onClick={resetForm} className="rounded-xl bg-secondary px-3 py-2 text-xs font-bold hover:bg-secondary/80">
                Tạo mới
              </button>
            ) : null}
          </div>

          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Loại</label>
                <select
                  value={form.announcement_type}
                  onChange={(e) => setForm((prev) => ({ ...prev, announcement_type: e.target.value }))}
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {announcementTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Thời hạn</label>
                <select
                  value={form.popup_expires_hours}
                  onChange={(e) => setForm((prev) => ({ ...prev, popup_expires_hours: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value={6}>6 giờ</option>
                  <option value={24}>24 giờ</option>
                  <option value={72}>3 ngày</option>
                  <option value={168}>7 ngày</option>
                  <option value={720}>30 ngày</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Tiêu đề *</label>
              <input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="VD: Bảo trì hệ thống tối nay"
                className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Nội dung *</label>
              <textarea
                value={form.message}
                onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))}
                rows={5}
                placeholder="Nội dung sẽ hiển thị trong popup..."
                className="w-full resize-none rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Ảnh popup</label>
              <div className="flex gap-2">
                <input
                  value={form.image_url}
                  onChange={(e) => setForm((prev) => ({ ...prev, image_url: e.target.value }))}
                  placeholder="https://.../banner.jpg"
                  className="min-w-0 flex-1 rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                />
                <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary px-3 py-2.5 text-xs font-bold hover:bg-secondary/80 whitespace-nowrap">
                  {uploadingImage ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Upload
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    disabled={uploadingImage}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = "";
                      void uploadBannerImage(file);
                    }}
                  />
                </label>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Có thể dán URL hoặc upload ảnh từ máy. Tối đa 8MB.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Nút CTA</label>
                <input
                  value={form.cta_label}
                  onChange={(e) => setForm((prev) => ({ ...prev, cta_label: e.target.value }))}
                  placeholder="VD: Xem chi tiết"
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Link CTA</label>
                <input
                  value={form.cta_url}
                  onChange={(e) => setForm((prev) => ({ ...prev, cta_url: e.target.value }))}
                  placeholder="/manga hoặc https://..."
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Size popup</label>
                <select
                  value={form.popup_size}
                  onChange={(e) => setForm((prev) => ({ ...prev, popup_size: e.target.value }))}
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="wide">Wide + ảnh</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold text-muted-foreground">Ưu tiên</label>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={form.priority}
                  onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="flex items-end">
                <label className="flex h-[42px] w-full items-center justify-between rounded-xl border border-border bg-secondary px-3 text-sm font-bold">
                  Active
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <label className="flex items-center justify-between rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm font-bold">
                Hiện popup home
                <input
                  type="checkbox"
                  checked={form.show_popup}
                  onChange={(e) => setForm((prev) => ({ ...prev, show_popup: e.target.checked }))}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm font-bold">
                Cho phép đóng
                <input
                  type="checkbox"
                  checked={form.popup_dismissible}
                  onChange={(e) => setForm((prev) => ({ ...prev, popup_dismissible: e.target.checked }))}
                  className="h-4 w-4 accent-primary"
                />
              </label>
            </div>

            <button
              onClick={saveAnnouncement}
              disabled={saving || !form.title.trim() || !form.message.trim()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {editingId ? "Lưu thay đổi" : "Tạo thông báo"}
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            <h2 className="text-lg font-black">Preview popup</h2>
          </div>
          <div className="overflow-hidden rounded-[1.75rem] border border-primary/30 bg-background shadow-2xl">
            {form.image_url ? (
              <div className="h-44 overflow-hidden bg-muted">
                <img src={form.image_url} alt="Preview" className="h-full w-full object-cover" />
              </div>
            ) : (
              <div className="h-28 bg-gradient-to-br from-primary/25 via-cyan-500/10 to-transparent" />
            )}
            <div className="p-5">
              <span className="inline-flex rounded-full bg-primary/15 px-3 py-1 text-[11px] font-black uppercase text-primary">
                {previewType}
              </span>
              <h3 className="mt-3 text-2xl font-black leading-tight">
                {form.title || "Tiêu đề thông báo"}
              </h3>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {form.message || "Nội dung thông báo sẽ hiện ở đây. Có thể dùng ảnh, CTA và style theo loại thông báo."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {form.cta_label || form.cta_url ? (
                  <span className="inline-flex items-center gap-1 rounded-xl bg-primary px-4 py-2 text-xs font-black text-primary-foreground">
                    {form.cta_label || "Xem ngay"}
                    <ArrowUpDown className="h-3 w-3 rotate-90" />
                  </span>
                ) : null}
                {form.popup_dismissible ? (
                  <span className="rounded-xl border border-border px-4 py-2 text-xs font-bold">Đã hiểu</span>
                ) : null}
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Mẹo nhỏ: dùng ảnh ngang 16:9 cho size Wide để popup nhìn “event” hơn, không bị như hộp thoại mặc định.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black">Danh sách thông báo</h2>
            <p className="text-xs text-muted-foreground">{total.toLocaleString()} thông báo</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="rounded-xl border border-border bg-secondary px-3 py-2 text-sm font-semibold outline-none"
            >
              {announcementStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => void loadAnnouncements()}
              className="rounded-xl bg-secondary p-2 text-muted-foreground hover:text-foreground"
              title="Tải lại"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/60 bg-secondary/30">
                <th className="px-4 py-3 text-left text-xs font-black text-muted-foreground">Thông báo</th>
                <th className="hidden px-4 py-3 text-left text-xs font-black text-muted-foreground md:table-cell">Popup</th>
                <th className="hidden px-4 py-3 text-left text-xs font-black text-muted-foreground lg:table-cell">Thời gian</th>
                <th className="px-4 py-3 text-right text-xs font-black text-muted-foreground">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {announcements.map((announcement) => {
                const statusInfo = getAnnouncementStatus(announcement);
                return (
                  <tr key={announcement.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {announcement.image_url ? (
                          <img src={announcement.image_url} alt="" className="h-12 w-16 rounded-lg object-cover border border-border" />
                        ) : (
                          <div className="flex h-12 w-16 items-center justify-center rounded-lg border border-border bg-secondary">
                            <Bell className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="line-clamp-1 text-sm font-bold">{announcement.title}</p>
                          <p className="line-clamp-1 text-xs text-muted-foreground">{announcement.message}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${statusInfo.className}`}>
                              {statusInfo.label}
                            </span>
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary">
                              {announcement.announcement_type || "system"}
                            </span>
                            {Number(announcement.priority || 0) > 0 ? (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-400">
                                P{announcement.priority}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                      <div className="space-y-1">
                        <p>{announcement.show_popup ? "Hiện popup" : "Không popup"}</p>
                        <p>{announcement.popup_size || "standard"} · {announcement.popup_dismissible === false ? "không cho đóng" : "cho đóng"}</p>
                        {announcement.cta_url ? <p className="text-primary">Có CTA</p> : null}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                      <p>Từ: {formatAdminDate(announcement.starts_at)}</p>
                      <p>Đến: {formatAdminDate(announcement.expires_at)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => editAnnouncement(announcement)}
                          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                          title="Sửa"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => toggleAnnouncement(announcement)}
                          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                          title={announcement.is_active ? "Tắt" : "Bật"}
                        >
                          {announcement.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => deleteAnnouncement(announcement)}
                          className="rounded-lg p-2 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                          title="Xóa"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Đang tải thông báo...
          </div>
        ) : announcements.length === 0 ? (
          <div className="p-10 text-center">
            <Bell className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-semibold">Chưa có thông báo nào</p>
            <p className="text-xs text-muted-foreground">Tạo thông báo đầu tiên ở form bên trên.</p>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex items-center justify-center gap-2 border-t border-border p-4">
            <button
              disabled={page <= 1}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              className="rounded-xl bg-secondary px-3 py-2 text-xs font-bold disabled:opacity-40"
            >
              Trước
            </button>
            <span className="text-xs font-bold text-muted-foreground">
              Trang {page}/{totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              className="rounded-xl bg-secondary px-3 py-2 text-xs font-bold disabled:opacity-40"
            >
              Sau
            </button>
          </div>
        ) : null}
      </div>

      <AnimatePresence>
        {deleteTarget ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
            onClick={() => {
              if (!deletingId) setDeleteTarget(null);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md overflow-hidden rounded-3xl border border-red-500/25 bg-card shadow-2xl"
            >
              <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-red-500/20 via-orange-500/10 to-transparent" />
              <div className="relative p-6">
                <div className="mb-4 flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-500/15 text-red-400">
                    <Trash2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg font-black">Xóa thông báo?</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Thông báo này sẽ biến mất khỏi popup home và danh sách quản lý.
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-background/70 p-3">
                  <p className="line-clamp-2 text-sm font-bold">{deleteTarget.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {deleteTarget.message}
                  </p>
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    disabled={Boolean(deletingId)}
                    onClick={() => setDeleteTarget(null)}
                    className="rounded-xl bg-secondary px-4 py-2.5 text-sm font-bold hover:bg-secondary/80 disabled:opacity-50"
                  >
                    Hủy
                  </button>
                  <button
                    disabled={Boolean(deletingId)}
                    onClick={confirmDeleteAnnouncement}
                    className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-black text-white hover:bg-red-600 disabled:opacity-60"
                  >
                    {deletingId ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Xóa luôn
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

// ===================== OVERVIEW SECTION =====================
const OverviewSection = ({
  pendingCount,
  auditLog,
  stats,
  analytics,
  onNavigate,
  onNotify,
}: {
  pendingCount: number;
  auditLog: any[];
  stats: any;
  analytics: any;
  onNavigate: (tab: string) => void;
  onNotify: () => void;
}) => {
  const weeklyViews =
    Array.isArray(analytics?.weekly_views) && analytics.weekly_views.length > 0
      ? analytics.weekly_views
      : [0, 0, 0, 0, 0, 0, 0];
  const weeklyDays =
    Array.isArray(analytics?.weekly_labels) && analytics.weekly_labels.length > 0
      ? analytics.weekly_labels
      : ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

  return (
    <div className="space-y-6">
    <div>
      <h1 className="text-2xl font-bold">Tổng quan</h1>
      <p className="text-sm text-muted-foreground">
        Dashboard quản trị hệ thống
      </p>
    </div>

    {/* KPI Cards */}
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <StatCard
        icon={Users}
        label="Tổng người dùng"
        value={stats?.total_users ?? "—"}
        color="text-blue-400"
      />
      <StatCard
        icon={BookOpen}
        label="Tổng truyện"
        value={stats?.total_manga ?? "—"}
        color="text-primary"
      />
      <StatCard
        icon={Layers}
        label="Tổng chapters"
        value={stats?.total_chapters ?? "—"}
        color="text-green-400"
      />
      <StatCard
        icon={Activity}
        label="Đang đọc"
        value={stats?.active_readers ?? "—"}
        color="text-cyan-400"
      />
      <StatCard
        icon={Clock}
        label="Chờ duyệt"
        value={stats?.pending_uploads ?? pendingCount}
        color="text-yellow-400"
      />
    </div>

    {/* Charts + Recent Activity */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-bold mb-4">Lượt xem theo tuần</h3>
        <SimpleBarChart data={weeklyViews} labels={weeklyDays} />
      </div>
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-bold mb-4">Hoạt động gần đây</h3>
        <div className="space-y-3">
          {auditLog.slice(0, 5).map((log: any) => (
            <div
              key={log.id}
              className="flex items-start gap-3 group hover:bg-secondary/30 rounded-lg p-2 -mx-2 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0 mt-0.5">
                {(log.admin_name || "A")[0]}
              </div>
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium">
                    {log.admin_name || "Admin"}
                  </span>{" "}
                  <span className="text-muted-foreground">{log.action}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {log.target} •{" "}
                  {log.created_at
                    ? new Date(log.created_at).toLocaleString("vi")
                    : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Quick Actions */}
    <div className="bg-card border border-border rounded-xl p-5">
      <h3 className="text-sm font-bold mb-3">Hành động nhanh</h3>
      <div className="flex flex-wrap gap-2">
        {[
          {
            label: "Duyệt chapters",
            icon: CheckCircle,
            color: "bg-green-400/10 text-green-400 hover:bg-green-400/20",
            onClick: () => onNavigate("chapters"),
          },
          {
            label: "Ban user",
            icon: Ban,
            color: "bg-red-400/10 text-red-400 hover:bg-red-400/20",
            onClick: () => onNavigate("users"),
          },
          {
            label: "Thêm truyện",
            icon: BookOpen,
            color: "bg-primary/10 text-primary hover:bg-primary/20",
            onClick: () => onNavigate("manga"),
          },
          {
            label: "Gửi thông báo",
            icon: Bell,
            color: "bg-cyan-400/10 text-cyan-400 hover:bg-cyan-400/20",
            onClick: () => onNotify(),
          },
          {
            label: "Xuất CSV",
            icon: Download,
            color: "bg-secondary text-foreground hover:bg-secondary/80",
            onClick: async () => {
              try {
                await adminApi.exportUsersCSV();
                toast.success("Đã xuất CSV!");
              } catch (e: any) {
                toast.error(e.message);
              }
            },
          },
        ].map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${a.color}`}
          >
            <a.icon className="w-3.5 h-3.5" />
            {a.label}
          </button>
        ))}
      </div>
    </div>

    {/* Top Manga from analytics */}
    <div className="bg-card border border-border rounded-xl p-5">
      <h3 className="text-sm font-bold mb-3">Top truyện phổ biến</h3>
      {analytics?.top_manga?.length > 0 ? (
        <div className="space-y-2">
          {(analytics.top_manga || []).slice(0, 5).map((m: any, i: number) => (
            <div
              key={m.slug}
              className="flex items-center gap-3 p-2 hover:bg-secondary/30 rounded-lg"
            >
              <span className="text-xs font-black text-muted-foreground w-4">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  {m.title || m.slug}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {(m.views || 0).toLocaleString()} views
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Chưa có dữ liệu. Người dùng cần đọc truyện để tạo dữ liệu.
        </p>
      )}
    </div>
    </div>
  );
};

// ===================== USERS SECTION =====================
const UsersSection = ({
  users,
  filter,
  setFilter,
  search,
  setSearch,
  onBan,
  onUnban,
  userActions,
  onVipToggle,
  onRoleChange,
}: {
  users: any[];
  filter: string;
  setFilter: (f: any) => void;
  search: string;
  setSearch: (s: string) => void;
  onBan: (id: string, name: string) => void;
  onUnban: (id: string) => Promise<void>;
  userActions: Record<string, string>;
  onVipToggle: (userId: string, isVip: boolean, planMonths?: number) => void;
  onRoleChange: (userId: string, newRole: string) => void;
}) => {
  const [quickView, setQuickView] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<{
    type: "edit" | "comments" | "history" | "role";
    userId: string;
  } | null>(null);
  const modalUser = activeModal
    ? users.find((u) => u.id === activeModal.userId)
    : null;
  const filters = [
    { key: "all", label: "Tất cả" },
    { key: "active", label: "Hoạt động" },
    { key: "banned", label: "Đã ban" },
    { key: "admin", label: "Admin" },
    { key: "uploader", label: "Uploader" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Quản lý người dùng</h1>
        <p className="text-sm text-muted-foreground">
          Tổng: {users.length} người dùng
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Tìm username / email..."
        />
        <div className="flex gap-1 bg-secondary/30 p-1 rounded-lg">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${filter === f.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground">
                  Người dùng
                </th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden sm:table-cell">
                  Vai trò
                </th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden md:table-cell">
                  Trạng thái
                </th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden lg:table-cell">
                  Đã đọc
                </th>
                <th className="text-right px-4 py-3 text-xs font-bold text-muted-foreground">
                  Hành động
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isBanned =
                  userActions[user.id] === "banned" || user.status === "banned";
                return (
                  <tr
                    key={user.id}
                    className="border-b border-border/50 hover:bg-secondary/30 transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                          {user.name[0]}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{user.name}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {user.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <StatusBadge status={isBanned ? "banned" : "active"} />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-sm">
                      {user.chaptersRead}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            setQuickView(quickView === user.id ? null : user.id)
                          }
                          className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {!isBanned && user.role !== "admin" && (
                          <button
                            onClick={() => onBan(user.id, user.name)}
                            className="p-1.5 rounded-lg hover:bg-red-400/10 text-muted-foreground hover:text-red-400 transition-colors"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isBanned && (
                          <button
                            onClick={async () => {
                              try {
                                await onUnban(user.id);
                                toast.success("Đã gỡ ban");
                              } catch (err: any) {
                                toast.error(err?.message || "Không thể gỡ ban");
                              }
                            }}
                            className="p-1.5 rounded-lg hover:bg-green-400/10 text-red-400 hover:text-green-400 transition-colors text-[10px] font-bold"
                          >
                            Gỡ ban
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Quick View Panel */}
      <AnimatePresence>
        {quickView &&
          (() => {
            const user = users.find((u) => u.id === quickView);
            if (!user) return null;
            const isBanned =
              userActions[user.id] === "banned" || user.status === "banned";
            const daysSinceJoined = Math.floor(
              (Date.now() - new Date(user.joined).getTime()) /
                (1000 * 60 * 60 * 24),
            );
            return (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-card border border-border rounded-xl overflow-hidden"
              >
                {/* Header */}
                <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-5 border-b border-border/50">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 rounded-2xl bg-primary/20 flex items-center justify-center text-xl font-black text-primary ring-2 ring-primary/30">
                        {user.name[0]}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-bold">{user.name}</h3>
                          <RoleBadge role={user.role} />
                          <StatusBadge
                            status={isBanned ? "banned" : "active"}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {user.email}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Tham gia {user.joined} · {daysSinceJoined} ngày trước
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setQuickView(null)}
                      className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="p-5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                    <div className="bg-secondary/30 rounded-xl p-3.5 text-center border border-border/30">
                      <BookOpen className="w-4 h-4 mx-auto mb-1.5 text-primary" />
                      <p className="text-xl font-black">{user.chaptersRead}</p>
                      <p className="text-[10px] text-muted-foreground font-medium">
                        Chapters đã đọc
                      </p>
                    </div>
                    <div className="bg-secondary/30 rounded-xl p-3.5 text-center border border-border/30">
                      <Star className="w-4 h-4 mx-auto mb-1.5 text-yellow-400" />
                      <p className="text-xl font-black">{user.bookmarks}</p>
                      <p className="text-[10px] text-muted-foreground font-medium">
                        Bookmarks
                      </p>
                    </div>
                    <div className="bg-secondary/30 rounded-xl p-3.5 text-center border border-border/30">
                      <MessageSquare className="w-4 h-4 mx-auto mb-1.5 text-blue-400" />
                      <p className="text-xl font-black">{user.comments}</p>
                      <p className="text-[10px] text-muted-foreground font-medium">
                        Bình luận
                      </p>
                    </div>
                    <div className="bg-secondary/30 rounded-xl p-3.5 text-center border border-border/30">
                      <Activity className="w-4 h-4 mx-auto mb-1.5 text-green-400" />
                      <p className="text-xl font-black">
                        {Math.round(
                          (user.chaptersRead / Math.max(daysSinceJoined, 1)) *
                            7,
                        )}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-medium">
                        Chapters/tuần
                      </p>
                    </div>
                  </div>

                  {/* Activity bar */}
                  <div className="mb-5">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-bold">Mức độ hoạt động</p>
                      <p className="text-[10px] text-muted-foreground">
                        {user.chaptersRead > 300
                          ? "Rất tích cực"
                          : user.chaptersRead > 100
                            ? "Tích cực"
                            : "Ít hoạt động"}
                      </p>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{
                          width: `${Math.min(user.chaptersRead / 8, 100)}%`,
                        }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                        className={`h-full rounded-full ${user.chaptersRead > 300 ? "bg-green-400" : user.chaptersRead > 100 ? "bg-primary" : "bg-muted-foreground"}`}
                      />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 items-start">
                    {/* Edit */}
                    <motion.button
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() =>
                        setActiveModal({ type: "edit", userId: user.id })
                      }
                      className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 text-blue-400 text-xs font-bold transition-all"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <Edit className="w-4 h-4" />
                      </div>
                      Chỉnh sửa
                    </motion.button>

                    {/* Comments */}
                    <motion.button
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() =>
                        setActiveModal({ type: "comments", userId: user.id })
                      }
                      className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 text-blue-400 text-xs font-bold transition-all"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <MessageSquare className="w-4 h-4" />
                      </div>
                      Bình luận ({user.comments})
                    </motion.button>

                    {/* History */}
                    <motion.button
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() =>
                        setActiveModal({ type: "history", userId: user.id })
                      }
                      className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 text-xs font-bold transition-all"
                    >
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                        <FileText className="w-4 h-4" />
                      </div>
                      Lịch sử đọc
                    </motion.button>

                    {/* Change Role */}
                    {user.role !== "admin" && (
                      <motion.button
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() =>
                          setActiveModal({ type: "role", userId: user.id })
                        }
                        className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 hover:border-amber-500/40 text-amber-400 text-xs font-bold transition-all"
                      >
                        <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                          <UserCheck className="w-4 h-4" />
                        </div>
                        Đổi vai trò
                      </motion.button>
                    )}

                    {/* VIP Plan Selector */}
                    {user.is_vip ? (
                      <div className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-bold">
                        <div className="w-8 h-8 rounded-lg bg-yellow-400/20 flex items-center justify-center">
                          <Star className="w-4 h-4" />
                        </div>
                        <span>VIP đang hoạt động</span>
                        {user.vip_expiry && (
                          <span className="text-[9px] text-yellow-300/70 font-normal">
                            HSD: {new Date(user.vip_expiry).toLocaleDateString("vi")}
                          </span>
                        )}
                        <button
                          onClick={() => onVipToggle(user.id, false)}
                          className="mt-1 text-[9px] px-2 py-0.5 rounded bg-yellow-400/20 hover:bg-red-400/20 hover:text-red-400 transition-colors"
                        >
                          Thu hồi
                        </button>
                      </div>
                    ) : (
                      <VipGrantBox userId={user.id} onGrant={(months) => onVipToggle(user.id, true, months)} />
                    )}

                    {/* Ban / Unban */}
                    {!isBanned && user.role !== "admin" && (
                      <motion.button
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onBan(user.id, user.name)}
                        className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 text-red-400 text-xs font-bold transition-all"
                      >
                        <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                          <Ban className="w-4 h-4" />
                        </div>
                        Cấm người dùng
                      </motion.button>
                    )}
                    {isBanned && (
                      <div className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-bold opacity-80">
                        <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                          <Ban className="w-4 h-4" />
                        </div>
                        Đã bị cấm
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })()}
      </AnimatePresence>

      {/* ===== ACTION MODALS ===== */}
      <AnimatePresence>
        {activeModal && modalUser && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4"
            onClick={() => setActiveModal(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card border border-border rounded-2xl w-full max-w-lg max-h-[92vh] overflow-hidden shadow-2xl flex flex-col"
            >
              {/* === EDIT USER MODAL === */}
              {activeModal.type === "edit" && (
                <>
                  <div className="p-5 border-b border-border flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
                        <Edit className="w-5 h-5 text-blue-400" />
                      </div>
                      <div>
                        <h3 className="font-bold">Chỉnh sửa người dùng</h3>
                        <p className="text-xs text-muted-foreground">
                          {modalUser.name}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setActiveModal(null)}
                      className="p-1.5 rounded-lg hover:bg-secondary"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="p-5 space-y-4 overflow-y-auto">
                    <div>
                      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                        Tên hiển thị
                      </label>
                      <input
                        defaultValue={modalUser.name}
                        className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                        Email
                      </label>
                      <input
                        defaultValue={modalUser.email}
                        className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                        Vai trò
                      </label>
                      <select
                        defaultValue={modalUser.role}
                        className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      >
                        <option value="reader">Reader</option>
                        <option value="uploader">Uploader</option>
                        <option value="moderator">Moderator</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-muted-foreground mb-1.5 block">
                        Ghi chú admin
                      </label>
                      <textarea
                        placeholder="Thêm ghi chú về người dùng này..."
                        rows={3}
                        className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                      />
                    </div>
                  </div>
                  <div className="p-4 border-t border-border flex gap-2 justify-end">
                    <button
                      onClick={() => setActiveModal(null)}
                      className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
                    >
                      Hủy
                    </button>
                    <button
                      onClick={() => setActiveModal(null)}
                      className="px-4 py-2 rounded-xl bg-blue-500 text-white text-xs font-bold hover:bg-blue-600 transition-colors"
                    >
                      Lưu thay đổi
                    </button>
                  </div>
                </>
              )}

              {activeModal.type === "comments" && (
                <UserCommentsModalContent
                  userId={activeModal.userId}
                  user={modalUser}
                  onClose={() => setActiveModal(null)}
                />
              )}

              {activeModal.type === "history" && (
                <UserHistoryModalContent
                  userId={activeModal.userId}
                  user={modalUser}
                  onClose={() => setActiveModal(null)}
                />
              )}

               {/* === CHANGE ROLE MODAL === */}
              {activeModal.type === "role" &&
                (() => {
                  const roles = [
                    { key: "reader", label: "Reader", desc: "Chỉ đọc truyện và bình luận", icon: Eye, color: "text-muted-foreground bg-secondary" },
                    { key: "uploader", label: "Uploader", desc: "Upload và quản lý chapters", icon: Upload, color: "text-amber-400 bg-amber-500/10" },
                    { key: "moderator", label: "Moderator", desc: "Kiểm duyệt nội dung và quản lý báo cáo", icon: Shield, color: "text-blue-400 bg-blue-500/10" },
                    { key: "admin", label: "Admin", desc: "Toàn quyền quản trị hệ thống", icon: Shield, color: "text-red-400 bg-red-500/10" },
                  ];
                  return (
                    <>
                      <div className="p-5 border-b border-border flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                            <UserCheck className="w-5 h-5 text-amber-400" />
                          </div>
                          <div>
                            <h3 className="font-bold">Đổi vai trò</h3>
                            <p className="text-xs text-muted-foreground">
                              {modalUser.name} · Hiện tại:{" "}
                              <span className="font-bold capitalize">
                                {modalUser.role}
                              </span>
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => setActiveModal(null)}
                          className="p-1.5 rounded-lg hover:bg-secondary"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="p-5 space-y-2">
                        {roles.map((r) => {
                          const isActive = modalUser.role === r.key;
                          return (
                            <button
                              key={r.key}
                              onClick={async () => {
                                if (isActive) return;
                                try {
                                  await adminApi.changeRole(
                                    modalUser.id,
                                    r.key,
                                  );
                                  onRoleChange(modalUser.id, r.key); // realtime update
                                  toast.success(
                                    `Đã đổi vai trò ${modalUser.name} thành ${r.label}`,
                                  );
                                  setActiveModal(null);
                                } catch (err: any) {
                                  toast.error(
                                    err.message || "Không thể đổi vai trò",
                                  );
                                }
                              }}
                              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
                                isActive
                                  ? "border-primary bg-primary/5"
                                  : "border-border/50 bg-secondary/30 hover:border-border hover:bg-secondary/50 cursor-pointer"
                              }`}
                            >
                              <div
                                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${r.color}`}
                              >
                                <r.icon className="w-5 h-5" />
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-bold">{r.label}</p>
                                  {isActive && (
                                    <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                                      Hiện tại
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {r.desc}
                                </p>
                              </div>
                              <div
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                  isActive
                                    ? "border-primary bg-primary"
                                    : "border-border"
                                }`}
                              >
                                {isActive && (
                                  <Check className="w-3 h-3 text-primary-foreground" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="p-4 border-t border-border flex gap-2 justify-end">
                        <button
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
                        >
                          Hủy
                        </button>
                        <button
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 transition-colors"
                        >
                          Xác nhận
                        </button>
                      </div>
                    </>
                  );
                })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ===================== MANGA SECTION =====================
const MangaSection = ({
  search,
  setSearch,
  showConfirm,
}: {
  search: string;
  setSearch: (s: string) => void;
  showConfirm: Function;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const currentUserRole = useUserStore((s) => s.user?.role || "reader");
  const canManageManga = currentUserRole === "admin";
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [mangaList, setMangaList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [bulkHideLoading, setBulkHideLoading] = useState(false);
  const [source, setSource] = useState<"db" | "otruyen" | "mangadex" | "uploaded">("db");
  const [filterHidden, setFilterHidden] = useState<"" | "hidden" | "visible">("");
  const [sortBy, setSortBy] = useState<"default" | "title" | "views">("default");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [hideModal, setHideModal] = useState<{ slug: string; title: string } | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [notesModal, setNotesModal] = useState<{ slug: string; title: string; current: string } | null>(null);
  const [notesValue, setNotesValue] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState("");
  const LIMIT = 30;
  const totalPages = Math.ceil(total / LIMIT);

  const notifyHomepageRealtimeUpdate = useCallback((reason: string) => {
    queryClient.invalidateQueries({ queryKey: ["manga", "home"] });
    queryClient.invalidateQueries({ queryKey: ["manga", "homepage"] });
    queryClient.invalidateQueries({ queryKey: ["manga", "homepage", "combined"] });
    queryClient.invalidateQueries({ queryKey: ["manga", "featured"] });
    emitHomepageRefresh(reason);
  }, [queryClient]);

  const loadManga = useCallback(async (p = 1, q = search, fh = filterHidden, src = source) => {
    setLoading(true);
    try {
      const d = await adminApi.getMangaList(p, q || undefined, fh || undefined, src);
      setPermissionDeniedMessage("");
      setMangaList(d.manga || []);
      setTotal(d.total || 0);
      setPage(p);
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        const detail = getErrorMessage(err) || "Không có quyền truy cập";
        setPermissionDeniedMessage(detail);
        setMangaList([]);
        setTotal(0);
      }
    } finally { setLoading(false); }
  }, [search, filterHidden, source]);

  const toggleSort = useCallback((field: "title" | "views") => {
    setSortBy((prev) => {
      if (prev === field) {
        setSortDirection((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDirection(field === "title" ? "asc" : "desc");
      return field;
    });
  }, []);

  const parseViews = useCallback((item: any) => {
    const candidates = [item?.views, item?.view_count, item?.view, item?.total_views];
    for (const raw of candidates) {
      if (raw === null || raw === undefined) continue;
      if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw));
      const text = String(raw).trim();
      if (!text) continue;
      const normalized = text.replace(/,/g, "");
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
    }
    return 0;
  }, []);

  const sortedMangaList = useMemo(() => {
    const rows = [...mangaList];
    if (sortBy === "title") {
      rows.sort((a, b) => {
        const aTitle = String(a?.title || a?.slug || "");
        const bTitle = String(b?.title || b?.slug || "");
        const cmp = aTitle.localeCompare(bTitle, "vi", { sensitivity: "base" });
        return sortDirection === "asc" ? cmp : -cmp;
      });
    } else if (sortBy === "views") {
      rows.sort((a, b) => {
        const cmp = parseViews(a) - parseViews(b);
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [mangaList, parseViews, sortBy, sortDirection]);

  const sortSelectValue = sortBy === "default" ? "default" : `${sortBy}:${sortDirection}`;
  const handleSortSelectChange = useCallback((value: string) => {
    if (value === "default") {
      setSortBy("default");
      setSortDirection("desc");
      return;
    }

    const [field, direction] = value.split(":");
    if ((field === "title" || field === "views") && (direction === "asc" || direction === "desc")) {
      setSortBy(field);
      setSortDirection(direction);
    }
  }, []);

  const sourceLabel = source === "mangadex" ? "MangaDex" : source === "otruyen" ? "OTruyen" : source;
  const canBulkHideBySource = canManageManga && (source === "mangadex" || source === "otruyen");
  const bulkHideCandidates = useMemo(
    () => mangaList.filter((m) => m.source === source && !m.is_hidden),
    [mangaList, source]
  );

  useEffect(() => {
    if (permissionDeniedMessage) return;
    loadManga(1, search, filterHidden, source);
  }, [search, filterHidden, source, loadManga, permissionDeniedMessage]);

  const hideAllByCurrentSource = useCallback(async () => {
    if (!canBulkHideBySource) {
      toast.info("Chỉ hỗ trợ ẩn hàng loạt cho MangaDex hoặc OTruyen");
      return;
    }

    const targets = mangaList.filter((m) => m.source === source && !m.is_hidden);
    if (targets.length === 0) {
      toast.info(`Không có truyện ${sourceLabel} nào cần ẩn`);
      return;
    }

    const reason = `Ẩn hàng loạt nguồn ${sourceLabel}`;
    setBulkHideLoading(true);
    try {
      const results = await Promise.allSettled(
        targets.map((m) => adminApi.hideManga(m.slug, reason))
      );
      const successCount = results.filter((r) => r.status === "fulfilled").length;

      if (successCount > 0) {
        const targetSlugs = new Set(targets.map((m) => m.slug));
        setMangaList((prev) =>
          prev.map((m) =>
            targetSlugs.has(m.slug)
              ? { ...m, is_hidden: true, hidden_reason: reason }
              : m
          )
        );
        toast.success(`Đã ẩn ${successCount}/${targets.length} truyện ${sourceLabel}`);
      }
      if (successCount < targets.length) {
        toast.error("Một số truyện ẩn thất bại, vui lòng thử lại");
      }
    } finally {
      setBulkHideLoading(false);
      await loadManga(page, search, filterHidden, source);
    }
  }, [canBulkHideBySource, filterHidden, loadManga, mangaList, page, search, source, sourceLabel]);

  const requestHideAllBySource = useCallback(() => {
    if (!canBulkHideBySource) {
      toast.info("Chỉ hỗ trợ ẩn hàng loạt cho MangaDex hoặc OTruyen");
      return;
    }
    if (bulkHideCandidates.length === 0) {
      toast.info(`Không có truyện ${sourceLabel} nào cần ẩn`);
      return;
    }

    showConfirm(
      `Ẩn hết truyện ${sourceLabel}`,
      `Sẽ ẩn ${bulkHideCandidates.length} truyện ${sourceLabel} trong trang hiện tại. Tiếp tục?`,
      () => {
        void hideAllByCurrentSource();
      },
      true,
    );
  }, [bulkHideCandidates.length, canBulkHideBySource, hideAllByCurrentSource, showConfirm, sourceLabel]);

  useEffect(() => {
    if (isMobile) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase() || "";
      const isTyping = !!target && (
        target.isContentEditable ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select"
      );
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (key === "n") {
        event.preventDefault();
        toggleSort("title");
      } else if (key === "v") {
        event.preventDefault();
        toggleSort("views");
      } else if (key === "r") {
        event.preventDefault();
        void loadManga(page, search, filterHidden, source);
      } else if (key === "h") {
        event.preventDefault();
        if (canManageManga) {
          requestHideAllBySource();
        }
      } else if (key === "[") {
        event.preventDefault();
        if (page > 1) void loadManga(page - 1, search, filterHidden, source);
      } else if (key === "]") {
        event.preventDefault();
        if (page < totalPages) void loadManga(page + 1, search, filterHidden, source);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canManageManga, filterHidden, isMobile, loadManga, page, requestHideAllBySource, search, source, toggleSort, totalPages]);

  const toggleHide = async (m: any) => {
    if (!canManageManga) {
      toast.error("Moderator chỉ có quyền xem tab Truyện");
      return;
    }
    if (m.is_hidden) {
      setActionLoading(m.slug);
      try {
        await adminApi.showManga(m.slug);
        toast.success(`Đã hiện lại "${m.title || m.slug}"`);
        setMangaList(prev => prev.map(x => x.slug === m.slug ? { ...x, is_hidden: false, hidden_reason: null } : x));
        notifyHomepageRealtimeUpdate("admin-show-manga");
      } catch { toast.error("Thao tác thất bại"); } finally { setActionLoading(null); }
    } else {
      setHideReason("");
      setHideModal({ slug: m.slug, title: m.title || m.slug });
    }
  };

  const confirmHide = async () => {
    if (!canManageManga) {
      toast.error("Moderator chỉ có quyền xem tab Truyện");
      return;
    }
    if (!hideModal) return;
    setActionLoading(hideModal.slug);
    try {
      await adminApi.hideManga(hideModal.slug, hideReason);
      toast.success(`Đã ẩn "${hideModal.title}"`);
      setMangaList(prev => prev.map(x => x.slug === hideModal.slug ? { ...x, is_hidden: true, hidden_reason: hideReason } : x));
      notifyHomepageRealtimeUpdate("admin-hide-manga");
    } catch { toast.error("Thao tác thất bại"); } finally {
      setActionLoading(null);
      setHideModal(null);
    }
  };

  const toggleFeatured = async (m: any) => {
    if (!canManageManga) {
      toast.error("Moderator chỉ có quyền xem tab Truyện");
      return;
    }
    setActionLoading(m.slug);
    try {
      await adminApi.updateMangaSettings(m.slug, { is_featured: !m.is_featured });
      toast.success(m.is_featured ? "Đã bỏ ghim" : "Đã ghim nổi bật");
      setMangaList(prev => prev.map(x => x.slug === m.slug ? { ...x, is_featured: !x.is_featured } : x));
      notifyHomepageRealtimeUpdate("admin-toggle-featured");
    } catch { toast.error("Thao tác thất bại"); } finally { setActionLoading(null); }
  };

  const saveNotes = async () => {
    if (!canManageManga) {
      toast.error("Moderator chỉ có quyền xem tab Truyện");
      return;
    }
    if (!notesModal) return;
    setActionLoading(notesModal.slug);
    try {
      await adminApi.updateMangaSettings(notesModal.slug, { admin_notes: notesValue });
      toast.success("Đã lưu ghi chú");
      setMangaList(prev => prev.map(x => x.slug === notesModal.slug ? { ...x, admin_notes: notesValue } : x));
      notifyHomepageRealtimeUpdate("admin-update-notes");
    } catch { toast.error("Lưu thất bại"); } finally {
      setActionLoading(null);
      setNotesModal(null);
    }
  };

  if (permissionDeniedMessage) {
    return (
      <PermissionDeniedPanel
        title="Truyện"
        message={permissionDeniedMessage}
        onRetry={() => {
          setPermissionDeniedMessage("");
          void loadManga(1, search, filterHidden, source);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Quản lý truyện</h1>
          <p className="text-sm text-muted-foreground">{total.toLocaleString()} truyện trong hệ thống</p>
          {!canManageManga && (
            <p className="text-xs text-amber-300 mt-1">
              Moderator có quyền xem toàn bộ danh sách truyện. Thao tác ẩn/ghim/ghi chú chỉ dành cho admin.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canBulkHideBySource && (
            <button
              onClick={requestHideAllBySource}
              disabled={bulkHideLoading || bulkHideCandidates.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold transition-colors"
              title={`Ẩn hết truyện nguồn ${sourceLabel} trong trang hiện tại`}
            >
              <EyeOff className="w-3.5 h-3.5" />
              {bulkHideLoading ? "Đang ẩn..." : `Ẩn hết ${sourceLabel}`}
            </button>
          )}
          <button
            onClick={() => loadManga(page)}
            className="p-2 rounded-xl hover:bg-secondary transition-colors text-muted-foreground"
            title="Tải lại (R)"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Source tabs */}
      <div className="flex gap-1 bg-secondary/30 p-1 rounded-xl overflow-x-auto">
        {([
          { key: "db",       label: "Đã xem",   color: "text-purple-400" },
          { key: "otruyen",  label: "OTruyen",  color: "text-orange-400" },
          { key: "mangadex", label: "MangaDex", color: "text-blue-400" },
          { key: "uploaded", label: "Upload",   color: "text-emerald-400" },
        ] as const).map(s => (
          <button
            key={s.key}
            onClick={() => { setSource(s.key); setPage(1); }}
            className={`flex-none px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              source === s.key
                ? `bg-card shadow ${s.color}`
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={search}
            onChange={e => { setSearch(e.target.value); }}
            placeholder={
              source === "mangadex" ? "Tìm truyện MangaDex (mặc định: tất cả có bản VI)..." :
              source === "otruyen"  ? "Tìm trên OTruyen..." :
              source === "uploaded" ? "Tìm theo tên / slug upload..." :
              "Tìm theo slug / tên truyện đã đọc..."
            }

            className="w-full pl-9 pr-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <select
          value={filterHidden}
          onChange={e => setFilterHidden(e.target.value as any)}
          className="bg-secondary border border-border rounded-xl px-3 py-2 text-xs font-bold focus:outline-none"
        >
          <option value="">Tất cả</option>
          <option value="visible">Đang hiển thị</option>
          <option value="hidden">Đang ẩn</option>
        </select>
        <select
          value={sortSelectValue}
          onChange={(e) => handleSortSelectChange(e.target.value)}
          className="bg-secondary border border-border rounded-xl px-3 py-2 text-xs font-bold focus:outline-none"
          title="Sắp xếp"
        >
          <option value="default">Sắp xếp mặc định</option>
          <option value="title:asc">Tên A-Z</option>
          <option value="title:desc">Tên Z-A</option>
          <option value="views:desc">Views giảm dần</option>
          <option value="views:asc">Views tăng dần</option>
        </select>
      </div>

      {!isMobile && (
        <p className="text-[11px] text-muted-foreground">
          {canManageManga
            ? "Phím tắt: / tìm kiếm, N sort tên, V sort views, R tải lại, H ẩn hết theo nguồn, [ ] chuyển trang."
            : "Phím tắt: / tìm kiếm, N sort tên, V sort views, R tải lại, [ ] chuyển trang."}
        </p>
      )}

      {/* Table */}
      <div className="bg-card border border-border rounded-xl">
        <div className="overflow-x-auto rounded-xl">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground">
                  <button
                    onClick={() => toggleSort("title")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                    title="Sort theo tên (N)"
                  >
                    Truyện
                    <ArrowUpDown className="w-3 h-3" />
                    {sortBy === "title" && (
                      <span className="text-[10px] text-primary">{sortDirection === "asc" ? "A-Z" : "Z-A"}</span>
                    )}
                  </button>
                </th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden sm:table-cell">Nguồn</th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden md:table-cell">
                  <button
                    onClick={() => toggleSort("views")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                    title="Sort theo views (V)"
                  >
                    Views
                    <ArrowUpDown className="w-3 h-3" />
                    {sortBy === "views" && (
                      <span className="text-[10px] text-primary">{sortDirection === "asc" ? "ASC" : "DESC"}</span>
                    )}
                  </button>
                </th>
                <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground">Trạng thái</th>
                <th className="text-right px-4 py-3 text-xs font-bold text-muted-foreground">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="text-center py-12 text-muted-foreground text-sm">Đang tải...</td></tr>
              ) : sortedMangaList.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-12 text-muted-foreground text-sm">Không có dữ liệu</td></tr>
              ) : sortedMangaList.map(m => (
                <tr key={m.slug} className={`border-b border-border/40 hover:bg-secondary/30 transition-colors ${m.is_hidden ? "opacity-60" : ""}`}>
                  {/* Title */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {m.is_featured && <PinIcon className="w-3 h-3 text-yellow-400 flex-shrink-0" />}
                      <div className="min-w-0">
                        {(() => {
                          const slugText = String(m.slug || "").trim();
                          const titleText = String(m.title || "").trim();
                          const normalizedSlug = slugText.toLowerCase();
                          const normalizedTitle = titleText.toLowerCase();
                          const hasResolvedTitle = !!titleText && normalizedTitle !== normalizedSlug;
                          return (
                            <>
                              <p className="text-sm font-semibold line-clamp-1" title={slugText}>
                                {hasResolvedTitle ? titleText : slugText}
                              </p>
                              {!hasResolvedTitle && (
                                <p className="text-[10px] text-muted-foreground font-mono">{slugText}</p>
                              )}
                            </>
                          );
                        })()}
                        <p className="text-[10px] text-muted-foreground md:hidden">{parseViews(m).toLocaleString()} views</p>
                      </div>
                    </div>
                  </td>
                  {/* Source badge per row */}
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      m.source === "uploaded"  ? "bg-emerald-500/15 text-emerald-400" :
                      m.source === "otruyen"   ? "bg-orange-500/15 text-orange-400" :
                      m.source === "mangadex"  ? "bg-blue-500/15 text-blue-400" :
                                                "bg-purple-500/15 text-purple-400"
                    }`}>
                      {m.source === "uploaded" ? "Upload" :
                       m.source === "otruyen"  ? "OTruyen" :
                       m.source === "mangadex" ? "MangaDex" : "External"}
                    </span>
                  </td>
                  {/* Views */}
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                    {parseViews(m).toLocaleString()}
                  </td>
                  {/* Status */}
                  <td className="px-4 py-3">
                    {m.is_hidden ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">
                        <EyeOff className="w-2.5 h-2.5" /> Ẩn
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
                        <Eye className="w-2.5 h-2.5" /> Hiện
                      </span>
                    )}
                  </td>
                  {/* Actions — inline icon buttons, no dropdown to avoid overflow clipping */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {/* View in new tab */}
                      <a
                        href={getMangaDetailPath(m.id || m._id || m.slug)}
                        target="_blank"
                        rel="noreferrer"
                        title="Xem trang truyện"
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-blue-400 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>

                      {canManageManga && (
                        <>
                          {/* Hide / Show */}
                          <button
                            disabled={actionLoading === m.slug}
                            title={m.is_hidden ? "Hiện truyện" : "Ẩn truyện"}
                            onClick={() => toggleHide(m)}
                            className={`p-1.5 rounded-lg hover:bg-secondary transition-colors disabled:opacity-40 ${
                              m.is_hidden ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground hover:text-red-400"
                            }`}
                          >
                            {m.is_hidden
                              ? <Eye className="w-3.5 h-3.5" />
                              : <EyeOff className="w-3.5 h-3.5" />}
                          </button>

                          {/* Feature / Pin */}
                          <button
                            disabled={actionLoading === m.slug}
                            title={m.is_featured ? "Bỏ ghim" : "Ghim nổi bật"}
                            onClick={() => toggleFeatured(m)}
                            className={`p-1.5 rounded-lg hover:bg-secondary transition-colors disabled:opacity-40 ${
                              m.is_featured ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"
                            }`}
                          >
                            <PinIcon className="w-3.5 h-3.5" />
                          </button>

                          {/* Admin notes */}
                          <button
                            title="Ghi chú admin"
                            onClick={() => { setNotesValue(m.admin_notes || ""); setNotesModal({ slug: m.slug, title: m.title || m.slug, current: m.admin_notes || "" }); }}
                            className={`p-1.5 rounded-lg hover:bg-secondary transition-colors ${
                              m.admin_notes ? "text-primary" : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <StickyNote className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1 p-3 border-t border-border/50">
            <button disabled={page <= 1} onClick={() => loadManga(page - 1)} className="px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-secondary disabled:opacity-30 transition-colors">« Trước</button>
            <span className="px-3 py-1.5 text-xs text-muted-foreground">Trang {page}/{totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => loadManga(page + 1)} className="px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-secondary disabled:opacity-30 transition-colors">Sau »</button>
          </div>
        )}
      </div>

      {/* ===== HIDE MODAL ===== */}
      <AnimatePresence>
        {hideModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setHideModal(null)}
          >
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
              onClick={e => e.stopPropagation()}
              className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl"
            >
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-5 h-5 text-red-400" />
                  <h3 className="font-bold">Ẩn truyện</h3>
                </div>
                <button onClick={() => setHideModal(null)} className="p-1.5 rounded-lg hover:bg-secondary"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-muted-foreground">Truyện <strong className="text-foreground">{hideModal.title}</strong> sẽ bị ẩn khỏi tất cả người dùng.</p>
                <div>
                  <label className="text-xs font-bold text-muted-foreground mb-1.5 block">Lý do ẩn (không bắt buộc)</label>
                  <textarea
                    value={hideReason}
                    onChange={e => setHideReason(e.target.value)}
                    rows={3}
                    placeholder="Vi phạm bản quyền, nội dung không phù hợp..."
                    className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                </div>
              </div>
              <div className="p-4 border-t border-border flex gap-2 justify-end">
                <button onClick={() => setHideModal(null)} className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors">Hủy</button>
                <button
                  onClick={confirmHide}
                  disabled={actionLoading === hideModal.slug}
                  className="px-4 py-2 rounded-xl bg-red-500 text-white text-xs font-bold hover:bg-red-600 transition-colors disabled:opacity-50"
                >
                  {actionLoading === hideModal.slug ? "Đang xử lý..." : "Xác nhận ẩn"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== NOTES MODAL ===== */}
      <AnimatePresence>
        {notesModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setNotesModal(null)}
          >
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
              onClick={e => e.stopPropagation()}
              className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl"
            >
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StickyNote className="w-5 h-5 text-primary" />
                  <h3 className="font-bold">Ghi chú admin</h3>
                </div>
                <button onClick={() => setNotesModal(null)} className="p-1.5 rounded-lg hover:bg-secondary"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-5">
                <p className="text-xs text-muted-foreground mb-3">{notesModal.title}</p>
                <textarea
                  value={notesValue}
                  onChange={e => setNotesValue(e.target.value)}
                  rows={5}
                  placeholder="Ghi chú nội bộ cho admin..."
                  className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              </div>
              <div className="p-4 border-t border-border flex gap-2 justify-end">
                <button onClick={() => setNotesModal(null)} className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors">Hủy</button>
                <button
                  onClick={saveNotes}
                  disabled={actionLoading === notesModal.slug}
                  className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/80 transition-colors disabled:opacity-50"
                >
                  {actionLoading === notesModal.slug ? "Đang lưu..." : "Lưu ghi chú"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ===================== CHAPTERS SECTION =====================
const ChaptersSection = ({
  actions,
  onAction,
  selected,
  setSelected,
  onBulk,
  uploads,
  onDelete,
  onHide,
}: {
  actions: Record<string, "approve" | "reject">;
  onAction: (id: string, a: "approve" | "reject") => void;
  selected: string[];
  setSelected: (s: string[]) => void;
  onBulk: (a: "approve" | "reject") => void;
  uploads: any[];
  onDelete: (id: string) => void;
  onHide: (id: string) => void;
}) => {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "published" | "rejected" | "draft"
  >("all");

  const filtered = useMemo(() => {
    if (statusFilter === "all") return uploads;
    return uploads.filter((u: any) => u.status === statusFilter);
  }, [statusFilter, uploads]);

  const toggleSelect = (id: string) => {
    setSelected(
      selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id],
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Quản lý Chapters</h1>
        <p className="text-sm text-muted-foreground">
          {uploads.length} chapters • {" "}
          {uploads.filter((u: any) => u.status === "pending").length} chờ duyệt
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-between">
        <div className="flex gap-1 bg-secondary/30 p-1 rounded-lg flex-wrap">
          {(["all", "pending", "published", "rejected", "draft"] as const).map(
            (s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${statusFilter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {s === "all"
                  ? "Tất cả"
                  : s === "pending"
                    ? "Chờ duyệt"
                    : s === "published"
                      ? "Đã xuất bản"
                      : s === "rejected"
                        ? "Từ chối"
                        : "Nháp"}
              </button>
            ),
          )}
        </div>

        {selected.length > 0 && (
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground">
              {selected.length} đã chọn
            </span>
            <button
              onClick={() => onBulk("approve")}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-400/10 text-green-400 text-xs font-bold hover:bg-green-400/20 transition-colors"
            >
              <Check className="w-3 h-3" />
              Duyệt tất cả
            </button>
            <button
              onClick={() => onBulk("reject")}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-400/10 text-red-400 text-xs font-bold hover:bg-red-400/20 transition-colors"
            >
              <X className="w-3 h-3" />
              Từ chối tất cả
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            Không có chapter nào.
          </div>
        )}
        {filtered.map((upload) => {
          const action = actions[upload.id];
          const status = action || upload.status;
          const uploaderDisplay = upload.profiles?.display_name || upload.profiles?.username || upload.uploaderName || "—";
          const mangaTitle = upload.manga_title || upload.mangaTitle || "—";
          const chapterNum = upload.chapter_number ?? upload.chapterNumber ?? "?";
          const chapterTitle = upload.chapter_title || upload.chapterTitle || "";
          const lang = upload.language || "vi";
          const pageCount = Array.isArray(upload.pages) ? upload.pages.length : 0;
          const createdAt = upload.created_at ? new Date(upload.created_at).toLocaleString("vi") : "";

          return (
            <motion.div
              key={upload.id}
              layout
              className={`bg-card border rounded-xl p-4 transition-colors ${
                action === "approve"
                  ? "border-green-500/50 bg-green-500/5"
                  : action === "reject"
                    ? "border-red-500/50 bg-red-500/5"
                    : selected.includes(upload.id)
                      ? "border-primary/50"
                      : "border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                {upload.status === "pending" && !action && (
                  <input
                    type="checkbox"
                    checked={selected.includes(upload.id)}
                    onChange={() => toggleSelect(upload.id)}
                    className="mt-1 rounded border-border"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-sm">{mangaTitle}</h3>
                    <StatusBadge status={status} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Ch.{chapterNum}{chapterTitle ? ` – ${chapterTitle}` : ""}
                  </p>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-[10px] text-muted-foreground">{uploaderDisplay}</span>
                    <span className="text-[10px] text-muted-foreground">{lang.toUpperCase()}</span>
                    <span className="text-[10px] text-muted-foreground">{pageCount} trang</span>
                    {createdAt && (
                      <span className="text-[10px] text-muted-foreground">{createdAt}</span>
                    )}
                  </div>
                  {upload.rejectionReason && (
                    <p className="text-[10px] text-red-400 mt-1">
                      Lý do: {upload.rejectionReason}
                    </p>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex gap-1 shrink-0 items-center">
                  <button
                    onClick={() => navigate(`/admin/review/${upload.id}`)}
                    className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                    title="Xem"
                  >
                    <Eye className="w-4 h-4" />
                  </button>

                  {!action && upload.status === "pending" && (
                    <>
                      <button
                        onClick={() => onAction(upload.id, "approve")}
                        className="p-1.5 rounded-lg hover:bg-green-400/10 text-muted-foreground hover:text-green-400 transition-colors"
                        title="Duyệt"
                      >
                        <CheckCircle className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onAction(upload.id, "reject")}
                        className="p-1.5 rounded-lg hover:bg-red-400/10 text-muted-foreground hover:text-red-400 transition-colors"
                        title="Từ chối"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </>
                  )}

                  {upload.status === "published" && !action && (
                    <button
                      onClick={() => onHide(upload.id)}
                      className="p-1.5 rounded-lg hover:bg-amber-400/10 text-muted-foreground hover:text-amber-400 transition-colors"
                      title="Ẩn chapter"
                    >
                      <EyeOff className="w-4 h-4" />
                    </button>
                  )}

                  {!action && (
                    <button
                      onClick={() => onDelete(upload.id)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                      title="Xóa"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}

                  {action && (
                    <span
                      className={`text-xs font-bold ml-1 ${action === "approve" ? "text-green-400" : "text-red-400"}`}
                    >
                      {action === "approve" ? "✓ Đã duyệt" : "✗ Đã từ chối"}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};

// ===================== REPORTS SECTION =====================
const ReportsSection = ({
  reports,
  filter,
  setFilter,
  actions,
  setActions,
  showConfirm,
  auditLog,
}: {
  reports: any[];
  filter: string;
  setFilter: (f: any) => void;
  actions: Record<string, string>;
  setActions: (a: any) => void;
  showConfirm: Function;
  auditLog: any[];
}) => {
  const typeFilters = [
    { key: "all", label: "Tất cả" },
    { key: "chapter", label: "Chapter" },
    { key: "comment", label: "Comment" },
    { key: "manga", label: "Manga" },
    { key: "user", label: "User" },
  ];
  const typeIcons: Record<string, any> = {
    chapter: Layers,
    comment: MessageSquare,
    manga: BookOpen,
    user: Users,
  };
  const [menuReportId, setMenuReportId] = useState<string | null>(null);
  const [processingReportId, setProcessingReportId] = useState<string | null>(
    null,
  );

  const markReport = async (reportId: string, status: string, note?: string) => {
    await adminApi.updateReport(reportId, status, note);
    setActions((prev: any) => ({
      ...prev,
      [reportId]: status,
    }));
  };

  const handleModeration = async (
    report: any,
    action: "resolve" | "delete_comment" | "delete_comment_ban_user" | "ban_user",
  ) => {
    setMenuReportId(null);
    setProcessingReportId(report.id);
    try {
      if (action === "resolve") {
        await markReport(report.id, "resolved");
        toast.success("Đã đánh dấu report là đã xử lý");
        return;
      }

      if (action === "delete_comment") {
        await adminApi.deleteComment(String(report.target || ""));
        await markReport(
          report.id,
          "resolved",
          "Đã xóa bình luận vi phạm từ báo cáo",
        );
        toast.success("Đã xóa bình luận và xử lý report");
        return;
      }

      if (action === "delete_comment_ban_user") {
        const commentId = String(report.target || "").trim();
        if (!commentId) {
          throw new Error("Thiếu mã bình luận");
        }
        const detail = await adminApi.getCommentById(commentId);
        const userId = String(detail?.comment?.user_id || "").trim();
        if (!userId) {
          throw new Error("Không tìm thấy người dùng của bình luận");
        }
        await adminApi.deleteComment(commentId);
        await adminApi.banUser(
          userId,
          `Vi phạm bình luận (${report.violationType || "không xác định"})`,
        );
        await markReport(
          report.id,
          "resolved",
          "Đã xóa bình luận và ban người dùng vi phạm",
        );
        toast.success("Đã xóa bình luận, ban người dùng và xử lý report");
        return;
      }

      if (action === "ban_user") {
        const userId = String(report.target || "").trim();
        if (!userId) {
          throw new Error("Thiếu mã người dùng");
        }
        await adminApi.banUser(
          userId,
          `Bị ban từ báo cáo (${report.violationType || "không xác định"})`,
        );
        await markReport(report.id, "resolved", "Đã ban người dùng theo báo cáo");
        toast.success("Đã ban người dùng và xử lý report");
      }
    } catch (error: any) {
      toast.error(error?.message || "Không thể thực hiện hành động kiểm duyệt");
    } finally {
      setProcessingReportId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Báo cáo & Kiểm duyệt</h1>
        <p className="text-sm text-muted-foreground">
          {reports.filter((r: any) => r.status === "pending").length} báo cáo
          chờ xử lý
        </p>
      </div>

      <div className="flex gap-1 bg-secondary/30 p-1 rounded-lg w-fit flex-wrap">
        {typeFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${filter === f.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {reports.map((report) => {
          const TypeIcon = typeIcons[report.type] || Flag;
          const acted = actions[report.id];
          return (
            <div
              key={report.id}
              className={`bg-card border rounded-xl p-4 transition-colors ${acted ? "border-green-500/30 opacity-60" : "border-border"}`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`p-2 rounded-lg ${report.priority === "high" ? "bg-red-400/10" : report.priority === "medium" ? "bg-yellow-400/10" : "bg-secondary"}`}
                >
                  <TypeIcon
                    className={`w-4 h-4 ${report.priority === "high" ? "text-red-400" : report.priority === "medium" ? "text-yellow-400" : "text-muted-foreground"}`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-bold">{report.target}</p>
                    <PriorityBadge priority={report.priority} />
                    <StatusBadge status={report.status} />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Loại vi phạm: {report.violationType}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Lý do: {report.reason}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Báo cáo bởi {report.reporter} • {report.createdAt}
                  </p>
                </div>
                {!acted && report.status === "pending" && (
                  <div className="relative flex gap-1 shrink-0">
                    <button
                      onClick={() =>
                        setMenuReportId((prev) =>
                          prev === report.id ? null : report.id,
                        )
                      }
                      disabled={processingReportId === report.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-green-400/10 text-green-400 text-xs font-bold hover:bg-green-400/20 transition-colors"
                    >
                      <Check className="w-3 h-3" />
                      Xử lý
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {menuReportId === report.id && (
                      <div className="absolute right-0 top-9 z-20 w-56 bg-card border border-border rounded-lg shadow-xl p-1 space-y-1">
                        <button
                          onClick={() => handleModeration(report, "resolve")}
                          className="w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-secondary transition-colors"
                        >
                          Đánh dấu đã xử lý
                        </button>
                        {report.type === "comment" && (
                          <button
                            onClick={() =>
                              handleModeration(report, "delete_comment")
                            }
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-secondary transition-colors flex items-center gap-1"
                          >
                            <Trash2 className="w-3 h-3" />
                            Xóa bình luận
                          </button>
                        )}
                        {report.type === "comment" && (
                          <button
                            onClick={() =>
                              handleModeration(report, "delete_comment_ban_user")
                            }
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-secondary transition-colors flex items-center gap-1 text-destructive"
                          >
                            <Ban className="w-3 h-3" />
                            Xóa bình luận + Ban người dùng
                          </button>
                        )}
                        {report.type === "user" && (
                          <button
                            onClick={() => handleModeration(report, "ban_user")}
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-secondary transition-colors flex items-center gap-1 text-destructive"
                          >
                            <Ban className="w-3 h-3" />
                            Ban người dùng bị báo cáo
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      onClick={async () => {
                        try {
                          await adminApi.updateReport(report.id, "dismissed");
                          setActions((prev: any) => ({
                            ...prev,
                            [report.id]: "dismissed",
                          }));
                        } catch {}
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors"
                    >
                      <X className="w-3 h-3" />
                      Bỏ qua
                    </button>
                  </div>
                )}
                {acted && (
                  <span className="text-[10px] text-green-400 font-bold">
                    Đã xử lý
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Audit Log */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-bold mb-3">Nhật ký hành động</h3>
        <div className="space-y-2">
          {(auditLog || []).slice(0, 10).map((log: any) => (
            <div
              key={log.id}
              className="flex items-center gap-3 p-2 hover:bg-secondary/30 rounded-lg transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
                {(log.admin_name || "A")[0]}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs">
                  <span className="font-medium">
                    {log.admin_name || "Admin"}
                  </span>{" "}
                  <span className="text-muted-foreground">{log.action}</span>:{" "}
                  <span className="text-muted-foreground">{log.target}</span>
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {log.created_at
                    ? new Date(log.created_at).toLocaleString("vi")
                    : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ===================== ANALYTICS SECTION =====================
const AnalyticsSection = ({
  stats,
  analytics,
}: {
  stats: any;
  analytics: any;
}) => {
  const monthLabels = analytics?.month_labels || [];
  const monthlyViews = analytics?.monthly_views || [];
  const monthlyUserGrowth = analytics?.monthly_new_users || [];
  const topManga = analytics?.top_manga || [];
  const completionRates = topManga.map((m: any) =>
    Number(m.completion_rate || 0),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Thống kê & Phân tích</h1>
        <p className="text-sm text-muted-foreground">
          Dữ liệu chi tiết về hoạt động site
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Users}
          label="Tổng người dùng"
          value={stats?.total_users ?? "—"}
          color="text-blue-400"
        />
        <StatCard
          icon={Activity}
          label="Đang đọc"
          value={stats?.active_readers ?? "—"}
          color="text-green-400"
        />
        <StatCard
          icon={BookOpen}
          label="Tổng truyện"
          value={stats?.total_manga ?? "—"}
          color="text-primary"
        />
        <StatCard
          icon={Eye}
          label="Views hôm nay"
          value={analytics?.views_today ?? "—"}
          color="text-cyan-400"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold mb-4">Views theo tháng</h3>
          <SimpleBarChart
            data={monthlyViews.length ? monthlyViews : [0]}
            labels={monthLabels.length ? monthLabels : ["T1"]}
          />
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold mb-4">Tăng trưởng người dùng</h3>
          <SimpleBarChart
            data={monthlyUserGrowth.length ? monthlyUserGrowth : [0]}
            labels={monthLabels.length ? monthLabels : ["T1"]}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold mb-3">
            Top truyện được đọc nhiều nhất
          </h3>
          <div className="space-y-2">
            {topManga.map((m, i) => (
              <div key={m.id} className="flex items-center gap-3">
                <span className="text-sm font-bold text-muted-foreground w-5">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{m.title}</p>
                </div>
                <div className="w-24 h-2 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{
                      width: `${topManga[0]?.views ? (m.views / topManga[0].views) * 100 : 0}%`,
                    }}
                    transition={{ delay: i * 0.05 }}
                    className="h-full bg-primary rounded-full"
                  />
                </div>
                <span className="text-[10px] text-muted-foreground w-16 text-right">
                  {Number(m.views || 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold mb-3">Tỷ lệ đọc hoàn thành</h3>
          <div className="space-y-2">
            {topManga.map((m, i) => (
              <div key={m.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{m.title}</p>
                </div>
                <div className="w-20 h-2 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${completionRates[i]}%` }}
                    transition={{ delay: i * 0.05 }}
                    className={`h-full rounded-full ${completionRates[i] > 80 ? "bg-green-400" : completionRates[i] > 60 ? "bg-yellow-400" : "bg-red-400"}`}
                  />
                </div>
                <span className="text-[10px] font-bold w-10 text-right">
                  {completionRates[i]}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ===================== SETTINGS SECTION =====================
const DEFAULT_MAINTENANCE_TITLE_ADMIN = "Website \u0111ang b\u1ea3o tr\u00ec";
const DEFAULT_MAINTENANCE_MESSAGE_ADMIN =
  "MangaHub \u0111ang b\u1ea3o tr\u00ec h\u1ec7 th\u1ed1ng. Vui l\u00f2ng quay l\u1ea1i sau \u00edt ph\u00fat.";
const MAINTENANCE_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const MAINTENANCE_IMAGE_TYPE_RE = /^image\/(png|jpe?g|webp|gif)$/i;

const toDateTimeLocalValue = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19);
};

const fromDateTimeLocalValue = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
};

const formatMaintenanceLocalDateTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
};

const SettingsSection = ({
  onNavigate,
}: {
  onNavigate: (tab: AdminTab) => void;
}) => {
  const currentUserRole = useUserStore((s) => s.user?.role || "reader");
  const isAdmin = currentUserRole === "admin";
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceTitle, setMaintenanceTitle] = useState(DEFAULT_MAINTENANCE_TITLE_ADMIN);
  const [maintenanceMessage, setMaintenanceMessage] = useState(DEFAULT_MAINTENANCE_MESSAGE_ADMIN);
  const [maintenanceImageUrl, setMaintenanceImageUrl] = useState("");
  const [maintenanceStartsAt, setMaintenanceStartsAt] = useState("");
  const [maintenanceEndsAt, setMaintenanceEndsAt] = useState("");
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  const [maintenanceImages, setMaintenanceImages] = useState<Array<{ image_url: string; path?: string; name?: string }>>([]);
  const [maintenanceImagesLoading, setMaintenanceImagesLoading] = useState(false);
  const [maintenanceImageUploading, setMaintenanceImageUploading] = useState(false);
  const [maintenanceImageDeleting, setMaintenanceImageDeleting] = useState("");
  const maintenanceImageInputRef = useRef<HTMLInputElement>(null);
  const [maintenanceEditorOpen, setMaintenanceEditorOpen] = useState(false);
  const [pendingMaintenanceImageFile, setPendingMaintenanceImageFile] = useState<File | null>(null);
  const [pendingMaintenanceImageSrc, setPendingMaintenanceImageSrc] = useState("");

  const loadMaintenanceImages = useCallback(async () => {
    if (!isAdmin) return;
    setMaintenanceImagesLoading(true);
    try {
      const data = await adminApi.getMaintenanceImages();
      setMaintenanceImages(Array.isArray(data?.images) ? data.images : []);
    } catch (error: any) {
      toast.error(error?.message || "Không thể tải lịch sử ảnh bảo trì");
    } finally {
      setMaintenanceImagesLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setMaintenanceLoading(true);
    void loadMaintenanceImages();
    adminApi
      .getMaintenance()
      .then((data) => {
        if (cancelled) return;
        const state = data?.maintenance || {};
        setMaintenanceEnabled(Boolean(state.enabled));
        setMaintenanceTitle(state.title || DEFAULT_MAINTENANCE_TITLE_ADMIN);
        setMaintenanceMessage(state.message || DEFAULT_MAINTENANCE_MESSAGE_ADMIN);
        setMaintenanceImageUrl(state.image_url || "");
        setMaintenanceStartsAt(toDateTimeLocalValue(state.starts_at));
        setMaintenanceEndsAt(toDateTimeLocalValue(state.ends_at));
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error?.message || "Không thể tải trạng thái bảo trì");
        }
      })
      .finally(() => {
        if (!cancelled) setMaintenanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, loadMaintenanceImages]);

  useEffect(() => {
    return () => {
      if (pendingMaintenanceImageSrc) {
        URL.revokeObjectURL(pendingMaintenanceImageSrc);
      }
    };
  }, [pendingMaintenanceImageSrc]);

  const saveMaintenanceMode = async (enabled: boolean) => {
    if (!isAdmin || maintenanceSaving) return;
    setMaintenanceSaving(true);
    try {
      const data = await adminApi.updateMaintenance({
        enabled,
        title: maintenanceTitle,
        message: maintenanceMessage,
        image_url: maintenanceImageUrl,
        starts_at: fromDateTimeLocalValue(maintenanceStartsAt),
        ends_at: fromDateTimeLocalValue(maintenanceEndsAt),
      });
      const state = data?.maintenance || {};
      setMaintenanceEnabled(Boolean(state.enabled));
      setMaintenanceTitle(state.title || maintenanceTitle);
      setMaintenanceMessage(state.message || maintenanceMessage);
      setMaintenanceImageUrl(state.image_url || "");
      setMaintenanceStartsAt(toDateTimeLocalValue(state.starts_at));
      setMaintenanceEndsAt(toDateTimeLocalValue(state.ends_at));
      toast.success(data?.message || (enabled ? "Đã bật bảo trì" : "Đã tắt bảo trì"));
    } catch (error: any) {
      toast.error(error?.message || "Không thể cập nhật chế độ bảo trì");
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const handleMaintenanceImageUpload = async (file?: File | null) => {
    if (!file || maintenanceImageUploading) return;
    setMaintenanceImageUploading(true);
    try {
      const data = await adminApi.uploadMaintenanceImage(file);
      const imageUrl = String(data?.image_url || "");
      if (imageUrl) {
        setMaintenanceImageUrl(imageUrl);
      }
      toast.success(data?.message || "Đã upload ảnh bảo trì");
      await loadMaintenanceImages();
    } catch (error: any) {
      toast.error(error?.message || "Upload ảnh bảo trì thất bại");
    } finally {
      setMaintenanceImageUploading(false);
      if (maintenanceImageInputRef.current) {
        maintenanceImageInputRef.current.value = "";
      }
    }
  };

  const closeMaintenanceImageEditor = useCallback(() => {
    setMaintenanceEditorOpen(false);
    setPendingMaintenanceImageFile(null);
    if (pendingMaintenanceImageSrc) {
      URL.revokeObjectURL(pendingMaintenanceImageSrc);
    }
    setPendingMaintenanceImageSrc("");
    if (maintenanceImageInputRef.current) {
      maintenanceImageInputRef.current.value = "";
    }
  }, [pendingMaintenanceImageSrc]);

  const handleMaintenanceImageSelect = (file?: File | null) => {
    if (!file || maintenanceImageUploading) return;
    const fileType = String(file.type || "");
    const supportedByType = MAINTENANCE_IMAGE_TYPE_RE.test(fileType);
    const supportedByName = MAINTENANCE_IMAGE_EXT_RE.test(file.name || "");
    if (!supportedByType && !supportedByName) {
      toast.error("Chỉ hỗ trợ PNG, JPG, WebP hoặc GIF");
      if (maintenanceImageInputRef.current) {
        maintenanceImageInputRef.current.value = "";
      }
      return;
    }

    if (pendingMaintenanceImageSrc) {
      URL.revokeObjectURL(pendingMaintenanceImageSrc);
    }
    const previewUrl = URL.createObjectURL(file);
    setPendingMaintenanceImageFile(file);
    setPendingMaintenanceImageSrc(previewUrl);
    setMaintenanceEditorOpen(true);
  };

  const handleConfirmMaintenanceImageCrop = async (cropArea: MaintenanceImageCropArea) => {
    if (!pendingMaintenanceImageFile || maintenanceImageUploading) return;
    setMaintenanceImageUploading(true);
    try {
      const data = await adminApi.uploadMaintenanceImage(pendingMaintenanceImageFile, cropArea);
      const imageUrl = String(data?.image_url || "");
      if (imageUrl) {
        setMaintenanceImageUrl(imageUrl);
      }
      toast.success(data?.message || "Đã upload ảnh bảo trì");
      await loadMaintenanceImages();
      closeMaintenanceImageEditor();
    } catch (error: any) {
      toast.error(error?.message || "Upload ảnh bảo trì thất bại");
    } finally {
      setMaintenanceImageUploading(false);
    }
  };

  const handleDeleteMaintenanceImage = async (imageUrl: string) => {
    if (!imageUrl || maintenanceImageDeleting) return;
    setMaintenanceImageDeleting(imageUrl);
    try {
      const data = await adminApi.deleteMaintenanceImage(imageUrl);
      setMaintenanceImages((prev) => prev.filter((item) => item.image_url !== imageUrl));
      if (maintenanceImageUrl === imageUrl) {
        setMaintenanceImageUrl("");
      }
      toast.success(data?.message || "Đã xóa ảnh bảo trì");
    } catch (error: any) {
      toast.error(error?.message || "Không thể xóa ảnh bảo trì");
    } finally {
      setMaintenanceImageDeleting("");
    }
  };

  const workingShortcuts = [
    {
      title: "Thông báo & popup",
      description: "Tạo, sửa, tắt popup home, CTA và banner đã upload.",
      tab: "announcements" as AdminTab,
      icon: Bell,
      accent: "from-cyan-500/20 to-sky-500/5 text-cyan-300",
    },
    {
      title: "Người dùng & quyền",
      description: "Ban, mở ban, đổi role, VIP và xem nhanh tài khoản.",
      tab: "users" as AdminTab,
      icon: Users,
      accent: "from-blue-500/20 to-indigo-500/5 text-blue-300",
    },
    {
      title: "Truyện & hiển thị",
      description: "Ẩn truyện, ghim nổi bật, ghi chú admin và kiểm tra nguồn.",
      tab: "manga" as AdminTab,
      icon: BookOpen,
      accent: "from-emerald-500/20 to-lime-500/5 text-emerald-300",
    },
    {
      title: "Duyệt upload",
      description: "Duyệt chương/truyện người dùng gửi lên.",
      tab: "chapters" as AdminTab,
      icon: Upload,
      accent: "from-amber-500/20 to-orange-500/5 text-amber-300",
    },
    {
      title: "Báo cáo",
      description: "Xử lý report và đánh dấu trạng thái xử lý.",
      tab: "reports" as AdminTab,
      icon: Flag,
      accent: "from-rose-500/20 to-red-500/5 text-rose-300",
    },
    {
      title: "Bình luận",
      description: "Kiểm duyệt và xóa bình luận vi phạm.",
      tab: "comments" as AdminTab,
      icon: MessageSquare,
      accent: "from-violet-500/20 to-purple-500/5 text-violet-300",
    },
  ];

  return (
    <div className="space-y-5">
      <MaintenanceImageEditorModal
        open={maintenanceEditorOpen}
        imageSrc={pendingMaintenanceImageSrc}
        fileName={pendingMaintenanceImageFile?.name}
        fileType={pendingMaintenanceImageFile?.type}
        loading={maintenanceImageUploading}
        onCancel={closeMaintenanceImageEditor}
        onConfirm={handleConfirmMaintenanceImageCrop}
      />
      <div>
        <h1 className="text-2xl font-bold">Cài đặt hệ thống</h1>
      </div>

      <div className={`rounded-2xl border p-4 ${maintenanceEnabled ? "border-red-500/40 bg-red-500/10" : "border-border bg-card"}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Lock className={`h-5 w-5 ${maintenanceEnabled ? "text-red-300" : "text-primary"}`} />
              <h2 className="text-lg font-black">Chế độ bảo trì</h2>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${maintenanceEnabled ? "bg-red-500/20 text-red-200" : "bg-emerald-500/10 text-emerald-300"}`}>
                {maintenanceEnabled ? "Đang bật" : "Đang tắt"}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Khi bật, mọi người trừ admin sẽ bị khóa màn hình và toàn bộ API nghiệp vụ trả 503.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {maintenanceLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Switch
              checked={maintenanceEnabled}
              disabled={!isAdmin || maintenanceLoading || maintenanceSaving}
              onCheckedChange={(checked) => saveMaintenanceMode(checked)}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <label className="space-y-1.5">
            <span className="text-xs font-bold text-muted-foreground">Tiêu đề</span>
            <input
              value={maintenanceTitle}
              onChange={(event) => setMaintenanceTitle(event.target.value)}
              disabled={!isAdmin || maintenanceSaving}
              maxLength={120}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-bold text-muted-foreground">Nội dung thông báo</span>
            <textarea
              value={maintenanceMessage}
              onChange={(event) => setMaintenanceMessage(event.target.value)}
              disabled={!isAdmin || maintenanceSaving}
              maxLength={1000}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
            />
          </label>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          <label className="space-y-1.5">
            <span className="text-xs font-bold text-muted-foreground">{"\u1ea2nh minh h\u1ecda"}</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={maintenanceImageUrl}
                onChange={(event) => setMaintenanceImageUrl(event.target.value)}
                disabled={!isAdmin || maintenanceSaving}
                maxLength={1000}
                placeholder="https://..."
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
              />
              <input
                ref={maintenanceImageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(event) => handleMaintenanceImageSelect(event.target.files?.[0])}
              />
              <button
                type="button"
                disabled={!isAdmin || maintenanceSaving || maintenanceImageUploading}
                onClick={() => maintenanceImageInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {maintenanceImageUploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {"Upload"}
              </button>
            </div>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-bold text-muted-foreground">{"B\u1eaft \u0111\u1ea7u b\u1ea3o tr\u00ec"}</span>
              <input
                type="datetime-local"
                step={1}
                value={maintenanceStartsAt}
                onChange={(event) => setMaintenanceStartsAt(event.target.value)}
                disabled={!isAdmin || maintenanceSaving}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
              />
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {formatMaintenanceLocalDateTime(maintenanceStartsAt) || "Chưa đặt thời gian bắt đầu"}
              </span>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-bold text-muted-foreground">{"D\u1ef1 ki\u1ebfn m\u1edf l\u1ea1i"}</span>
              <input
                type="datetime-local"
                step={1}
                value={maintenanceEndsAt}
                onChange={(event) => setMaintenanceEndsAt(event.target.value)}
                disabled={!isAdmin || maintenanceSaving}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
              />
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {formatMaintenanceLocalDateTime(maintenanceEndsAt) || "Chưa đặt thời gian kết thúc"}
              </span>
            </label>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="aspect-video overflow-hidden rounded-xl border border-border bg-muted">
            {maintenanceImageUrl ? (
              <img src={maintenanceImageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs font-bold text-muted-foreground">
                {"Preview \u1ea3nh"}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-border bg-background/60 p-3">
            <p className="text-xs font-black uppercase text-muted-foreground">{"Preview n\u1ed9i dung"}</p>
            <h3 className="mt-2 text-lg font-black">{maintenanceTitle || DEFAULT_MAINTENANCE_TITLE_ADMIN}</h3>
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
              {maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE_ADMIN}
            </p>
            {(maintenanceStartsAt || maintenanceEndsAt) && (
              <div className="mt-2 grid gap-1 text-xs font-semibold text-muted-foreground sm:grid-cols-2">
                <span>
                  {"B\u1eaft \u0111\u1ea7u: "}
                  {formatMaintenanceLocalDateTime(maintenanceStartsAt) || "Chưa đặt"}
                </span>
                <span>
                  {"K\u1ebft th\u00fac: "}
                  {formatMaintenanceLocalDateTime(maintenanceEndsAt) || "Chưa đặt"}
                </span>
              </div>
            )}
            {maintenanceEndsAt && (
              <p className="mt-2 text-xs font-bold text-yellow-300">
                {"S\u1ebd hi\u1ec3n th\u1ecb countdown \u0111\u1ebfn m\u1ed1c d\u1ef1 ki\u1ebfn m\u1edf l\u1ea1i."}
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-black uppercase text-muted-foreground">{"L\u1ecbch s\u1eed \u1ea3nh b\u1ea3o tr\u00ec"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {"Ch\u1ecdn l\u1ea1i \u1ea3nh \u0111\u00e3 upload ho\u1eb7c x\u00f3a \u0111\u1ec3 g\u1ee1 kh\u1ecfi Supabase Storage."}
              </p>
            </div>
            <button
              type="button"
              disabled={!isAdmin || maintenanceImagesLoading}
              onClick={() => void loadMaintenanceImages()}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${maintenanceImagesLoading ? "animate-spin" : ""}`} />
              {"T\u1ea3i l\u1ea1i"}
            </button>
          </div>

          {maintenanceImages.length > 0 ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {maintenanceImages.map((item) => {
                const imageUrl = item.image_url;
                const selected = maintenanceImageUrl === imageUrl;
                const deleting = maintenanceImageDeleting === imageUrl;
                return (
                  <div key={imageUrl} className={`group relative overflow-hidden rounded-xl border bg-card ${selected ? "border-primary" : "border-border"}`}>
                    <button
                      type="button"
                      disabled={!isAdmin || deleting}
                      onClick={() => setMaintenanceImageUrl(imageUrl)}
                      className="block aspect-video w-full overflow-hidden bg-muted disabled:opacity-70"
                    >
                      <img src={imageUrl} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                    </button>
                    <div className="flex items-center justify-between gap-2 p-2">
                      <span className={`truncate text-[11px] font-bold ${selected ? "text-primary" : "text-muted-foreground"}`}>
                        {selected ? "Đang chọn" : item.name || "Ảnh bảo trì"}
                      </span>
                      <button
                        type="button"
                        disabled={!isAdmin || deleting}
                        onClick={() => void handleDeleteMaintenanceImage(imageUrl)}
                        className="shrink-0 rounded-md p-1 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        title="Xóa ảnh"
                      >
                        {deleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-border p-4 text-center text-xs font-semibold text-muted-foreground">
              {maintenanceImagesLoading ? "Đang tải ảnh..." : "Chưa có ảnh bảo trì nào được upload."}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!isAdmin || maintenanceSaving || maintenanceLoading}
            onClick={() => saveMaintenanceMode(maintenanceEnabled)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {maintenanceSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Lưu nội dung
          </button>
          {!isAdmin && (
            <span className="text-xs font-semibold text-yellow-300">
              Chỉ admin được bật/tắt chế độ bảo trì.
            </span>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <h2 className="text-sm font-bold text-amber-100">
              Tab này hiện là trung tâm điều hướng
            </h2>
            <p className="mt-1 text-sm text-amber-100/80">
              Các cấu hình như tên website, reader mặc định hoặc giới hạn
              upload cần có API/database riêng trước khi bật lại thành form sửa
              trực tiếp.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {workingShortcuts.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.title}
              type="button"
              onClick={() => onNavigate(item.tab)}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg"
            >
              <div
                className={`absolute inset-0 bg-gradient-to-br ${item.accent} opacity-70 transition-opacity group-hover:opacity-100`}
              />
              <div className="relative flex h-full flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="rounded-xl border border-white/10 bg-background/70 p-2">
                    <Icon className="h-5 w-5" />
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                </div>
                <div>
                  <h3 className="font-bold">{item.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.description}
                  </p>
                </div>
                <span className="mt-auto inline-flex w-fit items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">
                  <CheckCircle className="h-3 w-3" />
                  Đang hoạt động
                </span>
              </div>
            </button>
          );
        })}
      </div>

    </div>
  );
};

// ===================== SECURITY SECTION =====================
const SecuritySection = () => (
  <div className="space-y-4">
    <div>
      <h1 className="text-2xl font-bold">Bảo mật</h1>
      <p className="text-sm text-muted-foreground">
        Quản lý bảo mật và phiên đăng nhập
      </p>
    </div>

    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Lock className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">Xác thực hai yếu tố (2FA)</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Bảo vệ tài khoản admin với xác thực hai yếu tố.
      </p>
      <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/80 transition-colors">
        Kích hoạt 2FA
      </button>
    </div>

    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Monitor className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">Phiên đăng nhập</h3>
      </div>
      <div className="space-y-2">
        <div className="p-3 bg-secondary/20 rounded-lg">
          <div className="flex items-center gap-3">
            <Monitor className="w-4 h-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Phiên hiện tại</p>
              <p className="text-[10px] text-muted-foreground">
                Đang hoạt động
              </p>
            </div>
          </div>
        </div>
      </div>
      <button className="mt-3 text-xs font-bold text-red-400 hover:text-red-300 transition-colors">
        Đăng xuất tất cả phiên
      </button>
    </div>

    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">Nhật ký hành động Admin</h3>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Dữ liệu nhật ký sẽ hiển thị ở tab Tổng quan.
        </p>
      </div>
    </div>

    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="w-4 h-4 text-yellow-400" />
        <h3 className="text-sm font-bold">Giám sát IP đáng ngờ</h3>
      </div>
      <div className="space-y-2">
        {[
          {
            ip: "45.33.32.156",
            attempts: 15,
            time: "10 phút trước",
            status: "blocked",
          },
          {
            ip: "203.0.113.42",
            attempts: 8,
            time: "1 giờ trước",
            status: "monitoring",
          },
        ].map((ip) => (
          <div
            key={ip.ip}
            className="flex items-center justify-between p-3 bg-secondary/20 rounded-lg"
          >
            <div>
              <p className="text-sm font-medium font-mono">{ip.ip}</p>
              <p className="text-[10px] text-muted-foreground">
                {ip.attempts} lần thử • {ip.time}
              </p>
            </div>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded ${ip.status === "blocked" ? "text-red-400 bg-red-400/10" : "text-yellow-400 bg-yellow-400/10"}`}
            >
              {ip.status === "blocked" ? "Đã chặn" : "Đang theo dõi"}
            </span>
          </div>
        ))}
      </div>
    </div>
  </div>
);
// ===================== COMMENTS SECTION =====================
const CommentsSection = () => {
  const currentUserRole = useUserStore((s) => s.user?.role || "reader");
  const canDeleteComments = currentUserRole === "admin" || currentUserRole === "moderator";
  const roleLevel: Record<string, number> = {
    reader: 0,
    uploader: 1,
    moderator: 2,
    admin: 3,
  };
  const canDeleteTargetRole = (targetRole?: string) => {
    if (currentUserRole === "admin") return true;
    if (currentUserRole !== "moderator") return false;
    const target = String(targetRole || "reader").toLowerCase();
    return (roleLevel[currentUserRole] || 0) >= (roleLevel[target] ?? 0);
  };
  const [comments, setComments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (permissionDeniedMessage) return;
    setLoading(true);
    adminApi
      .getAllComments(page, debouncedSearch || undefined)
      .then((d) => {
        setPermissionDeniedMessage("");
        setComments(d.comments || []);
        setTotal(d.total || 0);
      })
      .catch((err) => {
        if (isPermissionDeniedError(err)) {
          setPermissionDeniedMessage(getErrorMessage(err) || "Không có quyền truy cập");
          setComments([]);
          setTotal(0);
        }
      })
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, permissionDeniedMessage]);

  const handleDelete = async (id: string, targetRole?: string) => {
    if (deletingCommentId === id) {
      return;
    }

    setDeletingCommentId(id);

    if (!canDeleteComments) {
      toast.error("Bạn không có quyền xóa bình luận");
      setDeleteId(null);
      setDeletingCommentId(null);
      return;
    }
    if (!canDeleteTargetRole(targetRole)) {
      toast.error("Không thể xóa bình luận của role cao hơn");
      setDeleteId(null);
      setDeletingCommentId(null);
      return;
    }
    try {
      await adminApi.deleteComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
      toast.success("Đã xóa bình luận");
    } catch (err: any) {
      toast.error(err.message || "Không thể xóa");
    } finally {
      setDeletingCommentId(null);
      setDeleteId(null);
    }
  };

  const LIMIT = 20;
  const totalPages = Math.ceil(total / LIMIT);

  if (permissionDeniedMessage) {
    return (
      <PermissionDeniedPanel
        title="Bình luận"
        message={permissionDeniedMessage}
        onRetry={() => {
          setPermissionDeniedMessage("");
          setPage(1);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Kiểm duyệt bình luận</h1>
        <p className="text-sm text-muted-foreground">
          {total.toLocaleString()} bình luận
        </p>
        {currentUserRole === "moderator" && (
          <p className="text-xs text-amber-300 mt-1">
            Moderator có thể xóa bình luận của role ngang/thấp hơn, không thể xóa bình luận của admin.
          </p>
        )}
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Tìm nội dung bình luận..."
      />

      {loading ? (
        <div className="flex justify-center py-16">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground">
                    Người dùng
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground">
                    Bình luận
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden md:table-cell">
                    Manga
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-bold text-muted-foreground hidden lg:table-cell">
                    Thời gian
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-bold text-muted-foreground">
                    Xóa
                  </th>
                </tr>
              </thead>
              <tbody>
                {comments.map((c) => {
                  const canDeleteThisComment = canDeleteTargetRole(c.role);
                  return (
                  <tr
                    key={c.id}
                    className={`border-b border-border/50 hover:bg-secondary/30 transition-colors ${c.is_deleted ? "opacity-40" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                          {(c.username || "?")[0]}
                        </div>
                        <div>
                          <p className="text-xs font-medium">
                            {c.username || "Unknown"}
                          </p>
                          <RoleBadge role={c.role || "reader"} />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-xs line-clamp-2">
                        {c.is_deleted ? "[Đã xóa]" : c.content}
                      </p>
                      {c.likes > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          ❤ {c.likes} likes
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <a
                        href={getMangaDetailPath(c.manga_slug)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline line-clamp-1 max-w-[120px] block"
                      >
                        {c.manga_slug}
                      </a>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-[10px] text-muted-foreground">
                      {c.created_at
                        ? new Date(c.created_at).toLocaleString("vi")
                        : ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!c.is_deleted && canDeleteComments && canDeleteThisComment &&
                        (deleteId === c.id ? (
                          <div className="flex items-center gap-1 justify-end">
                            <button
                              onClick={() => handleDelete(c.id, c.role)}
                              disabled={deletingCommentId === c.id}
                              className="px-2 py-1 rounded-lg bg-red-500 text-white text-[10px] font-bold hover:bg-red-600 disabled:opacity-70 disabled:cursor-not-allowed inline-flex items-center gap-1"
                            >
                              {deletingCommentId === c.id ? (
                                <>
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                  Đang xóa...
                                </>
                              ) : (
                                "Xác nhận"
                              )}
                            </button>
                            <button
                              onClick={() => setDeleteId(null)}
                              disabled={deletingCommentId === c.id}
                              className="px-2 py-1 rounded-lg bg-secondary text-[10px] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Hủy
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteId(c.id)}
                            disabled={deletingCommentId !== null}
                            className="p-1.5 rounded-lg hover:bg-red-400/10 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ))}
                      {!c.is_deleted && canDeleteComments && !canDeleteThisComment && (
                        <span className="text-[10px] text-amber-300">Role cao hơn</span>
                      )}
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
          {comments.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                Không có bình luận nào
              </p>
            </div>
          )}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-bold disabled:opacity-50 hover:bg-secondary/80"
          >
            ← Trước
          </button>
          <span className="px-3 py-1.5 text-xs text-muted-foreground">
            {page}/{totalPages}
          </span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-bold disabled:opacity-50 hover:bg-secondary/80"
          >
            Sau →
          </button>
        </div>
      )}
    </div>
  );
};

// ===================== MANGA APPROVAL SECTION =====================
const MangaApprovalSection = ({
  actions,
  setActions,
  showConfirm,
}: {
  actions: Record<string, "approved" | "rejected">;
  setActions: React.Dispatch<
    React.SetStateAction<Record<string, "approved" | "rejected">>
  >;
  showConfirm: Function;
}) => {
  const [filter, setFilter] = useState<
    "all" | "pending" | "approved" | "rejected"
  >("all");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const [pendingManga, setPendingManga] = useState<any[]>([]);
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState("");

  useEffect(() => {
    if (permissionDeniedMessage) return;
    adminApi
      .getMangaUploads(1)
      .then((d) => {
        setPermissionDeniedMessage("");
        const uploads = (d.uploads || []).map((u: any) => ({
          id: u.id,
          title: u.title || "Không có tên",
          author: u.author || "",
          cover: u.cover_url || "",
          description: u.description || "",
          type: u.manga_type || "manga",
          genres: u.genres || [],
          status: u.status,
          submitter:
            u.profiles?.display_name || u.profiles?.username || "Unknown",
          submittedAt: u.created_at ? u.created_at.split("T")[0] : "",
        }));
        setPendingManga(uploads);
      })
      .catch((err) => {
        if (isPermissionDeniedError(err)) {
          setPermissionDeniedMessage(getErrorMessage(err) || "Không có quyền truy cập");
          setPendingManga([]);
        }
      });
  }, [permissionDeniedMessage]);

  const filtered = useMemo(() => {
    return pendingManga.filter((m) => {
      const currentStatus = actions[m.id] || m.status;
      if (filter === "all") return true;
      return currentStatus === filter;
    });
  }, [filter, actions, pendingManga]);

  const handleAction = (
    id: string,
    action: "approved" | "rejected",
    title: string,
  ) => {
    const label = action === "approved" ? "duyệt" : "từ chối";
    showConfirm(
      `${action === "approved" ? "Duyệt" : "Từ chối"} truyện`,
      `Bạn có chắc muốn ${label} truyện "${title}"?`,
      async () => {
        try {
          await adminApi.reviewMangaUpload(
            id,
            action === "approved" ? "approve" : "reject",
          );
          setActions((prev: Record<string, "approved" | "rejected">) => ({
            ...prev,
            [id]: action,
          }));
          toast.success(`Đã ${label} truyện "${title}"`);
        } catch (err: any) {
          toast.error(err.message || `Không thể ${label} truyện`);
        }
      },
      action === "rejected",
    );
  };

  const handleDelete = (id: string, title: string) => {
    showConfirm(
      "Xóa truyện",
      `Bạn có chắc muốn xóa truyện "${title}"? Hành động này không thể hoàn tác.`,
      async () => {
        try {
          await adminApi.deleteMangaUpload(id);
          setPendingManga((prev) => prev.filter((m) => m.id !== id));
          toast.success(`Đã xóa truyện "${title}"`);
        } catch (err: any) {
          toast.error(err.message || "Không thể xóa truyện");
        }
      },
      true,
    );
  };

  const handleHide = (id: string, title: string) => {
    showConfirm(
      "Ẩn truyện",
      `Bạn có chắc muốn ẩn truyện "${title}"? Truyện sẽ chuyển về trạng thái từ chối.`,
      async () => {
        try {
          await adminApi.reviewMangaUpload(id, "reject", "Ẩn bởi admin");
          setActions((prev: Record<string, "approved" | "rejected">) => ({
            ...prev,
            [id]: "rejected",
          }));
          toast.success(`Đã ẩn truyện "${title}"`);
        } catch (err: any) {
          toast.error(err.message || "Không thể ẩn truyện");
        }
      },
      true,
    );
  };

  const previewManga = previewId
    ? pendingManga.find((m) => m.id === previewId)
    : null;

  if (permissionDeniedMessage) {
    return (
      <PermissionDeniedPanel
        title="Duyệt truyện"
        message={permissionDeniedMessage}
        onRetry={() => setPermissionDeniedMessage("")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Phê duyệt truyện mới</h1>
        <p className="text-sm text-muted-foreground">
          {
            pendingManga.filter((m) => m.status === "pending" && !actions[m.id])
              .length
          }{" "}
          truyện chờ duyệt
        </p>
      </div>

      <div className="flex gap-1 bg-secondary/30 p-1 rounded-lg w-fit flex-wrap">
        {(
          [
            { key: "all", label: "Tất cả" },
            { key: "pending", label: "Chờ duyệt" },
            { key: "approved", label: "Đã duyệt" },
            { key: "rejected", label: "Từ chối" },
          ] as const
        ).map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
              filter === f.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filtered.map((manga) => {
          const currentStatus = actions[manga.id] || manga.status;
          return (
            <motion.div
              key={manga.id}
              layout
              className={`bg-card border rounded-xl p-4 transition-colors ${
                currentStatus === "approved"
                  ? "border-green-500/50 bg-green-500/5"
                  : currentStatus === "rejected"
                    ? "border-red-500/50 bg-red-500/5"
                    : "border-border"
              }`}
            >
              <div className="flex gap-4">
                <OptimizedImage
                  src={manga.cover}
                  alt=""
                  className="w-16 h-22 object-cover rounded-lg border border-border shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="font-bold text-sm">{manga.title}</h3>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-secondary uppercase">
                      {manga.type}
                    </span>
                    <StatusBadge status={currentStatus} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tác giả: {manga.author}
                  </p>
                  <ExpandableText
                    text={manga.description}
                    className="text-xs text-muted-foreground mt-0.5"
                  />
                  <div className="flex flex-wrap gap-1 mt-2">
                    {manga.genres.map((g) => (
                      <span
                        key={g}
                        className="text-[10px] font-semibold bg-secondary px-2 py-0.5 rounded-md text-muted-foreground"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Gửi bởi {manga.submitter} • {manga.submittedAt}
                  </p>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() =>
                      setPreviewId(previewId === manga.id ? null : manga.id)
                    }
                    className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  {currentStatus === "pending" && (
                    <>
                      <button
                        onClick={() =>
                          handleAction(manga.id, "approved", manga.title)
                        }
                        className="p-1.5 rounded-lg hover:bg-green-400/10 text-muted-foreground hover:text-green-400 transition-colors"
                        title="Duyệt"
                      >
                        <CheckCircle className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() =>
                          handleAction(manga.id, "rejected", manga.title)
                        }
                        className="p-1.5 rounded-lg hover:bg-red-400/10 text-muted-foreground hover:text-red-400 transition-colors"
                        title="Từ chối"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {currentStatus === "approved" && (
                    <button
                      onClick={() => handleHide(manga.id, manga.title)}
                      className="p-1.5 rounded-lg hover:bg-amber-400/10 text-muted-foreground hover:text-amber-400 transition-colors"
                      title="Ẩn truyện"
                    >
                      <EyeOff className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(manga.id, manga.title)}
                    className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                    title="Xóa truyện"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  {currentStatus !== "pending" && (
                    <span
                      className={`text-[10px] font-bold text-center ${currentStatus === "approved" ? "text-green-400" : "text-red-400"}`}
                    >
                      {currentStatus === "approved" ? "✓" : "✗"}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}

        {filtered.length === 0 && (
          <div className="text-center py-12">
            <BookOpen className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              Không có truyện nào trong danh mục này
            </p>
          </div>
        )}
      </div>

      {/* Preview panel */}
      <AnimatePresence>
        {previewManga && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-card border border-border rounded-xl overflow-hidden"
          >
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold">Xem trước: {previewManga.title}</h3>
                <button
                  onClick={() => setPreviewId(null)}
                  className="p-1 rounded hover:bg-secondary"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex gap-5">
                <OptimizedImage
                  src={previewManga.cover}
                  alt=""
                  className="w-32 h-44 object-cover rounded-lg border border-border shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Tên truyện</p>
                    <p className="text-sm font-bold">{previewManga.title}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Tác giả</p>
                    <p className="text-sm font-medium">{previewManga.author}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Loại</p>
                    <span className="text-xs font-bold bg-secondary px-2 py-0.5 rounded uppercase">
                      {previewManga.type}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Thể loại</p>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {previewManga.genres.map((g) => (
                        <span
                          key={g}
                          className="text-[10px] font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded-md"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Mô tả</p>
                    <ExpandableText
                      text={previewManga.description}
                      className="text-sm mt-0.5"
                    />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AdminPanel;
