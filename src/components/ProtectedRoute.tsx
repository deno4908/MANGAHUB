import { Navigate } from 'react-router-dom';
import { useEffect } from 'react';
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

const LoadingGate = () => (
  <div className="flex items-center justify-center min-h-[60vh]">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
  </div>
);

const ProtectedRoute = ({ children, requireAuth = true, allowedRoles }: ProtectedRouteProps) => {
  const { user, isLoggedIn, isLoading, hasCheckedSession, loadUser } = useUserStore();

  useEffect(() => {
    if (!hasCheckedSession && !isLoading) {
      loadUser();
    }
  }, [hasCheckedSession, isLoading, loadUser]);

  if (!hasCheckedSession || isLoading) {
    return <LoadingGate />;
  }

  if (requireAuth && !isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (requireAuth && isLoggedIn && !user) {
    return <LoadingGate />;
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
