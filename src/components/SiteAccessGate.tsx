import { useEffect, useRef, useState, type ReactNode } from "react";
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

// A short-lived, in-memory grant absorbs a failed background check without
// tearing down the reader and deleting its caches. Initial access and account
// changes still require a fresh response; explicit denials take effect at once.
const ACCESS_GRANT_MS = 60_000;

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
  const [, checkGrantExpiry] = useState(0);

  useEffect(() => {
    if (!access.isFetchedAfterMount || !access.data?.allowed) return;
    const remaining = access.dataUpdatedAt + ACCESS_GRANT_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => checkGrantExpiry(value => value + 1), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [access.dataUpdatedAt, access.data?.allowed, access.isFetchedAfterMount, key[1]]);

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

  const grantFresh = Date.now() < access.dataUpdatedAt + ACCESS_GRANT_MS;
  const allowed =
    ready &&
    access.isFetchedAfterMount &&
    access.data?.allowed === true &&
    grantFresh;
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
  return <SiteAccessScreen loading={loading} failed={access.isError || (access.data?.allowed === true && !grantFresh)} fetching={access.isFetching}
    loggedIn={isLoggedIn} admin={user?.role === "admin"} message={access.data?.message}
    onRetry={() => void access.refetch()} onLogout={() => logout()} />;
}
