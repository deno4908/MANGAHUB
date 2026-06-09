import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Mail, MessageCircle, Send, ShieldAlert } from 'lucide-react';
import { SUPPORT_EMAIL, supportMailto } from '@/lib/support';

const contactMethods = [
  {
    icon: Mail,
    title: 'Email',
    value: SUPPORT_EMAIL,
    href: supportMailto(),
  },
  {
    icon: MessageCircle,
    title: 'Discord',
    value: 'discord.gg/mangahub',
    href: 'https://discord.gg/mangahub',
  },
];

const ContactPage = () => (
  <div className="container mx-auto px-4 py-8">
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-3xl"
    >
      <div className="flex items-center gap-3 mb-6">
        <div className="accent-line" />
        <h1 className="ed-heading text-3xl">Liên hệ</h1>
      </div>

      <p className="mb-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Gửi phản hồi, báo lỗi, yêu cầu hỗ trợ tài khoản hoặc vấn đề bản quyền qua các kênh bên dưới.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {contactMethods.map((method) => (
          <a
            key={method.title}
            href={method.href}
            target={method.href.startsWith('http') ? '_blank' : undefined}
            rel={method.href.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="ed-card p-5 transition-colors hover:border-primary/40"
          >
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <method.icon className="h-5 w-5" />
            </div>
            <h2 className="text-sm font-bold text-foreground">{method.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{method.value}</p>
          </a>
        ))}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="ed-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Ticket hỗ trợ</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Dùng ticket nếu bạn cần gửi mô tả lỗi dài, email phản hồi hoặc thông tin chi tiết.
          </p>
          <Link
            to="/support"
            className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Gửi ticket
          </Link>
        </div>

        <div className="ed-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">Vấn đề bản quyền</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Với yêu cầu bản quyền, hãy kèm tên tác phẩm, đường dẫn liên quan và giấy tờ đại diện nếu có.
          </p>
          <Link
            to="/disclaimer"
            className="mt-4 inline-flex rounded-lg border border-border px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Xem miễn trừ
          </Link>
        </div>
      </div>
    </motion.div>
  </div>
);

export default ContactPage;
