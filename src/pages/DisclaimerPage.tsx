import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertTriangle, Mail, ShieldCheck } from 'lucide-react';

const DisclaimerPage = () => (
  <div className="container mx-auto px-4 py-8">
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-3xl"
    >
      <div className="flex items-center gap-3 mb-6">
        <div className="accent-line" />
        <h1 className="ed-heading text-3xl">Miễn Trừ Trách Nhiệm</h1>
      </div>

      <div className="ed-card p-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Nội dung truyện trên website được tổng hợp từ nhiều nguồn công khai trên Internet,
              chỉ nhằm mục đích giải trí. Mọi bản quyền thuộc về tác giả và nhà phát hành.
              Vui lòng liên hệ nếu có vấn đề về bản quyền.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="ed-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Bản quyền</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Nếu bạn là chủ sở hữu bản quyền hoặc đại diện hợp pháp, hãy gửi thông tin tác phẩm
            và yêu cầu xử lý để MangaHub kiểm tra trong thời gian sớm nhất.
          </p>
        </div>

        <div className="ed-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Liên hệ</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Gửi yêu cầu qua trang liên hệ hoặc ticket hỗ trợ để đội ngũ có đủ thông tin xử lý.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/contact"
              className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Liên hệ
            </Link>
            <Link
              to="/support"
              className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Gửi ticket
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  </div>
);

export default DisclaimerPage;
