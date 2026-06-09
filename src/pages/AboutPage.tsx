import { motion } from 'framer-motion';
import { BookOpen, Users, Globe, Heart, Zap, Shield } from 'lucide-react';
import { SUPPORT_EMAIL } from '@/lib/support';

const features = [
  { icon: BookOpen, title: 'Kho truyện đa dạng', desc: 'Manga, Manhwa, Webtoon — tất cả trong một nền tảng duy nhất.' },
  { icon: Zap, title: 'Tốc độ tải nhanh', desc: 'Tối ưu hình ảnh và lazy loading để trải nghiệm đọc mượt mà nhất.' },
  { icon: Users, title: 'Cộng đồng sôi động', desc: 'Bình luận, đánh giá và chia sẻ truyện yêu thích với mọi người.' },
  { icon: Globe, title: 'Đa ngôn ngữ', desc: 'Hỗ trợ nhiều nhóm dịch với các ngôn ngữ khác nhau.' },
  { icon: Shield, title: 'An toàn & riêng tư', desc: 'Bảo vệ thông tin cá nhân và lịch sử đọc của bạn.' },
  { icon: Heart, title: 'Miễn phí hoàn toàn', desc: 'Đọc truyện không giới hạn, không cần trả phí.' },
];

const stats = [
  { value: '50+', label: 'Truyện' },
  { value: '1000+', label: 'Chương' },
  { value: '20+', label: 'Thể loại' },
  { value: '10K+', label: 'Người đọc' },
];

const AboutPage = () => (
  <div className="container mx-auto px-4 py-8">
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="accent-line" />
        <h1 className="ed-heading text-3xl">Về MangaHub</h1>
      </div>

      <div className="ed-card p-6 mb-8">
        <p className="text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">MangaHub</span> là nền tảng đọc truyện trực tuyến miễn phí,
          nơi bạn có thể khám phá hàng ngàn bộ truyện Manga, Manhwa và Webtoon từ nhiều nhóm dịch khác nhau.
          Chúng tôi tin rằng mọi người đều xứng đáng được tiếp cận với những câu chuyện tuyệt vời —
          và đó là lý do MangaHub ra đời.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}
            className="ed-card p-4 text-center">
            <p className="text-2xl font-bold text-primary">{s.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
          </motion.div>
        ))}
      </div>

      {/* Features */}
      <h2 className="ed-heading text-xl mb-4">Tính năng nổi bật</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
        {features.map((f, i) => (
          <motion.div key={f.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.05 }}
            className="ed-card p-4 flex gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <f.icon className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{f.desc}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Contact */}
      <div className="ed-card p-6 text-center">
        <h2 className="ed-heading text-xl mb-2">Liên hệ</h2>
        <p className="text-sm text-muted-foreground mb-1">Email: {SUPPORT_EMAIL}</p>
        <p className="text-sm text-muted-foreground">Discord: discord.gg/mangahub</p>
      </div>
    </motion.div>
  </div>
);

export default AboutPage;
