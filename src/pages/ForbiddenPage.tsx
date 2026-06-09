import { motion } from 'framer-motion';
import { ShieldX, ArrowLeft, Mail, Info } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

const ForbiddenPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-lg space-y-6"
      >
        <div className="text-center space-y-3">
          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 180, damping: 14 }}
            className="mx-auto w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center"
          >
            <ShieldX className="w-10 h-10 text-destructive" />
          </motion.div>
          <h1 className="text-2xl font-black text-foreground">Không đủ quyền truy cập</h1>
          <p className="text-sm text-muted-foreground">
            Bạn không có quyền truy cập khu vực này.
          </p>
        </div>

        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="bg-destructive/5 border-b border-border px-5 py-3 flex items-center gap-2">
            <Info className="w-4 h-4 text-destructive" />
            <span className="text-sm font-bold text-destructive">Thông báo bảo mật</span>
          </div>
          <div className="p-5 space-y-3 text-sm">
            <p className="text-muted-foreground pt-1">
              Vì lý do bảo mật, hệ thống không hiển thị chi tiết phân quyền trên trang này.
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            <span className="text-sm font-bold">Bạn có thể làm gì?</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Nếu bạn cần truy cập khu vực này cho công việc kiểm duyệt, hãy liên hệ Admin để được cấp đúng quyền.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              onClick={() => navigate(-1)}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-bold hover:bg-secondary/80 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Quay lại
            </button>
            <Link
              to="/support"
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
            >
              <Mail className="w-4 h-4" /> Liên hệ hỗ trợ
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default ForbiddenPage;
