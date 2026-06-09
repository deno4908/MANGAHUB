import { Navigate } from 'react-router-dom';
import { useUserStore } from '@/store/userStore';

/**
 * GuestRoute — chỉ hiển thị cho người CHƯA đăng nhập.
 * Nếu đã đăng nhập → redirect về trang chủ.
 */
const GuestRoute = ({ children }: { children: React.ReactNode }) => {
  const isLoggedIn = useUserStore(s => s.isLoggedIn);
  const isLoading = useUserStore(s => s.isLoading);
  const hasCheckedSession = useUserStore(s => s.hasCheckedSession);

  if (!hasCheckedSession || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (isLoggedIn) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default GuestRoute;
