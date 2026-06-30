import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useUserStore } from '@/store/userStore';
import BannedPage from '@/pages/BannedPage';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAuth?: boolean;
  allowedRoles?: string[];
}

const ROLE_HIERARCHY: Record<string, number> = {
  reader: 0,
  uploader: 1,
  moderator: 2,
  admin: 3,
};

const LoadingGate = ({
  message = 'Đang tải...',
  showRecovery = false,
  onRetry,
  onRelogin,
}: {
  message?: string;
  showRecovery?: boolean;
  onRetry?: () => void;
  onRelogin?: () => void;
}) => {
  const [showActions, setShowActions] = useState(false);

  useEffect(() => {
    if (!showRecovery) {
      setShowActions(false);
      return;
    }
    const timer = window.setTimeout(() => setShowActions(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [showRecovery]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm font-medium text-muted-foreground">{message}</p>
        {showActions ? (
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-border px-3 py-2 text-sm font-bold text-foreground transition-colors hover:bg-muted"
            >
              Thử lại
            </button>
            <button
              type="button"
              onClick={onRelogin}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Đăng nhập lại
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const ProtectedRoute = ({ children, requireAuth = true, allowedRoles }: ProtectedRouteProps) => {
  const {
    user,
    isLoggedIn,
    isLoading,
    hasCheckedSession,
    isRestoringSession,
    logout,
    loadUser,
  } = useUserStore();

  useEffect(() => {
    if (!hasCheckedSession && !isLoading) {
      loadUser();
    }
  }, [hasCheckedSession, isLoading, loadUser]);

  useEffect(() => {
    if (
      requireAuth &&
      hasCheckedSession &&
      isLoggedIn &&
      !user &&
      !isLoading &&
      !isRestoringSession
    ) {
      const timer = window.setTimeout(() => {
        loadUser({ force: true });
      }, 1_200);
      return () => window.clearTimeout(timer);
    }
  }, [requireAuth, hasCheckedSession, isLoggedIn, user, isLoading, isRestoringSession, loadUser]);

  if (!hasCheckedSession || isLoading) {
    return <LoadingGate />;
  }

  if (requireAuth && !isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (requireAuth && isLoggedIn && !user) {
    return (
      <LoadingGate
        message="Đang khôi phục phiên đăng nhập..."
        showRecovery
        onRetry={() => loadUser({ force: true })}
        onRelogin={() => {
          logout('local', { server: false });
          window.location.href = '/login';
        }}
      />
    );
  }

  if (isLoggedIn && user?.isBanned) {
    return <BannedPage />;
  }

  if (allowedRoles && user) {
    const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
    const minRequired = Math.min(...allowedRoles.map((role) => ROLE_HIERARCHY[role] ?? 0));
    if (userLevel < minRequired) {
      return <Navigate to="/forbidden" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
