import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Send, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { reportApi } from '@/lib/api';
import ReCaptchaV2, { isRecaptchaConfigured, type ReCaptchaV2Handle } from '@/components/security/ReCaptchaV2';

const reportTypes = [
  { value: 'missing_pages', label: 'Thiếu trang / Hình bị lỗi' },
  { value: 'wrong_order', label: 'Sai thứ tự trang' },
  { value: 'wrong_chapter', label: 'Sai chương / Nội dung trùng' },
  { value: 'translation', label: 'Lỗi dịch thuật' },
  { value: 'other', label: 'Khác' },
];

const ReportPage = () => {
  const [mangaTitle, setMangaTitle] = useState('');
  const [chapterNumber, setChapterNumber] = useState('');
  const [reportType, setReportType] = useState('');
  const [description, setDescription] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const captchaRef = useRef<ReCaptchaV2Handle>(null);
  const captchaRequired = isRecaptchaConfigured();

  const canSubmit = mangaTitle.trim() && chapterNumber.trim() && reportType && description.trim() && !loading && (!captchaRequired || Boolean(captchaToken));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (captchaRequired && !captchaToken) {
      toast.error('Vui lòng xác minh reCAPTCHA trước khi gửi báo lỗi.');
      return;
    }
    setLoading(true);
    try {
      await reportApi.create({
        report_type: reportType,
        target_id: `${mangaTitle}:ch${chapterNumber}`,
        title: `${mangaTitle} - Chương ${chapterNumber}`,
        description,
        recaptcha_token: captchaToken,
      });
      setSubmitted(true);
      toast.success('Báo lỗi đã được gửi thành công!');
    } catch (err: any) {
      toast.error(err.message || 'Không thể gửi báo lỗi. Vui lòng thử lại.');
    } finally {
      captchaRef.current?.reset();
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="container mx-auto px-4 py-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-24 text-center"
        >
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Cảm ơn bạn!</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Báo lỗi của bạn đã được ghi nhận. Chúng tôi sẽ xử lý trong thời gian sớm nhất.
          </p>
          <button onClick={() => { setSubmitted(false); setMangaTitle(''); setChapterNumber(''); setReportType(''); setDescription(''); setCaptchaToken(''); }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity">
            Gửi báo lỗi khác
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-lg">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center gap-3 mb-6">
          <div className="accent-line" />
          <h1 className="ed-heading text-3xl">Báo lỗi chương</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">
          Phát hiện lỗi hình ảnh, thiếu trang hoặc sai nội dung? Hãy báo cho chúng tôi để khắc phục nhanh chóng.
        </p>
      </motion.div>

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Tên truyện *</label>
          <input type="text" value={mangaTitle} onChange={e => setMangaTitle(e.target.value)}
            placeholder="Nhập tên truyện..."
            className="w-full px-3 py-2 rounded-lg bg-muted border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40" />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Số chương *</label>
          <input type="text" value={chapterNumber} onChange={e => setChapterNumber(e.target.value)}
            placeholder="VD: 42"
            className="w-full px-3 py-2 rounded-lg bg-muted border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40" />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Loại lỗi *</label>
          <div className="space-y-2">
            {reportTypes.map(t => (
              <label key={t.value}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                  reportType === t.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                }`}>
                <input type="radio" name="reportType" value={t.value} checked={reportType === t.value}
                  onChange={e => setReportType(e.target.value)} className="sr-only" />
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                  reportType === t.value ? 'border-primary' : 'border-muted-foreground/30'
                }`}>
                  {reportType === t.value && <div className="w-2 h-2 rounded-full bg-primary" />}
                </div>
                <span className="text-sm">{t.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Mô tả chi tiết *</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Mô tả lỗi bạn gặp phải..."
            rows={4}
            className="w-full px-3 py-2 rounded-lg bg-muted border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 resize-none" />
        </div>

        <ReCaptchaV2 ref={captchaRef} onTokenChange={setCaptchaToken} />

        <button type="submit" disabled={!canSubmit}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
          <Send className="w-4 h-4" /> Gửi báo lỗi
        </button>
      </motion.form>
    </div>
  );
};

export default ReportPage;
