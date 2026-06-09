import { Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useUserStore } from '@/store/userStore';
import BannedPage from '@/pages/BannedPage';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAuth?: boolean;
  allowedRoles?: string[];
}

/**
 * Route guard component.
 * - Banned user → shows BannedPage
 * - requireAuth: redirects to /login if not logged in
 * - allowedRoles: redirects to /forbidden if user role not sufficient
 */
const ROLE_HIERARCHY: Record<string, number> = {
  reader: 0,
  uploader: 1,
  moderator: 2,
  admin: 3,
};

const ProtectedRoute = ({ children, requireAuth = true, allowedRoles }: ProtectedRouteProps) => {
  const { user, isLoggedIn, isLoading, hasCheckedSession, loadUser } = useUserStore();

  // Restore an HttpOnly-cookie session once before route decisions.
  useEffect(() => {
    if (!hasCheckedSession && !isLoading) {
      loadUser();
      return;
    }
    if (isLoggedIn && !user && !isLoading) {
      loadUser();
    }
  }, [hasCheckedSession, isLoggedIn, user, isLoading, loadUser]);

  if (!hasCheckedSession || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Not logged in
  if (requireAuth && !isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  // ─── Banned user → show ban screen ───
  if (isLoggedIn && user?.isBanned) {
    return <BannedPage />;
  }

  // Role check → 403 Forbidden
  if (allowedRoles && user) {
    const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
    const minRequired = Math.min(...allowedRoles.map(r => ROLE_HIERARCHY[r] ?? 0));
    if (userLevel < minRequired) {
      return <Navigate to="/forbidden" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
