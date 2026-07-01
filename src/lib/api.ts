/**
 * API client — centralized HTTP calls to backend.
 * FastAPI: http://localhost:8000  |  Flask Auth: http://localhost:5000
 */

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const AUTH_BASE = import.meta.env.VITE_AUTH_URL || "http://localhost:5000";
export const FORCE_LOGOUT_EVENT = "mb:force-logout";
export const FORCE_FORBIDDEN_EVENT = "mb:force-forbidden";
export const FORCE_MAINTENANCE_EVENT = "mb:force-maintenance";
export const HOMEPAGE_REFRESH_EVENT = "mb:homepage-refresh";
const BAN_LOCK_KEY = "banned_lock";
const SESSION_HINT_KEY = "mb:session-present";
const REFRESH_LOCK_KEY = "mb:auth-refresh-lock";
const AUTH_TOKEN_CHANNEL = "mb:auth-token";
const BAN_LOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOMEPAGE_REFRESH_STORAGE_KEY = "mb:homepage-refresh:signal";
let homepageRefreshChannel: BroadcastChannel | null = null;
let authTokenChannel: BroadcastChannel | null = null;

// Client-side password derivation. The backend accepts v4 and falls back to
// older v3/v2 hashes during login/change-password migration.
const PASSWORD_HASH_VERSION = "mb4";
const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_HASH_ITERATIONS = 600_000;
const PASSWORD_HASH_SALT_PREFIX = "MangaHub_v4_password_pbkdf2";
const LEGACY_PBKDF2_PASSWORD_HASH_VERSION = "mb3";
const LEGACY_PBKDF2_PASSWORD_HASH_ITERATIONS = 310_000;
const LEGACY_PBKDF2_PASSWORD_HASH_SALT = "MangaHub_v3_password_pbkdf2";
const LEGACY_PASSWORD_HASH_VERSION = "mb2";
const LEGACY_PASSWORD_HASH_ALGORITHM = "sha256";
const LEGACY_PASSWORD_HASH_SALT = "MangaHub_v2_";

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizePasswordAccountHint(value: string): string {
  return String(value || "").trim().toLowerCase();
}

async function derivePbkdf2PasswordHash(
  password: string,
  salt: string,
  iterations: number,
  version: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations,
    },
    key,
    256,
  );
  return `${version}$${PASSWORD_HASH_ALGORITHM}$${iterations}$${bytesToHex(hashBuffer)}`;
}

async function hashPassword(password: string, accountHint: string): Promise<string> {
  const normalizedHint = normalizePasswordAccountHint(accountHint);
  return derivePbkdf2PasswordHash(
    password,
    `${PASSWORD_HASH_SALT_PREFIX}:${normalizedHint}`,
    PASSWORD_HASH_ITERATIONS,
    PASSWORD_HASH_VERSION,
  );
}

async function hashPasswordV3(password: string): Promise<string> {
  return derivePbkdf2PasswordHash(
    password,
    LEGACY_PBKDF2_PASSWORD_HASH_SALT,
    LEGACY_PBKDF2_PASSWORD_HASH_ITERATIONS,
    LEGACY_PBKDF2_PASSWORD_HASH_VERSION,
  );
}

async function hashPasswordLegacy(password: string): Promise<string> {
  const data = new TextEncoder().encode(LEGACY_PASSWORD_HASH_SALT + password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${LEGACY_PASSWORD_HASH_VERSION}$${LEGACY_PASSWORD_HASH_ALGORITHM}$${hex}`;
}

// ─── Token management ───
// Refresh token lives in an HttpOnly cookie set by Flask Auth. The frontend only
// keeps the short-lived access token in memory.
try {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
} catch {
  // Ignore unavailable storage.
}

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let refreshBlockedUntil = 0;
let lastRefreshFailureHard = false;
let lastRefreshFailureMessage = "";
let hardRefreshFailureCount = 0;
let firstHardRefreshFailureAt = 0;
const refreshTabId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const REFRESH_BACKOFF_MS = 15_000;
const REFRESH_RETRYABLE_BACKOFF_MS = 1_500;
const REFRESH_RATE_LIMIT_BACKOFF_MS = 60_000;
const REFRESH_LOCK_TTL_MS = 25_000;
const REFRESH_LOCK_WAIT_MS = 20_000;
const REFRESH_LOCK_POLL_MS = 180;
const PEER_TOKEN_WAIT_MS = 350;
const REFRESH_RETRYABLE_ATTEMPTS = 5;
const REFRESH_RETRYABLE_DELAY_MS = 500;
const HARD_REFRESH_FAILURE_MIN_COUNT = 3;
const HARD_REFRESH_FAILURE_GRACE_MS = 60_000;
const MISSING_REFRESH_TOKEN_MIN_COUNT = 3;
const MISSING_REFRESH_TOKEN_GRACE_MS = 45_000;

export type MaintenanceState = {
  enabled: boolean;
  title?: string;
  message?: string;
  image_url?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
};

type AuthTokenMessage = {
  type: "token" | "request-token" | "logout";
  source?: string;
  accessToken?: string;
};

function getAuthTokenChannel() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!authTokenChannel) {
    authTokenChannel = new BroadcastChannel(AUTH_TOKEN_CHANNEL);
    authTokenChannel.onmessage = (event: MessageEvent<AuthTokenMessage>) => {
      const message = event.data || {};
      if (message.source === refreshTabId) return;

      if (message.type === "request-token") {
        if (accessToken && !shouldRefreshBeforeRequest(accessToken)) {
          postAuthTokenMessage({ type: "token", accessToken });
        }
        return;
      }

      if (message.type === "token" && message.accessToken) {
        setTokens(message.accessToken, undefined, { broadcast: false });
        return;
      }

      if (message.type === "logout") {
        clearTokens({ broadcast: false });
      }
    };
  }
  return authTokenChannel;
}

function postAuthTokenMessage(message: AuthTokenMessage) {
  const channel = getAuthTokenChannel();
  if (!channel) return;
  try {
    channel.postMessage({ ...message, source: refreshTabId });
  } catch {
    // Ignore unavailable BroadcastChannel.
  }
}

async function waitForPeerAccessToken(timeoutMs = PEER_TOKEN_WAIT_MS): Promise<boolean> {
  const channel = getAuthTokenChannel();
  if (!channel || accessToken || !hasSessionHint()) return Boolean(accessToken);
  postAuthTokenMessage({ type: "request-token" });
  const startedAt = Date.now();
  while (!accessToken && Date.now() - startedAt < timeoutMs) {
    await sleep(50);
  }
  return Boolean(accessToken);
}

getAuthTokenChannel();

export function setTokens(access: string, _refresh?: string, options: { broadcast?: boolean } = {}) {
  accessToken = access;
  refreshBlockedUntil = 0;
  lastRefreshFailureHard = false;
  lastRefreshFailureMessage = "";
  hardRefreshFailureCount = 0;
  firstHardRefreshFailureAt = 0;
  try {
    localStorage.setItem(SESSION_HINT_KEY, String(Date.now()));
    localStorage.removeItem(BAN_LOCK_KEY);
  } catch {
    // Ignore unavailable storage.
  }
  if (options.broadcast !== false) {
    postAuthTokenMessage({ type: "token", accessToken: access });
  }
}

export function clearTokens(options: { broadcast?: boolean } = {}) {
  accessToken = null;
  refreshBlockedUntil = 0;
  lastRefreshFailureHard = false;
  lastRefreshFailureMessage = "";
  hardRefreshFailureCount = 0;
  firstHardRefreshFailureAt = 0;
  try {
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Ignore unavailable storage.
  }
  if (options.broadcast !== false) {
    postAuthTokenMessage({ type: "logout" });
  }
}

export function hasSessionHint() {
  try {
    return Boolean(localStorage.getItem(SESSION_HINT_KEY));
  } catch {
    return false;
  }
}

export function wasLastRefreshFailureHard() {
  return lastRefreshFailureHard;
}

export function wasLastRefreshFailureMissingToken() {
  return normalizeText(lastRefreshFailureMessage).includes("refresh token la bat buoc");
}

export function shouldStopRestoringSession() {
  if (!lastRefreshFailureHard) return false;
  if (wasLastRefreshFailureMissingToken()) {
    if (hardRefreshFailureCount < MISSING_REFRESH_TOKEN_MIN_COUNT) return false;
    if (!firstHardRefreshFailureAt) return false;
    return Date.now() - firstHardRefreshFailureAt >= MISSING_REFRESH_TOKEN_GRACE_MS;
  }
  if (hardRefreshFailureCount < HARD_REFRESH_FAILURE_MIN_COUNT) return false;
  if (!firstHardRefreshFailureAt) return false;
  return Date.now() - firstHardRefreshFailureAt >= HARD_REFRESH_FAILURE_GRACE_MS;
}

function markRefreshFailure(message: string, hard: boolean) {
  lastRefreshFailureMessage = message;
  lastRefreshFailureHard = hard;
  if (hard) {
    if (!firstHardRefreshFailureAt) firstHardRefreshFailureAt = Date.now();
    hardRefreshFailureCount += 1;
  } else {
    hardRefreshFailureCount = 0;
    firstHardRefreshFailureAt = 0;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function tryAcquireRefreshLock() {
  if (typeof window === "undefined") return true;
  try {
    const now = Date.now();
    const raw = localStorage.getItem(REFRESH_LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw);
      const owner = String(lock?.owner || "");
      const expiresAt = Number(lock?.expiresAt || 0);
      if (owner && owner !== refreshTabId && expiresAt > now) {
        return false;
      }
    }
    localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ owner: refreshTabId, expiresAt: now + REFRESH_LOCK_TTL_MS }),
    );
    const check = JSON.parse(localStorage.getItem(REFRESH_LOCK_KEY) || "{}");
    return String(check?.owner || "") === refreshTabId;
  } catch {
    return true;
  }
}

function releaseRefreshLock() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(REFRESH_LOCK_KEY);
    if (!raw) return;
    const lock = JSON.parse(raw);
    if (String(lock?.owner || "") === refreshTabId) {
      localStorage.removeItem(REFRESH_LOCK_KEY);
    }
  } catch {
    // Ignore unavailable storage.
  }
}

async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (!tryAcquireRefreshLock()) {
    if (Date.now() - startedAt > REFRESH_LOCK_WAIT_MS) break;
    await sleep(REFRESH_LOCK_POLL_MS);
  }
  try {
    return await task();
  } finally {
    releaseRefreshLock();
  }
}

export function shouldRefreshSessionNow(bufferSeconds = 15 * 60) {
  if (!accessToken) return hasSessionHint();
  const exp = parseJwtExp(accessToken);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now <= bufferSeconds;
}

function setRefreshBackoff(message: string) {
  const text = String(message || "").toLowerCase();
  const isRateLimited =
    text.includes("429") ||
    text.includes("too many") ||
    text.includes("rate limit");
  const backoffMs = isRateLimited
    ? REFRESH_RATE_LIMIT_BACKOFF_MS
    : REFRESH_BACKOFF_MS;
  refreshBlockedUntil = Math.max(refreshBlockedUntil, Date.now() + backoffMs);
}

function setRefreshRetryableBackoff() {
  refreshBlockedUntil = Math.max(refreshBlockedUntil, Date.now() + REFRESH_RETRYABLE_BACKOFF_MS);
}

function emitForceLogout(reason: string) {
  window.dispatchEvent(
    new CustomEvent(FORCE_LOGOUT_EVENT, { detail: { reason } }),
  );
}

function emitForceForbidden() {
  window.dispatchEvent(
    new CustomEvent(FORCE_FORBIDDEN_EVENT, {
      detail: { reason: "insufficient-role" },
    }),
  );
}

function emitMaintenance(state: MaintenanceState) {
  window.dispatchEvent(
    new CustomEvent(FORCE_MAINTENANCE_EVENT, {
      detail: state,
    }),
  );
}

function isMaintenanceResponse(body: any): boolean {
  return body?.code === "MAINTENANCE_MODE" || body?.maintenance?.enabled === true;
}

function maintenanceStateFromBody(body: any): MaintenanceState {
  const state = body?.maintenance || {};
  return {
    enabled: true,
    title: state.title || "Website \u0111ang b\u1ea3o tr\u00ec",
    message:
      state.message ||
      body?.detail ||
      body?.error ||
      "MangaHub \u0111ang b\u1ea3o tr\u00ec h\u1ec7 th\u1ed1ng. Vui l\u00f2ng quay l\u1ea1i sau \u00edt ph\u00fat.",
    image_url: state.image_url || null,
    starts_at: state.starts_at || null,
    ends_at: state.ends_at || null,
    updated_at: state.updated_at || null,
    updated_by: state.updated_by || null,
  };
}

function getHomepageRefreshChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  if (!homepageRefreshChannel) {
    homepageRefreshChannel = new BroadcastChannel(HOMEPAGE_REFRESH_EVENT);
  }
  return homepageRefreshChannel;
}

export function emitHomepageRefresh(reason = "manual") {
  if (typeof window === "undefined") return;
  const payload = { reason, at: Date.now() };

  window.dispatchEvent(
    new CustomEvent(HOMEPAGE_REFRESH_EVENT, {
      detail: payload,
    }),
  );

  try {
    localStorage.setItem(HOMEPAGE_REFRESH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors.
  }

  try {
    getHomepageRefreshChannel()?.postMessage(payload);
  } catch {
    // Ignore channel errors.
  }
}

export function subscribeHomepageRefresh(
  onRefresh: (payload: { reason?: string; at?: number }) => void,
) {
  if (typeof window === "undefined") return () => {};

  let lastSignalAt = 0;

  const trigger = (payload: { reason?: string; at?: number }) => {
    const signalAt = Number(payload?.at || Date.now());
    if (signalAt <= lastSignalAt) return;
    lastSignalAt = signalAt;
    onRefresh(payload);
  };

  const onCustomEvent = (event: Event) => {
    const custom = event as CustomEvent<{ reason?: string; at?: number }>;
    trigger(custom.detail || {});
  };

  const onStorageEvent = (event: StorageEvent) => {
    if (event.key !== HOMEPAGE_REFRESH_STORAGE_KEY || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue);
      trigger(payload || {});
    } catch {
      // Ignore malformed storage payload.
    }
  };

  const channel = getHomepageRefreshChannel();
  const onChannelMessage = (event: MessageEvent) => {
    trigger((event.data || {}) as { reason?: string; at?: number });
  };

  window.addEventListener(HOMEPAGE_REFRESH_EVENT, onCustomEvent as EventListener);
  window.addEventListener("storage", onStorageEvent);
  if (channel) {
    channel.addEventListener("message", onChannelMessage);
  }

  return () => {
    window.removeEventListener(HOMEPAGE_REFRESH_EVENT, onCustomEvent as EventListener);
    window.removeEventListener("storage", onStorageEvent);
    if (channel) {
      channel.removeEventListener("message", onChannelMessage);
    }
  };
}

export function getBanLock() {
  const raw = localStorage.getItem(BAN_LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const at = Number(parsed?.at || 0);
    if (!at || Date.now() - at > BAN_LOCK_TTL_MS) {
      localStorage.removeItem(BAN_LOCK_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setBanLock(data: Record<string, unknown>) {
  localStorage.setItem(
    BAN_LOCK_KEY,
    JSON.stringify({
      active: true,
      at: Date.now(),
      ...data,
    }),
  );
}

export function hasBanLock() {
  return Boolean(getBanLock()?.active);
}

export function clearBanLock() {
  localStorage.removeItem(BAN_LOCK_KEY);
}

function normalizeText(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isBannedResponse(body: any): boolean {
  const msg = normalizeText(
    String(body?.error || body?.detail || body?.message || ""),
  );
  if (!msg) return false;
  return (
    msg.includes("tai khoan da bi cam") ||
    msg.includes("account is banned") ||
    msg.includes("banned account") ||
    msg === "banned"
  );
}

function isPermissionDeniedResponse(message: string): boolean {
  const msg = normalizeText(message);
  if (!msg) return false;
  return (
    msg.includes("yeu cau quyen") ||
    msg.includes("khong co quyen") ||
    msg.includes("truy cap bi tu choi") ||
    msg.includes("forbidden") ||
    msg.includes("permission denied")
  );
}

function shouldEmitForbiddenRedirect(url: string, message: string): boolean {
  const normalizedUrl = String(url || "").toLowerCase();
  if (normalizedUrl.includes("/api/admin/")) {
    return isPermissionDeniedResponse(message);
  }
  return false;
}

function parseJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized);
    const data = JSON.parse(json);
    return Number(data?.exp) || null;
  } catch {
    return null;
  }
}

function shouldRefreshBeforeRequest(token: string): boolean {
  const exp = parseJwtExp(token);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now <= 5 * 60;
}

function isHardRefreshFailure(message: string): boolean {
  const msg = normalizeText(message);
  if (!msg) return false;
  return (
    msg.includes("refresh token khong hop le") ||
    msg.includes("refresh token khong khop") ||
    msg.includes("invalid refresh") ||
    msg.includes("session not found") ||
    msg.includes("can xac thuc lai") ||
    msg.includes("phien dang nhap da het han") ||
    msg.includes("phien dang nhap can xac thuc lai") ||
    msg.includes("tai khoan da bi cam")
  );
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshBlockedUntil > Date.now()) {
    return waitForPeerAccessToken(1_000);
  }
  if (!refreshInFlight) {
    refreshInFlight = authApi.refresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function getAccessToken() {
  return accessToken;
}

export type AvatarCropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// ─── Generic fetch wrappers ───
const DEFAULT_TIMEOUT_MS = 30_000;
const inFlightMutationRequests = new Map<string, Promise<unknown>>();

type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
  skipAuth?: boolean;
  suppressForbiddenRedirect?: boolean;
};

function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    credentials: "include",
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
}

function mutationDedupeKey(url: string, options: ApiRequestInit): string | null {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const body = options.body;
  if (body instanceof FormData) return null;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== "string" &&
    !(body instanceof URLSearchParams)
  ) {
    return null;
  }
  const bodyKey = body instanceof URLSearchParams ? body.toString() : String(body || "");
  return `${method} ${url} ${bodyKey}`;
}

function shouldRestoreSessionBeforeRequest(url: string, method = "GET"): boolean {
  if (!hasSessionHint() || accessToken) return false;
  const upperMethod = method.toUpperCase();
  if (upperMethod !== "GET" && upperMethod !== "HEAD") return true;

  try {
    const parsed = new URL(url, window.location.origin);
    const path = parsed.pathname;
    return (
      path === "/auth/me" ||
      path === "/auth/logout" ||
      path.startsWith("/api/admin/") ||
      path.startsWith("/api/users/") ||
      path.startsWith("/api/bookmarks/") ||
      path.startsWith("/api/history/") ||
      path.startsWith("/api/notifications/") ||
      path.startsWith("/api/reports/") ||
      path.startsWith("/api/groups/") ||
      path === "/api/comments/me" ||
      path.startsWith("/api/comments/me/") ||
      path === "/api/ratings/me" ||
      path.startsWith("/api/ratings/me/") ||
      path.startsWith("/api/uploads/")
    );
  } catch {
    return false;
  }
}

async function apiFetchResponse(url: string, options: ApiRequestInit = {}): Promise<Response> {
  const {
    timeoutMs,
    skipAuth = false,
    suppressForbiddenRedirect = false,
    ...requestOptions
  } = options;
  const requestTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const isRefreshRequest = /\/auth\/refresh(?:\?|$)/.test(url);
  if (
    !isRefreshRequest &&
    !skipAuth &&
    accessToken &&
    shouldRefreshBeforeRequest(accessToken)
  ) {
    await refreshAccessToken();
  }
  if (
    !isRefreshRequest &&
    !skipAuth &&
    !accessToken &&
    shouldRestoreSessionBeforeRequest(url, String(requestOptions.method || "GET"))
  ) {
    await refreshAccessToken();
  }
  const headers: Record<string, string> = {
    ...((requestOptions.headers as Record<string, string>) || {}),
  };
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type",
  );
  if (
    requestOptions.body &&
    !hasContentType &&
    !(requestOptions.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
  }
  if (!skipAuth && accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { ...requestOptions, headers }, requestTimeoutMs);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Yêu cầu quá thời gian, vui lòng thử lại");
    }
    throw err;
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    if (isMaintenanceResponse(body)) {
      emitMaintenance(maintenanceStateFromBody(body));
      throw new Error("MAINTENANCE_MODE");
    }
    throw new Error(body.error || body.detail || "Dịch vụ đang tạm thời gián đoạn");
  }

  if (res.status === 401 && !isRefreshRequest && !skipAuth && (accessToken || hasSessionHint())) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      const retry = await fetchWithTimeout(
        url,
        { ...requestOptions, headers },
        requestTimeoutMs,
      );
      if (retry.status === 503) {
        const body = await retry.json().catch(() => ({}));
        if (isMaintenanceResponse(body)) {
          emitMaintenance(maintenanceStateFromBody(body));
          throw new Error("MAINTENANCE_MODE");
        }
        throw new Error(body.error || body.detail || "Dịch vụ đang tạm thời gián đoạn");
      }
      if (retry.status === 403) {
        const body = await retry.json().catch(() => ({}));
        if (isBannedResponse(body)) {
          setBanLock(body);
          emitForceLogout("banned");
          throw new Error("BANNED");
        }
        const message = body.error || body.detail || `Không có quyền truy cập`;
        if (!suppressForbiddenRedirect && shouldEmitForbiddenRedirect(url, String(message))) {
          emitForceForbidden();
          throw new Error(`FORBIDDEN_ROLE::${message}`);
        }
        throw new Error(message);
      }
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        throw new Error(
          body.error || body.detail || `API error: ${retry.status}`,
        );
      }
      return retry;
    }

    // Stop retry storms only after repeated hard failures. A single refresh race
    // should not sign the user out.
    if (shouldStopRestoringSession()) {
      clearTokens();
      emitForceLogout("session-expired");
      throw new Error("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại");
    }

    throw new Error("Không thể làm mới phiên đăng nhập do mạng hoặc máy chủ chậm. Vui lòng thử lại.");
  }

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (isBannedResponse(body)) {
      setBanLock(body);
      emitForceLogout("banned");
      throw new Error("BANNED");
    }
    const message = body.error || body.detail || `Không có quyền truy cập`;
    if (!suppressForbiddenRedirect && shouldEmitForbiddenRedirect(url, String(message))) {
      emitForceForbidden();
      throw new Error(`FORBIDDEN_ROLE::${message}`);
    }
    throw new Error(message);
  }

  // 451 = admin-hidden manga
  if (res.status === 451) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail || body;
    const reason = typeof detail === "object" ? (detail?.reason || "Nội dung vi phạm quy định") : String(detail);
    throw new Error(`MANGA_HIDDEN::${reason}`);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail;
    const msg = typeof detail === "string" ? detail : (body?.error || `API error: ${res.status}`);
    throw new Error(msg);
  }
  return res;
}

async function apiFetch<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  const dedupeKey = mutationDedupeKey(url, options);
  if (dedupeKey) {
    const existing = inFlightMutationRequests.get(dedupeKey);
    if (existing) return existing as Promise<T>;
  }

  const promise = (async () => {
    const res = await apiFetchResponse(url, options);
    return res.json();
  })();

  if (dedupeKey) {
    inFlightMutationRequests.set(dedupeKey, promise);
    try {
      return await promise;
    } finally {
      if (inFlightMutationRequests.get(dedupeKey) === promise) {
        inFlightMutationRequests.delete(dedupeKey);
      }
    }
  }

  return promise;
}

function api<T>(path: string, options?: ApiRequestInit) {
  return apiFetch<T>(`${API_BASE}${path}`, options);
}

function apiResponse(path: string, options?: ApiRequestInit) {
  return apiFetchResponse(`${API_BASE}${path}`, options);
}

function admin<T>(path: string, options?: ApiRequestInit) {
  return api<T>(path, { ...options, suppressForbiddenRedirect: true });
}

function adminResponse(path: string, options?: ApiRequestInit) {
  return apiResponse(path, { ...options, suppressForbiddenRedirect: true });
}

function auth<T>(path: string, options?: ApiRequestInit) {
  return apiFetch<T>(`${AUTH_BASE}${path}`, options);
}

function authRawResponse(path: string, options: ApiRequestInit = {}) {
  const {
    timeoutMs,
    skipAuth = false,
    suppressForbiddenRedirect: _suppressForbiddenRedirect,
    ...requestOptions
  } = options;
  const requestTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    ...((requestOptions.headers as Record<string, string>) || {}),
  };
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type",
  );
  if (
    requestOptions.body &&
    !hasContentType &&
    !(requestOptions.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
  }
  if (!skipAuth && accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return fetchWithTimeout(
    `${AUTH_BASE}${path}`,
    { ...requestOptions, headers },
    requestTimeoutMs,
  );
}

// ─── Manga API (proxy OTruyenAPI) ───
export const systemApi = {
  getMaintenance: () => api<any>("/api/maintenance", { skipAuth: true, timeoutMs: 6_000 }),
};

export const mangaApi = {
  getHome: () => api<any>("/api/manga/home"),
  getHomepage: () => api<any>("/api/manga/homepage"),
  getFeatured: (limit = 12) => api<any>(`/api/manga/featured?limit=${limit}`),
  getMangaDexViCatalog: (
    maxChapters: number | "all" = 200,
    options?: {
      attachRatings?: boolean;
      attachOverrides?: boolean;
      filterHidden?: boolean;
      preferLatest?: boolean;
    },
  ) => {
    const query = new URLSearchParams({
      max_chapters: String(maxChapters),
      attach_ratings: String(options?.attachRatings ?? true),
      attach_overrides: String(options?.attachOverrides ?? true),
      filter_hidden: String(options?.filterHidden ?? true),
      prefer_latest: String(options?.preferLatest ?? false),
    });
    return api<any>(`/api/manga/mangadex/vi-catalog?${query.toString()}`);
  },
  getMangaDexLatestChapters: (
    ids: string[],
    options?: {
      fast?: boolean;
    },
  ) => {
    const normalizedIds = Array.from(
      new Set(
        (ids || [])
          .map((id) => String(id || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (!normalizedIds.length) {
      return Promise.resolve({ items: {} } as any);
    }
    const query = new URLSearchParams({
      ids: normalizedIds.join(","),
    });
    if (options?.fast) {
      query.set("fast", "true");
    }
    return api<any>(
      `/api/manga/mangadex/latest-chapters?${query.toString()}`,
      { timeoutMs: 15_000 },
    );
  },
  getMangaDexDetail: (
    mangaId: string,
    maxChapters: number | "all" = "all",
    translatedLanguage = "vi",
    options?: {
      scanlationGroupId?: string;
      timeoutMs?: number;
      skipAuth?: boolean;
    },
  ) => {
    const query = new URLSearchParams({
      max_chapters: String(maxChapters),
      translated_language: String(translatedLanguage || "vi"),
    });
    if (options?.scanlationGroupId) {
      query.set("scanlation_group_id", options.scanlationGroupId);
    }
    return api<any>(`/api/manga/mangadex/detail/${mangaId}?${query.toString()}`, {
      timeoutMs: options?.timeoutMs ?? 60_000,
      skipAuth: options?.skipAuth ?? false,
    });
  },
  getMangaDexLookup: (
    mangaId: string,
    options?: {
      timeoutMs?: number;
      skipAuth?: boolean;
    },
  ) =>
    api<any>(`/api/manga/mangadex/lookup/${mangaId}`, {
      timeoutMs: options?.timeoutMs ?? 6_000,
      skipAuth: options?.skipAuth ?? false,
    }),
  getMangaDexChapterPages: (
    chapterId: string,
    mode: "data" | "saver" = "data",
    refresh = false,
    timeoutMs = 12_000,
  ) =>
    api<any>(
      `/api/manga/mangadex/chapter-pages/${chapterId}?mode=${mode}&refresh=${refresh ? "1" : "0"}`,
      { timeoutMs },
    ),
  getList: (type = "truyen-moi", page = 1) =>
    api<any>(`/api/manga/list/${type}?page=${page}`),
  getCombinedList: (type = "truyen-moi", page = 1, maxChapters = 120) =>
    api<any>(`/api/manga/list-combined/${type}?page=${page}&max_chapters=${maxChapters}`),
  getCategories: () => api<any>("/api/manga/categories"),
  getCategoryManga: (slug: string, page = 1) =>
    api<any>(`/api/manga/category/${slug}?page=${page}`),
  getDetail: (slug: string) => api<any>(`/api/manga/detail/${slug}`),
  startViewSession: (
    slug: string,
    payload: {
      chapterId?: string;
      readSessionId: string;
    },
  ) =>
    api<any>(`/api/manga/${slug}/view-session`, {
      method: "POST",
      body: JSON.stringify({
        chapter_id: payload.chapterId || null,
        read_session_id: payload.readSessionId,
      }),
    }),
  addView: (
    slug: string,
    chapterId?: string,
    options?: {
      readSessionId?: string;
      elapsedSeconds?: number;
      progress?: number;
      pageSeen?: number;
      totalPages?: number;
    },
  ) =>
    api<any>(`/api/manga/${slug}/view`, {
      method: "POST",
      body: JSON.stringify({
        chapter_id: chapterId || null,
        read_session_id: options?.readSessionId || null,
        elapsed_seconds: Math.max(0, Math.floor(options?.elapsedSeconds || 0)),
        progress: Math.max(0, Math.min(100, Number(options?.progress || 0))),
        page_seen: Math.max(0, Math.floor(options?.pageSeen || 0)),
        total_pages: Math.max(0, Math.floor(options?.totalPages || 0)),
      }),
    }),
  search: (
    keyword: string,
    page = 1,
    options?: {
      includeMangaDex?: boolean;
      attachRatings?: boolean;
      mangaDexLimit?: number;
      mangaDexTimeoutMs?: number;
      mangaDexTranslatedLanguage?: string;
      mangaDexAttachLatest?: boolean;
      skipAuth?: boolean;
      timeoutMs?: number;
    },
  ) => {
    const includeMangaDex = options?.includeMangaDex ?? true;
    const attachRatings = options?.attachRatings ?? true;
    const mangaDexLimit = Number(options?.mangaDexLimit);
    const mangaDexTimeoutMs = Number(options?.mangaDexTimeoutMs);
    const query = new URLSearchParams({
      keyword,
      page: String(page),
      include_mangadex: includeMangaDex ? "1" : "0",
      attach_ratings: attachRatings ? "1" : "0",
    });
    if (Number.isFinite(mangaDexLimit) && mangaDexLimit > 0) {
      query.set("mangadex_limit", String(Math.floor(mangaDexLimit)));
    }
    if (Number.isFinite(mangaDexTimeoutMs) && mangaDexTimeoutMs > 0) {
      query.set("mangadex_timeout_ms", String(Math.floor(mangaDexTimeoutMs)));
    }
    const mangaDexTranslatedLanguage = String(options?.mangaDexTranslatedLanguage || '').trim();
    if (mangaDexTranslatedLanguage) {
      query.set("mangadex_translated_language", mangaDexTranslatedLanguage);
    }
    if (typeof options?.mangaDexAttachLatest === 'boolean') {
      query.set("mangadex_attach_latest", options.mangaDexAttachLatest ? "1" : "0");
    }
    return api<any>(`/api/manga/search?${query.toString()}`, {
      skipAuth: options?.skipAuth ?? false,
      timeoutMs: options?.timeoutMs,
    });
  },
  getChapter: (id: string) => api<any>(`/api/manga/chapter/${id}`),
  getRandom: () => api<any>("/api/manga/random"),
  getTrending: (limit = 20, source: "all" | "otruyen" | "mangadex" = "all") => {
    const query = new URLSearchParams({
      limit: String(limit),
      source,
    });
    return api<any>(`/api/manga/trending?${query.toString()}`);
  },
};

// ─── Auth API (Flask) ───
export const authApi = {
  register: async (
    email: string,
    password: string,
    username: string,
    displayName?: string,
    recaptchaToken?: string,
  ) => {
    const hashed = await hashPassword(password, email);
    return auth<any>("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email,
        password: hashed,
        username,
        displayName,
        recaptcha_token: recaptchaToken || "",
      }),
    });
  },
  login: async (email: string, password: string, recaptchaToken?: string) => {
    const hashed = await hashPassword(password, email);
    const legacyPbkdf2Hash = await hashPasswordV3(password);
    const legacyHash = await hashPasswordLegacy(password);
    const data = await auth<any>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password: hashed,
        password_legacy: legacyPbkdf2Hash,
        legacy_password: legacyHash,
        recaptcha_token: recaptchaToken || "",
      }),
    });
    if (data.session) {
      setTokens(data.session.access_token);
    }
    return data;
  },
  logout: (scope: "local" | "global" | "others" = "local") =>
    auth<any>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ scope }),
    }),
  getMe: () => auth<any>("/auth/me", { timeoutMs: 10_000 }),
  ping: () => auth<any>("/auth/ping"),
  forgotPassword: (email: string, recaptchaToken?: string) =>
    auth<any>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email, recaptcha_token: recaptchaToken || "" }),
    }),
  verifyOtp: (token: string, type = "email") =>
    auth<any>("/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ token, type }),
    }),
  resetPassword: async (password: string) => {
    const me = await authApi.getMe().catch(() => null);
    const accountHint = me?.auth_email || me?.profile?.email || "";
    const hashed = await hashPassword(password, accountHint);
    return auth<any>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ password: hashed }),
    });
  },
  changePassword: async (currentPassword: string, newPassword: string) => {
    const me = await authApi.getMe().catch(() => null);
    const accountHint = me?.auth_email || me?.profile?.email || "";
    const currentHash = await hashPassword(currentPassword, accountHint);
    const currentLegacyPbkdf2Hash = await hashPasswordV3(currentPassword);
    const currentLegacyHash = await hashPasswordLegacy(currentPassword);
    const newHash = await hashPassword(newPassword, accountHint);
    return auth<any>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentHash,
        current_password_legacy: currentLegacyPbkdf2Hash,
        current_password_legacy_v2: currentLegacyHash,
        password: newHash,
      }),
    });
  },
  refresh: async () => {
    if (!accessToken && await waitForPeerAccessToken()) {
      return true;
    }
    if (refreshBlockedUntil > Date.now()) {
      return waitForPeerAccessToken(1_000);
    }
    return withRefreshLock(async () => {
      try {
        if (accessToken && !shouldRefreshBeforeRequest(accessToken)) {
          return true;
        }
        if (!accessToken && await waitForPeerAccessToken(800)) {
          return true;
        }

        for (let attempt = 0; attempt < REFRESH_RETRYABLE_ATTEMPTS; attempt += 1) {
          const response = await authRawResponse("/auth/refresh", {
            method: "POST",
            body: JSON.stringify({ access_token: accessToken || "" }),
            timeoutMs: 20_000,
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok) {
            if (data.session) {
              setTokens(data.session.access_token);
              return true;
            }
            markRefreshFailure("refresh failed", false);
            setRefreshBackoff("refresh failed");
            return false;
          }

          const message = String(
            data?.error ||
            data?.detail ||
            `refresh failed: ${response.status}`,
          );
          if (response.status === 409 || data?.requires_retry) {
            markRefreshFailure(message, false);
            if (await waitForPeerAccessToken(1_000)) {
              markRefreshFailure("", false);
              refreshBlockedUntil = 0;
              return true;
            }
            if (attempt < REFRESH_RETRYABLE_ATTEMPTS - 1) {
              await sleep(REFRESH_RETRYABLE_DELAY_MS * (attempt + 1));
              continue;
            }
            setRefreshRetryableBackoff();
            return false;
          }

          const hardFailure = Boolean(data?.requires_relogin) || isHardRefreshFailure(message);
          markRefreshFailure(message, hardFailure);
          setRefreshBackoff(message);
          return false;
        }

        markRefreshFailure("refresh retry exhausted", false);
        setRefreshRetryableBackoff();
        return false;
      } catch (e: any) {
        const message = String(e?.message || "refresh error");
        const hardFailure = isHardRefreshFailure(message);
        markRefreshFailure(message, hardFailure);
        if (hardFailure && await waitForPeerAccessToken(1_000)) {
          markRefreshFailure("", false);
          refreshBlockedUntil = 0;
          return true;
        }
        setRefreshBackoff(message);
        return false;
      }
    });
  },
  googleLogin: async () => {
    const data = await auth<any>("/auth/google", { method: "POST" });
    return data;
  },
  discordLogin: async () => {
    const data = await auth<any>("/auth/discord", { method: "POST" });
    return data;
  },
  oauthCallback: async (accessToken: string, refreshToken: string) => {
    const data = await auth<any>("/auth/oauth/callback", {
      method: "POST",
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
      }),
    });
    if (data.session) {
      setTokens(data.session.access_token);
    }
    return data;
  },
  oauthExchangeCode: async (code: string) => {
    const data = await auth<any>("/auth/oauth/code", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (data.session) {
      setTokens(data.session.access_token);
    }
    return data;
  },
};

// ─── User API ───
export const userApi = {
  getProfile: () => api<any>("/api/users/profile"),
  getPublicProfile: (userId: string) =>
    api<any>(`/api/users/profile/${encodeURIComponent(userId)}`),
  updateProfile: (data: Record<string, any>) =>
    api<any>("/api/users/profile", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  uploadAvatar: async (file: File, cropArea?: AvatarCropArea) => {
    const formData = new FormData();
    formData.append("avatar", file);
    if (cropArea) {
      formData.append("crop_x", String(Math.round(cropArea.x)));
      formData.append("crop_y", String(Math.round(cropArea.y)));
      formData.append("crop_width", String(Math.round(cropArea.width)));
      formData.append("crop_height", String(Math.round(cropArea.height)));
    }

    return api<any>("/api/users/profile/avatar", {
      method: "POST",
      body: formData,
      timeoutMs: 60_000,
    });
  },
  getSettings: () => api<any>("/api/users/settings"),
  updateSettings: (data: Record<string, any>) =>
    api<any>("/api/users/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getStats: () => api<any>("/api/users/stats"),
  searchUsers: (q: string, limit = 10) =>
    api<any>(`/api/users/search?q=${encodeURIComponent(q)}&limit=${limit}`),
};

// ─── Bookmarks API ───
export const bookmarkApi = {
  getAll: () => api<any>("/api/bookmarks/"),
  add: (slug: string, title = "", thumb = "") =>
    api<any>("/api/bookmarks/", {
      method: "POST",
      body: JSON.stringify({
        manga_slug: slug,
        manga_title: title,
        manga_thumb: thumb,
      }),
    }),
  remove: (slug: string) =>
    api<any>(`/api/bookmarks/${slug}`, { method: "DELETE" }),
  check: (slug: string) => api<any>(`/api/bookmarks/check/${slug}`),
};

// ─── Follows API ───
export const followApi = {
  getAll: () => api<any>("/api/bookmarks/follows"),
  add: (slug: string, title = "", thumb = "") =>
    api<any>("/api/bookmarks/follows", {
      method: "POST",
      body: JSON.stringify({
        manga_slug: slug,
        manga_title: title,
        manga_thumb: thumb,
      }),
    }),
  remove: (slug: string) =>
    api<any>(`/api/bookmarks/follows/${slug}`, { method: "DELETE" }),
  check: (slug: string) => api<any>(`/api/bookmarks/follows/check/${slug}`),
};

// ─── History API ───
export const historyApi = {
  getAll: () => api<any>("/api/history/"),
  add: (entry: {
    manga_slug: string;
    manga_title?: string;
    manga_thumb?: string;
    chapter_id: string;
    chapter_name?: string;
    page?: number;
    progress?: number;
    client_read_at?: string;
  }, options?: Pick<ApiRequestInit, "keepalive" | "timeoutMs">) =>
    api<any>("/api/history/", {
      method: "POST",
      body: JSON.stringify(entry),
      keepalive: options?.keepalive,
      timeoutMs: options?.timeoutMs,
    }),
  remove: (slug: string) =>
    api<any>(`/api/history/${slug}`, { method: "DELETE" }),
  clear: () => api<any>("/api/history/", { method: "DELETE" }),
};

// ─── Comments API ───
export const commentApi = {
  getMine: (page = 1, limit = 50) =>
    api<any>(`/api/comments/me?page=${page}&limit=${limit}`),
  getByManga: (slug: string, chapterId?: string, page = 1) => {
    let url = `/api/comments/manga/${slug}?page=${page}`;
    if (chapterId) url += `&chapter_id=${chapterId}`;
    return api<any>(url);
  },
  create: (data: {
    manga_slug: string;
    content: string;
    chapter_id?: string;
    parent_id?: string;
    image_url?: string;
  }) =>
    api<any>("/api/comments/", { method: "POST", body: JSON.stringify(data) }),
  uploadImage: async (mangaSlug: string, file: File, chapterId?: string) => {
    const formData = new FormData();
    formData.append("manga_slug", mangaSlug);
    if (chapterId) formData.append("chapter_id", chapterId);
    formData.append("image", file);
    return api<any>("/api/comments/upload-image", {
      method: "POST",
      body: formData,
    });
  },
  update: (id: string, content: string) =>
    api<any>(`/api/comments/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  delete: (id: string) => api<any>(`/api/comments/${id}`, { method: "DELETE" }),
  toggleLike: (id: string) =>
    api<any>(`/api/comments/${id}/like`, { method: "POST" }),
  toggleReaction: (id: string, emoji: string, previousEmoji?: string | null) =>
    api<any>(`/api/comments/${id}/reaction`, {
      method: "POST",
      body: JSON.stringify({ emoji, previous_emoji: previousEmoji ?? null }),
    }),
};

// ─── Notifications API ───
export const notificationApi = {
  getAll: (page = 1, limit = 20) =>
    api<any>(`/api/notifications/?page=${page}&limit=${limit}`),
  markRead: (id: string) =>
    api<any>(`/api/notifications/${id}/read`, { method: "PUT" }),
  markAllRead: () => api<any>("/api/notifications/read-all", { method: "PUT" }),
  delete: (id: string) =>
    api<any>(`/api/notifications/${id}`, { method: "DELETE" }),
  clear: () => api<any>("/api/notifications/", { method: "DELETE" }),
};

// ─── Reports API ───
export const reportApi = {
  create: (data: {
    report_type: string;
    target_id?: string;
    title: string;
    description: string;
    recaptcha_token?: string;
  }) =>
    api<any>("/api/reports/", { method: "POST", body: JSON.stringify(data) }),
  getOwn: () => api<any>("/api/reports/"),
};

// ─── Public Site Announcements ───
export const announcementApi = {
  getActive: (limit = 3) =>
    api<any>(`/api/admin/announcements/active?limit=${limit}`, {
      skipAuth: true,
      timeoutMs: 5_000,
    }),
};

// ─── Admin API ───
export const adminApi = {
  getMaintenance: () => admin<any>("/api/admin/maintenance"),
  updateMaintenance: (data: {
    enabled: boolean;
    title?: string;
    message?: string;
    image_url?: string;
    starts_at?: string;
    ends_at?: string;
  }) =>
    admin<any>("/api/admin/maintenance", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getStats: () => admin<any>("/api/admin/stats"),
  getAnalytics: () => admin<any>("/api/admin/analytics"),
  getUsers: (page = 1, search?: string, role?: string) => {
    let url = `/api/admin/users?page=${page}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (role) url += `&role=${role}`;
    return admin<any>(url);
  },
  banUser: (userId: string, reason = "") =>
    admin<any>("/api/admin/ban", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, ban_reason: reason }),
    }),
  unbanUser: (userId: string) =>
    admin<any>(`/api/admin/unban/${userId}`, { method: "POST" }),
  changeRole: (userId: string, role: string) =>
    admin<any>("/api/admin/change-role", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, role }),
    }),
  getReports: (page = 1, status?: string) => {
    let url = `/api/admin/reports?page=${page}`;
    if (status) url += `&status=${status}`;
    return admin<any>(url);
  },
  updateReport: (id: string, status: string, note?: string) => {
    let url = `/api/admin/reports/${id}?status=${status}`;
    if (note) url += `&admin_note=${encodeURIComponent(note)}`;
    return admin<any>(url, { method: "PUT" });
  },
  getCommentById: (id: string) => admin<any>(`/api/admin/comments/${id}`),
  deleteComment: (id: string) =>
    admin<any>(`/api/admin/comments/${id}`, { method: "DELETE" }),
  getAuditLog: (page = 1) => admin<any>(`/api/admin/audit-log?page=${page}`),
  getUserComments: (userId: string, limit = 10) =>
    admin<any>(`/api/admin/users/${userId}/comments?limit=${limit}`),
  getUserHistory: (userId: string, limit = 10) =>
    admin<any>(`/api/admin/users/${userId}/history?limit=${limit}`),
  getUploads: (page = 1, status?: string) => {
    let url = `/api/admin/uploads?page=${page}`;
    if (status) url += `&status=${status}`;
    return admin<any>(url);
  },
  getMangaUploads: (page = 1, status?: string) => {
    let url = `/api/admin/manga-uploads?page=${page}`;
    if (status) url += `&status=${status}`;
    return admin<any>(url);
  },
  reviewUpload: (id: string, action: "approve" | "reject", reason?: string) => {
    let url = `/api/admin/uploads/${id}?action=${action}`;
    if (reason) url += `&reason=${encodeURIComponent(reason)}`;
    return admin<any>(url, { method: "PUT" });
  },
  deleteUpload: (id: string) =>
    admin<any>(`/api/admin/uploads/${id}`, { method: "DELETE" }),
  reviewMangaUpload: (
    id: string,
    action: "approve" | "reject",
    reason?: string,
  ) => {
    let url = `/api/admin/manga-uploads/${id}?action=${action}`;
    if (reason) url += `&reason=${encodeURIComponent(reason)}`;
    return admin<any>(url, { method: "PUT" });
  },
  deleteMangaUpload: (id: string) =>
    admin<any>(`/api/admin/manga-uploads/${id}`, { method: "DELETE" }),
  notifyAll: (data: {
    title: string;
    message: string;
    target?: string;
    notify_type?: string;
    announcement_type?: string;
    show_popup?: boolean;
    popup_expires_hours?: number;
    image_url?: string | null;
    cta_label?: string | null;
    cta_url?: string | null;
    popup_size?: string;
    popup_dismissible?: boolean;
    priority?: number;
  }) =>
    admin<any>("/api/admin/notify", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getAnnouncements: (page = 1, status = "all") =>
    admin<any>(`/api/admin/announcements?page=${page}&status=${encodeURIComponent(status)}`),
  createAnnouncement: (data: any) =>
    admin<any>("/api/admin/announcements", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  uploadAnnouncementImage: (file: File) => {
    const formData = new FormData();
    formData.append("image", file);
    return admin<any>("/api/admin/announcements/upload-image", {
      method: "POST",
      body: formData,
      timeoutMs: 60_000,
    });
  },
  getMaintenanceImages: () => admin<any>("/api/admin/maintenance/images"),
  uploadMaintenanceImage: (
    file: File,
    cropArea?: { x: number; y: number; width: number; height: number },
  ) => {
    const formData = new FormData();
    formData.append("image", file);
    if (cropArea) {
      formData.append("crop_x", String(Math.round(cropArea.x)));
      formData.append("crop_y", String(Math.round(cropArea.y)));
      formData.append("crop_width", String(Math.round(cropArea.width)));
      formData.append("crop_height", String(Math.round(cropArea.height)));
    }
    return admin<any>("/api/admin/maintenance/upload-image", {
      method: "POST",
      body: formData,
      timeoutMs: 60_000,
    });
  },
  deleteMaintenanceImage: (imageUrl: string) =>
    admin<any>("/api/admin/maintenance/images", {
      method: "DELETE",
      body: JSON.stringify({ image_url: imageUrl }),
    }),
  updateAnnouncement: (id: string, data: any) =>
    admin<any>(`/api/admin/announcements/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAnnouncement: (id: string) =>
    admin<any>(`/api/admin/announcements/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  setVip: (userId: string, isVip: boolean, vipExpiry?: string) =>
    admin<any>(`/api/admin/users/${userId}/vip`, {
      method: "PUT",
      body: JSON.stringify({ is_vip: isVip, vip_expiry: vipExpiry ?? null }),
    }),
  getAllComments: (page = 1, search?: string, mangaSlug?: string) => {
    let url = `/api/admin/comments?page=${page}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (mangaSlug) url += `&manga_slug=${encodeURIComponent(mangaSlug)}`;
    return admin<any>(url);
  },
  exportUsersCSV: async () => {
    const res = await adminResponse("/api/admin/export/users", {
      timeoutMs: 60_000,
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  // ─── Manga Management ───
  getMangaList: (page = 1, search?: string, filterHidden?: string, source = "db") => {
    let url = `/api/admin/manga-list?page=${page}&limit=30&source=${source}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (filterHidden) url += `&filter_hidden=${filterHidden}`;
    return admin<any>(url);
  },
  hideManga: (slug: string, reason = "") =>
    admin<any>(`/api/admin/manga/${encodeURIComponent(slug)}/hide?reason=${encodeURIComponent(reason)}`, { method: "POST" }),
  showManga: (slug: string) =>
    admin<any>(`/api/admin/manga/${encodeURIComponent(slug)}/show`, { method: "POST" }),
  updateMangaSettings: (slug: string, opts: { is_featured?: boolean; admin_notes?: string }) => {
    return admin<any>(`/api/admin/manga/${encodeURIComponent(slug)}/settings`, {
      method: "PUT",
      body: JSON.stringify(opts),
    });
  },
};

// ─── Uploads API (uploader) ───
export const uploadApi = {
  /** Upload chapter page images to Supabase Storage */
  uploadImages: async (
    mangaSlug: string,
    chapterNumber: string,
    files: File[],
  ) => {
    const formData = new FormData();
    formData.append("manga_slug", mangaSlug);
    formData.append("chapter_number", chapterNumber);
    files.forEach((file) => formData.append("files", file));

    return api<any>("/api/uploads/images", {
      method: "POST",
      body: formData,
      timeoutMs: 120_000,
    });
  },
  getMyUploads: (page = 1, status?: string) => {
    let url = `/api/uploads/?page=${page}`;
    if (status) url += `&status=${status}`;
    return api<any>(url);
  },
  getMyMangaUploads: (page = 1, status?: string) => {
    let url = `/api/uploads/manga?page=${page}`;
    if (status) url += `&status=${status}`;
    return api<any>(url);
  },
  getMangaUpload: (id: string) => api<any>(`/api/uploads/manga/${id}`),
  updateManga: (id: string, data: Record<string, any>) =>
    api<any>(`/api/uploads/manga/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteManga: (id: string) =>
    api<any>(`/api/uploads/manga/${id}`, { method: "DELETE" }),
  createManga: async (data: {
    title: string;
    author: string;
    artist?: string;
    mangaType?: string;
    publishStatus?: "ongoing" | "completed";
    description?: string;
    genres?: string[];
    language?: string;
    groupId?: string;
    status: "draft" | "pending";
    cover: File;
  }) => {
    const formData = new FormData();
    formData.append("title", data.title);
    formData.append("author", data.author);
    formData.append("artist", data.artist || "");
    formData.append("manga_type", data.mangaType || "manga");
    formData.append("publish_status", data.publishStatus || "ongoing");
    formData.append("description", data.description || "");
    formData.append("genres", JSON.stringify(data.genres || []));
    formData.append("language", data.language || "vi");
    formData.append("status", data.status);
    if (data.groupId) formData.append("group_id", data.groupId);
    formData.append("cover", data.cover);

    return api<any>("/api/uploads/manga", {
      method: "POST",
      body: formData,
      timeoutMs: 120_000,
    });
  },
  getUpload: (id: string) => api<any>(`/api/uploads/${id}`),
  create: (data: Record<string, any>) =>
    api<any>("/api/uploads/", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, any>) =>
    api<any>(`/api/uploads/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => api<any>(`/api/uploads/${id}`, { method: "DELETE" }),
  /** Public: published (approved) chapters for a manga */
  getPublishedChapters: (mangaSlug: string) =>
    api<any>(`/api/uploads/published/${encodeURIComponent(mangaSlug)}`),
};

export const imageEditorApi = {
  getFonts: () => api<any>("/api/editor/fonts"),
  inpaint: (
    file: File,
    options: {
      mode: "region" | "all" | "brush";
      regions?: Array<Record<string, any>>;
      brushMask?: string;
      brushRadius?: number;
      maskWidth?: number;
      maskHeight?: number;
    },
  ) => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("mode", options.mode);
    formData.append("regions", JSON.stringify(options.regions || []));
    if (options.mode === "brush") {
      formData.append("brush_mask", String(options.brushMask || ""));
      formData.append("brush_radius", String(options.brushRadius || 14));
      formData.append("mask_width", String(options.maskWidth || 0));
      formData.append("mask_height", String(options.maskHeight || 0));
    }
    return api<any>("/api/editor/inpaint", {
      method: "POST",
      body: formData,
    });
  },
  addText: (file: File, overlays: Array<Record<string, any>>) => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("overlays", JSON.stringify(overlays || []));
    return api<any>("/api/editor/add-text", {
      method: "POST",
      body: formData,
    });
  },
  detectFont: (file: File, region: Record<string, any>, sampleText = "") => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("region", JSON.stringify(region || {}));
    formData.append("sample_text", sampleText || "");
    return api<any>("/api/editor/detect-font", {
      method: "POST",
      body: formData,
    });
  },
  aiTranslate: (
    file: File,
    options?: {
      targetLanguage?: string;
      fontName?: string;
      regions?: Array<Record<string, any>>;
      geminiCookies?: string;
      aiProvider?: "gemini" | "openai-compatible";
      aiModel?: string;
      aiApiKey?: string;
      aiBaseUrl?: string;
    },
  ) => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("target_language", options?.targetLanguage || "vi");
    formData.append("font_name", options?.fontName || "Comic Sans MS");
    formData.append("regions", JSON.stringify(options?.regions || []));
    formData.append("gemini_cookies", options?.geminiCookies || "");
    formData.append("ai_provider", options?.aiProvider || "gemini");
    formData.append("ai_model", options?.aiModel || "");
    formData.append("ai_api_key", options?.aiApiKey || "");
    formData.append("ai_base_url", options?.aiBaseUrl || "");
    return api<any>("/api/editor/ai-translate", {
      method: "POST",
      body: formData,
      timeoutMs: 600_000,
    });
  },

  aiRemoveOnly: (
    file: File,
    options?: {
      geminiCookies?: string;
      aiProvider?: "gemini" | "openai-compatible";
      aiModel?: string;
      aiApiKey?: string;
      aiBaseUrl?: string;
      regions?: Array<Record<string, any>>;
    },
  ) => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("target_language", "");
    formData.append("font_name", "");
    formData.append("mode", "remove_only");
    formData.append("regions", JSON.stringify(options?.regions || []));
    formData.append("gemini_cookies", options?.geminiCookies || "");
    formData.append("ai_provider", options?.aiProvider || "gemini");
    formData.append("ai_model", options?.aiModel || "");
    formData.append("ai_api_key", options?.aiApiKey || "");
    formData.append("ai_base_url", options?.aiBaseUrl || "");
    return api<any>("/api/editor/ai-translate", {
      method: "POST",
      body: formData,
      timeoutMs: 600_000,
    });
  },

  ocrRegion: (
    file: File,
    region: Record<string, any>,
  ) => {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("region", JSON.stringify(region || {}));
    return api<any>("/api/editor/ocr-region", {
      method: "POST",
      body: formData,
      timeoutMs: 60_000,
    });
  },

  translateText: (
    text: string,
    sourceLanguage = "ja",
    targetLanguage = "vi",
  ) => {
    const formData = new FormData();
    formData.append("text", text);
    formData.append("source_language", sourceLanguage);
    formData.append("target_language", targetLanguage);
    return api<any>("/api/editor/translate-text", {
      method: "POST",
      body: formData,
      timeoutMs: 30_000,
    });
  },
};

// ─── Ratings API ───
export const ratingApi = {
  getMangaRating: (slug: string) => api<any>(`/api/ratings/manga/${slug}`),
  getMyRating: (slug: string) => api<any>(`/api/ratings/manga/${slug}/me`),
  getMyRatedManga: (limit = 200) =>
    api<any>(`/api/ratings/me?limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`),
  getTopRatedManga: (limit = 24) =>
    api<any>(`/api/ratings/top?limit=${Math.max(1, Math.min(120, Math.floor(limit)))}`),
  getBatchRatings: (slugs: string[], timeoutMs?: number) =>
    api<any>("/api/ratings/batch", {
      method: "POST",
      body: JSON.stringify({ manga_slugs: slugs }),
      ...(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? { timeoutMs }
        : {}),
    }),
  rate: (slug: string, score: number) =>
    api<any>("/api/ratings/", {
      method: "POST",
      body: JSON.stringify({ manga_slug: slug, score }),
    }),
  remove: (slug: string) =>
    api<any>(`/api/ratings/manga/${slug}`, { method: "DELETE" }),
};

// ─── Groups API ───
export const groupApi = {
  getMyGroups: () => api<any>("/api/groups/"),
  getGroup: (id: string) => api<any>(`/api/groups/${id}`),
  create: (data: { name: string; description?: string; logo?: string }) =>
    api<any>("/api/groups/", { method: "POST", body: JSON.stringify(data) }),
  updateGroup: (
    id: string,
    data: { name?: string; description?: string; logo?: string },
  ) =>
    api<any>(`/api/groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteGroup: (id: string) =>
    api<any>(`/api/groups/${id}`, { method: "DELETE" }),
  addMember: (groupId: string, userId: string, role = "member") =>
    api<any>(`/api/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId, role }),
    }),
  removeMember: (groupId: string, userId: string) =>
    api<any>(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
};
