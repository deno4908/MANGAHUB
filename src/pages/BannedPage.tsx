import { motion } from 'framer-motion';
import { ShieldX, Mail, AlertTriangle, Clock, FileText, ExternalLink, LogOut } from 'lucide-react';
import { useUserStore } from '@/store/userStore';
import { useNavigate } from 'react-router-dom';
import { getBanLock } from '@/lib/api';
import { supportMailto } from '@/lib/support';
import LegalLinks from '@/components/LegalLinks';

const BannedPage = () => {
  const { user, logout } = useUserStore();
  const navigate = useNavigate();
  const banLock = getBanLock();
  const banInfo = {
    username: user?.username || 'Người dùng',
    reason: user?.banReason || banLock?.ban_reason || banLock?.detail || banLock?.error || 'Vi phạm quy tắc cộng đồng',
    bannedAt: banLock?.at ? new Date(banLock.at).toLocaleString('vi') : new Date().toLocaleString('vi'),
    duration: 'Vĩnh viễn',
    moderator: 'Admin',
    appealDeadline: '',
    violations: [] as { date: string; type: string; reason: string }[],
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-lg space-y-6"
      >
        {/* Icon & Title */}
        <div className="text-center space-y-3">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, delay: 0.2 }}
            className="mx-auto w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center"
          >
            <ShieldX className="w-10 h-10 text-destructive" />
          </motion.div>
          <h1 className="text-2xl font-black text-foreground">Tài khoản đã bị cấm</h1>
          <p className="text-sm text-muted-foreground">
            Tài khoản <span className="font-bold text-foreground">{banInfo.username}</span> đã bị đình chỉ do vi phạm quy tắc cộng đồng.
          </p>
        </div>

        {/* Ban Details Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-card border border-border rounded-2xl overflow-hidden"
        >
          <div className="bg-destructive/5 border-b border-border px-5 py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <span className="text-sm font-bold text-destructive">Chi tiết vi phạm</span>
          </div>
          <div className="p-5 space-y-4">
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Lý do</span>
                <span className="font-semibold text-foreground text-right max-w-[60%]">{banInfo.reason}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Thời gian cấm</span>
                <span className="font-semibold text-foreground">{banInfo.bannedAt}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Thời hạn</span>
                <span className="font-bold text-destructive">{banInfo.duration}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Người xử lý</span>
                <span className="font-semibold text-foreground">{banInfo.moderator}</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Violation History */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-card border border-border rounded-2xl overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-bold">Lịch sử vi phạm</span>
          </div>
          <div className="p-4 space-y-2">
            {banInfo.violations.map((v, i) => (
              <div key={i} className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-secondary/30">
                <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${v.type === 'Cấm' ? 'bg-destructive' : 'bg-yellow-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-bold ${v.type === 'Cấm' ? 'text-destructive' : 'text-yellow-500'}`}>{v.type}</span>
                    <span className="text-[10px] text-muted-foreground">{v.date}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{v.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Appeal Section */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-3"
        >
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            <span className="text-sm font-bold">Kháng cáo</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Bạn có thể gửi yêu cầu kháng cáo trước ngày <span className="font-bold text-foreground">{banInfo.appealDeadline}</span>. 
            Vui lòng liên hệ đội ngũ hỗ trợ qua email hoặc trang hỗ trợ.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <a
              href={supportMailto('Kháng cáo tài khoản bị cấm')}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
            >
              <Mail className="w-4 h-4" /> Gửi email kháng cáo
            </a>
            <a
              href="/support"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-bold hover:bg-secondary/80 transition-colors"
            >
              <ExternalLink className="w-4 h-4" /> Trang hỗ trợ
            </a>
          </div>
        </motion.div>

        {/* Footer note */}
        <p className="text-center text-[11px] text-muted-foreground">
          Nếu bạn cho rằng đây là nhầm lẫn, vui lòng liên hệ hỗ trợ để được xem xét lại.
        </p>

        <LegalLinks className="justify-center" />
        {/* Logout Button */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="text-center"
        >
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-bold hover:bg-secondary/80 transition-colors"
          >
            <LogOut className="w-4 h-4" /> Đăng xuất
          </button>
        </motion.div>
      </motion.div>
    </div>
  );
};

export default BannedPage;
