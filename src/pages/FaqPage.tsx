import { motion } from 'framer-motion';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { HelpCircle, BookOpen, User, Shield, MessageCircle } from 'lucide-react';

const faqCategories = [
  {
    title: 'Đọc truyện',
    icon: BookOpen,
    items: [
      { q: 'Làm sao để đọc truyện?', a: 'Tìm truyện bạn muốn đọc qua trang Khám phá hoặc thanh tìm kiếm, sau đó chọn chương muốn đọc. Bạn có thể điều chỉnh chế độ đọc (dọc/ngang/webtoon) trong cài đặt.' },
      { q: 'Truyện có miễn phí không?', a: 'Hoàn toàn miễn phí! MangaHub cung cấp tất cả truyện không giới hạn và không yêu cầu trả phí.' },
      { q: 'Tôi có thể đọc offline không?', a: 'Hiện tại MangaHub chưa hỗ trợ đọc offline. Bạn cần kết nối internet để đọc truyện.' },
      { q: 'Làm sao để thay đổi chế độ đọc?', a: 'Khi đang đọc truyện, nhấn vào biểu tượng cài đặt ở góc trên để chuyển đổi giữa chế độ đọc dọc, ngang hoặc webtoon.' },
    ],
  },
  {
    title: 'Tài khoản',
    icon: User,
    items: [
      { q: 'Làm sao để tạo tài khoản?', a: 'Nhấn vào nút Đăng ký ở góc trên bên phải, điền thông tin cần thiết và xác nhận email để hoàn tất.' },
      { q: 'Quên mật khẩu thì làm sao?', a: 'Tại trang đăng nhập, chọn "Quên mật khẩu" và nhập email đã đăng ký. Chúng tôi sẽ gửi mã OTP để đặt lại mật khẩu.' },
      { q: 'Làm sao để theo dõi truyện?', a: 'Vào trang chi tiết truyện và nhấn nút "Theo dõi". Bạn sẽ nhận thông báo khi có chương mới.' },
    ],
  },
  {
    title: 'Báo lỗi & Hỗ trợ',
    icon: MessageCircle,
    items: [
      { q: 'Hình ảnh bị lỗi / không tải được?', a: 'Thử tải lại trang (F5). Nếu vẫn lỗi, hãy báo lỗi qua trang Báo lỗi chương để chúng tôi khắc phục.' },
      { q: 'Làm sao để báo lỗi chương?', a: 'Vào trang Báo lỗi, điền tên truyện, số chương và mô tả lỗi. Chúng tôi sẽ xử lý trong thời gian sớm nhất.' },
      { q: 'Tôi muốn đề xuất tính năng mới?', a: 'Gửi đề xuất qua trang Hỗ trợ hoặc liên hệ trực tiếp qua Discord của chúng tôi.' },
    ],
  },
  {
    title: 'Bảo mật & Quyền riêng tư',
    icon: Shield,
    items: [
      { q: 'Dữ liệu cá nhân có an toàn không?', a: 'Chúng tôi cam kết bảo vệ thông tin cá nhân của bạn. Dữ liệu được mã hóa và không chia sẻ với bên thứ ba.' },
      { q: 'Lịch sử đọc có bị ai thấy không?', a: 'Bạn có thể tùy chỉnh quyền riêng tư trong Cài đặt > Quyền riêng tư để ẩn hoặc hiển thị lịch sử đọc.' },
    ],
  },
];

const FaqPage = () => (
  <div className="container mx-auto px-4 py-8 max-w-3xl">
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center gap-3 mb-6">
        <div className="accent-line" />
        <h1 className="ed-heading text-3xl">Câu hỏi thường gặp</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8">
        Tìm câu trả lời cho các câu hỏi phổ biến về MangaHub. Nếu không tìm thấy câu trả lời, hãy liên hệ chúng tôi qua trang Hỗ trợ.
      </p>
    </motion.div>

    <div className="space-y-6">
      {faqCategories.map((cat, ci) => (
        <motion.div
          key={cat.title}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: ci * 0.08 }}
        >
          <div className="flex items-center gap-2 mb-3">
            <cat.icon className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">{cat.title}</h2>
          </div>
          <div className="ed-card overflow-hidden">
            <Accordion type="single" collapsible>
              {cat.items.map((item, i) => (
                <AccordionItem key={i} value={`${ci}-${i}`} className="border-border">
                  <AccordionTrigger className="px-4 py-3 text-sm font-medium hover:no-underline hover:bg-muted/50 transition-colors">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-3 text-sm text-muted-foreground leading-relaxed">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </motion.div>
      ))}
    </div>
  </div>
);

export default FaqPage;
