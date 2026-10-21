import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import SiteAccessScreen from "./SiteAccessScreen";
import { useUserStore } from "@/store/userStore";
import {
  FORCE_SITE_ACCESS_EVENT,
  setSiteAccessRestricted,
  siteAccessApi,
  type SiteAccessState,
} from "@/lib/api";
import { CatalogUpdates } from "@/hooks/useCatalogUpdates";
import { clearCoverCache } from '@/lib/coverCache';

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
    retry: 1,
    retryDelay: 600,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const wasAllowed = useRef(false);
  const previousViewer = useRef(key[1]);

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
    if ((wasAllowed.current && !allowed) || previousViewer.current !== key[1]) {
      clearCoverCache();
      // Drop loaded catalog/detail data when an account loses access or logs out.
      const predicate = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] !== "site-access";
      void client.cancelQueries({ predicate });
      client.removeQueries({ predicate });
    }
    wasAllowed.current = allowed;
    previousViewer.current = key[1];
  }, [allowed, access.data?.enabled, client, key[1]]);

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
  return <SiteAccessScreen loading={loading} failed={access.isError} fetching={access.isFetching}
    loggedIn={isLoggedIn} admin={user?.role === "admin"} message={access.data?.message}
    onRetry={() => void access.refetch()} onLogout={() => logout()} />;
}
