import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Send, AlertTriangle, HelpCircle, Bug, MessageSquare, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { reportApi } from '@/lib/api';
import { useUserStore } from '@/store/userStore';

const ticketSchema = z.object({
  category: z.enum(['bug', 'account', 'content', 'other'], { required_error: 'Chọn loại vấn đề' }),
  subject: z.string().trim().min(5, 'Tiêu đề tối thiểu 5 ký tự').max(120, 'Tiêu đề tối đa 120 ký tự'),
  description: z.string().trim().min(20, 'Mô tả tối thiểu 20 ký tự').max(2000, 'Mô tả tối đa 2000 ký tự'),
  email: z.string().trim().email('Email không hợp lệ').max(255),
});

type TicketForm = z.infer<typeof ticketSchema>;

const categories = [
  { value: 'bug' as const, label: 'Lỗi / Bug', icon: Bug, color: 'text-red-500 bg-red-500/10 border-red-500/20' },
  { value: 'account' as const, label: 'Tài khoản', icon: AlertTriangle, color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20' },
  { value: 'content' as const, label: 'Nội dung', icon: MessageSquare, color: 'text-blue-500 bg-blue-500/10 border-blue-500/20' },
  { value: 'other' as const, label: 'Khác', icon: HelpCircle, color: 'text-muted-foreground bg-muted border-border' },
];

const SupportPage = () => {
  const isLoggedIn = useUserStore(s => s.isLoggedIn);
  const [form, setForm] = useState<Partial<TicketForm>>({});
  const [errors, setErrors] = useState<Partial<Record<keyof TicketForm, string>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const updateField = <K extends keyof TicketForm>(key: K, value: TicketForm[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setErrors(prev => ({ ...prev, [key]: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = ticketSchema.safeParse(form);
    if (!result.success) {
      const fieldErrors: typeof errors = {};
      result.error.issues.forEach(issue => {
        const key = issue.path[0] as keyof TicketForm;
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      });
      setErrors(fieldErrors);
      return;
    }
    setSending(true);
    try {
      const response = await reportApi.create({
        report_type: result.data.category,
        title: result.data.subject,
        description: `[Email: ${result.data.email}]\n${result.data.description}`,
      });
      setSubmitted(true);
      const emailStatus = response?.support_email?.status;
      if (emailStatus === 'queued') {
        toast.success('Ticket đã lưu và email CSKH đã được đưa vào hàng chờ.');
      } else if (emailStatus === 'not_configured') {
        toast.warning('Ticket đã lưu, nhưng SMTP chưa cấu hình nên chưa gửi email CSKH.');
      } else if (emailStatus === 'rate_limited') {
        toast.warning('Ticket đã lưu, nhưng email CSKH đang bị giới hạn chống spam.');
      } else {
        toast.success('Ticket đã được gửi thành công!');
      }
      return;
      toast.success('Ticket đã được gửi thành công!');
    } catch (err: any) {
      toast.error(err.message || 'Không thể gửi ticket. Vui lòng thử lại.');
    } finally {
      setSending(false);
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="container mx-auto px-4 py-16">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md mx-auto text-center"
        >
          <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-5">
            <MessageSquare className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-bold mb-2">Cần đăng nhập để gửi ticket</h2>
          <p className="text-sm text-muted-foreground mb-6">
            Ticket hỗ trợ được gắn với tài khoản để admin có thể kiểm tra lịch sử và phản hồi đúng người.
          </p>
          <Link
            to="/login"
            className="inline-flex items-center justify-center px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Đăng nhập
          </Link>
        </motion.div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="container mx-auto px-4 py-16">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md mx-auto text-center"
        >
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-xl font-bold mb-2">Đã gửi ticket thành công!</h2>
          <p className="text-sm text-muted-foreground mb-6">
            Chúng tôi sẽ phản hồi qua email trong vòng 24 giờ. Cảm ơn bạn đã báo cáo.
          </p>
          <button
            onClick={() => { setSubmitted(false); setForm({}); setErrors({}); }}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Gửi ticket mới
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="accent-line" />
          <div>
            <h1 className="ed-heading text-2xl">Hỗ trợ</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Gửi ticket để báo lỗi hoặc yêu cầu hỗ trợ</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Category */}
          <div>
            <label className="block text-sm font-semibold mb-2.5">Loại vấn đề</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {categories.map(cat => {
                const Icon = cat.icon;
                const active = form.category === cat.value;
                return (
                  <button
                    type="button"
                    key={cat.value}
                    onClick={() => updateField('category', cat.value)}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs font-medium transition-all ${
                      active
                        ? `${cat.color} ring-2 ring-offset-1 ring-offset-background ring-current`
                        : 'bg-card border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {cat.label}
                  </button>
                );
              })}
            </div>
            {errors.category && <p className="text-xs text-destructive mt-1.5">{errors.category}</p>}
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-semibold mb-1.5">Email liên hệ</label>
            <input
              type="email"
              value={form.email || ''}
              onChange={e => updateField('email', e.target.value)}
              placeholder="email@example.com"
              className="w-full px-4 py-2.5 rounded-lg bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
            />
            {errors.email && <p className="text-xs text-destructive mt-1.5">{errors.email}</p>}
          </div>

          {/* Subject */}
          <div>
            <label className="block text-sm font-semibold mb-1.5">Tiêu đề</label>
            <input
              type="text"
              value={form.subject || ''}
              onChange={e => updateField('subject', e.target.value)}
              placeholder="Mô tả ngắn gọn vấn đề..."
              maxLength={120}
              className="w-full px-4 py-2.5 rounded-lg bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
            />
            <div className="flex justify-between mt-1">
              {errors.subject && <p className="text-xs text-destructive">{errors.subject}</p>}
              <p className="text-[10px] text-muted-foreground ml-auto">{(form.subject || '').length}/120</p>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-semibold mb-1.5">Mô tả chi tiết</label>
            <textarea
              value={form.description || ''}
              onChange={e => updateField('description', e.target.value)}
              placeholder="Mô tả vấn đề bạn gặp phải, các bước tái hiện lỗi, thiết bị/trình duyệt..."
              rows={5}
              maxLength={2000}
              className="w-full px-4 py-2.5 rounded-lg bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all resize-none"
            />
            <div className="flex justify-between mt-1">
              {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
              <p className="text-[10px] text-muted-foreground ml-auto">{(form.description || '').length}/2000</p>
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={sending}
            className="flex items-center justify-center gap-2 w-full sm:w-auto px-6 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {sending ? (
              <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            {sending ? 'Đang gửi...' : 'Gửi ticket'}
          </button>
        </form>
      </motion.div>
    </div>
  );
};

export default SupportPage;
