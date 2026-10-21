import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { Lock, Loader2, LogIn, LogOut, RefreshCw } from "lucide-react";
import { useUserStore } from "@/store/userStore";
import {
  FORCE_SITE_ACCESS_EVENT,
  setSiteAccessRestricted,
  siteAccessApi,
  type SiteAccessState,
} from "@/lib/api";
import { CatalogUpdates } from "@/hooks/useCatalogUpdates";

const AUTH_PATHS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/auth/callback",
  "/banned",
  "/forbidden",
]);

export default function SiteAccessGate({ children }: { children: ReactNode }) {
  const path = useLocation().pathname;
  const client = useQueryClient();
  const {
    user,
    isLoggedIn,
    hasCheckedSession,
    isRestoringSession,
    loadUser,
    logout,
  } = useUserStore();
  const ready = hasCheckedSession && !isRestoringSession;
  const key = ["site-access", isLoggedIn ? user?.id || "restoring" : "guest"];
  const access = useQuery<SiteAccessState>({
    queryKey: key,
    queryFn: () => siteAccessApi.getStatus(),
    enabled: ready,
    staleTime: 0,
    retry: false,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const wasAllowed = useRef(false);

  useEffect(() => {
    if (!hasCheckedSession) void loadUser();
  }, [hasCheckedSession, loadUser]);
  useEffect(() => {
    const denied = (event: Event) => {
      const next = (event as CustomEvent<SiteAccessState>).detail;
      client.setQueryData(key, { ...next, enabled: true, allowed: false });
      void access.refetch();
    };
    window.addEventListener(FORCE_SITE_ACCESS_EVENT, denied);
    return () => window.removeEventListener(FORCE_SITE_ACCESS_EVENT, denied);
  }, [client, key[1]]);

  const allowed =
    ready &&
    access.isFetchedAfterMount &&
    access.data?.allowed === true &&
    !access.isError;
  useEffect(() => {
    setSiteAccessRestricted(access.data?.enabled === true);
    if (wasAllowed.current && !allowed) {
      // Drop loaded catalog/detail data when an account loses access or logs out.
      const predicate = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] !== "site-access";
      void client.cancelQueries({ predicate });
      client.removeQueries({ predicate });
    }
    wasAllowed.current = allowed;
  }, [allowed, access.data?.enabled, client]);

  if (AUTH_PATHS.has(path)) return <>{children}</>;
  // Server endpoints still verify the admin's token and current role.
  const adminRecovery =
    ready &&
    user?.role === "admin" &&
    access.isError &&
    path.startsWith("/admin");
  if (allowed || adminRecovery)
    return (
      <>
        <CatalogUpdates />
        {children}
      </>
    );
  const loading =
    !ready ||
    access.isPending ||
    (!access.isFetchedAfterMount && !access.isError);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        {loading ? (
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-primary" />
        ) : (
          <Lock className="mx-auto mb-4 h-10 w-10 text-primary" />
        )}
        <h1 className="text-2xl font-bold">
          {loading
            ? "Đang kiểm tra quyền truy cập…"
            : access.isError
              ? "Chưa thể kiểm tra quyền truy cập"
              : "Bạn không nằm trong whitelist của website"}
        </h1>
        {!loading && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {access.isError
              ? "Vui lòng thử lại sau. Website sẽ mở khi xác nhận được quyền truy cập của bạn."
              : access.data?.message ||
                "Chỉ admin và tài khoản được admin cho phép mới có thể truy cập."}
          </p>
        )}
        {!loading && (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {!isLoggedIn ? (
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-bold text-primary-foreground"
              >
                <LogIn className="h-4 w-4" />
                Đăng nhập
              </Link>
            ) : (
              <button
                onClick={() => logout()}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2"
              >
                <LogOut className="h-4 w-4" />
                Đổi tài khoản
              </button>
            )}
            <button
              disabled={access.isFetching}
              onClick={() => void access.refetch()}
              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${access.isFetching ? "animate-spin" : ""}`}
              />
              Kiểm tra lại
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
