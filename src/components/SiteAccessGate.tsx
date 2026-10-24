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

// The server controls the access session's expiry. A short in-memory grant
// supports older backends during rollout. Account changes and explicit denials
// always close the reader until its own session has been checked.
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
    staleTime: query => query.state.data?.access_expires_at ? Infinity : 0,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 600,
    refetchInterval: query => query.state.data?.access_expires_at && query.state.status !== 'error' ? false : 10_000,
    refetchOnWindowFocus: query => !query.state.data?.access_expires_at,
    refetchOnReconnect: query => !query.state.data?.access_expires_at,
  });
  const wasAllowed = useRef(false);
  const previousViewer = useRef(key[1]);
  const [, checkGrantExpiry] = useState(0);

  useEffect(() => {
    if (!access.isFetchedAfterMount || !access.data?.allowed) return;
    if (access.data.access_expires_at) {
      const remaining = access.data.access_expires_at - Date.now() - 30_000;
      const timer = window.setTimeout(() => void access.refetch(), Math.max(0, remaining));
      const expiry = window.setTimeout(() => checkGrantExpiry(value => value + 1), Math.max(0, remaining + 30_001));
      return () => { window.clearTimeout(timer); window.clearTimeout(expiry); };
    }
    const remaining = access.dataUpdatedAt + ACCESS_GRANT_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => checkGrantExpiry(value => value + 1), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [access.dataUpdatedAt, access.data?.allowed, access.data?.access_expires_at, access.isFetchedAfterMount, key[1]]);

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

  const grantFresh = Date.now() < (access.data?.access_expires_at || access.dataUpdatedAt + ACCESS_GRANT_MS);
  // A background /auth/me or refresh failure can mark the existing account as
  // restoring. It must not tear down an already approved reader. This applies
  // only to the same known account and never extends the server grant's expiry.
  const restoringApprovedViewer =
    isRestoringSession &&
    isLoggedIn &&
    !!user?.id &&
    wasAllowed.current &&
    previousViewer.current === key[1];
  const allowed =
    (ready || restoringApprovedViewer) &&
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
    if (previousViewer.current !== key[1]) {
      // A later login, including the same account, must obtain its own grant.
      client.removeQueries({ queryKey: ["site-access", previousViewer.current], exact: true });
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
