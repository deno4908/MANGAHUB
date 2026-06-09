import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api';
import OptimizedImage from '@/components/ui/OptimizedImage';
import {
  ArrowLeft, CheckCircle, XCircle, AlertTriangle, Eye, Clock,
  User, Globe, FileText, ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Maximize, MessageSquare, Flag, Shield
} from 'lucide-react';

const AdminChapterReview = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [upload, setUpload] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [currentPage, setCurrentPage] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const fetchUpload = async () => {
      try {
        for (let page = 1; page <= 5; page++) {
          const d = await adminApi.getUploads(page);
          const uploads = d.uploads || [];
          const raw = uploads.find((u: any) => u.id === id);
          if (raw) {
            if (!cancelled) {
              setUpload({
                ...raw,
                mangaTitle: raw.manga_title || raw.mangaTitle || '',
                chapterNumber: raw.chapter_number || raw.chapterNumber || '',
                chapterTitle: raw.chapter_title || raw.chapterTitle || '',
                uploaderName: raw.profiles?.display_name || raw.profiles?.username || raw.uploaderName || 'Unknown',
                groupName: raw.group_name || raw.groupName || '',
                createdAt: raw.created_at || raw.createdAt || '',
                publishedAt: raw.published_at || raw.publishedAt || null,
                language: raw.language || 'vi',
                pages: raw.pages || [],
              });
            }
            return;
          }
          if (uploads.length === 0) break;
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    };
    fetchUpload();
    return () => { cancelled = true; };
  }, [id]);

  // Pages from upload data
  const pages: string[] = upload?.pages || [];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!upload) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-xl font-bold mb-1">Không tìm thấy chapter</h2>
          <p className="text-sm text-muted-foreground mb-4">Chapter này không tồn tại hoặc đã bị xóa.</p>
          <button onClick={() => navigate('/admin')} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold">
            Quay lại Admin
          </button>
        </div>
      </div>
    );
  }

  const rejectReasons = [
    'Chất lượng hình ảnh quá thấp',
    'Bản dịch không chính xác',
    'Nội dung vi phạm quy định',
    'Thiếu trang / sai thứ tự trang',
    'Trùng lặp với chapter đã có',
    'Watermark / logo không phù hợp',
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Top Bar */}
      <div className="sticky top-0 z-40 bg-card/95 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => navigate('/admin')}
              className="p-2 rounded-xl hover:bg-secondary transition-colors shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-bold truncate">{upload.mangaTitle}</h1>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded shrink-0 ${
                  upload.status === 'pending' ? 'text-yellow-400 bg-yellow-400/10' :
                  upload.status === 'published' ? 'text-green-400 bg-green-400/10' :
                  'text-red-400 bg-red-400/10'
                }`}>
                  {upload.status === 'pending' ? 'Chờ duyệt' : upload.status === 'published' ? 'Đã xuất bản' : 'Từ chối'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                Ch.{upload.chapterNumber} – {upload.chapterTitle}
              </p>
            </div>
          </div>

          {!decision && upload.status === 'pending' && (
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setShowReject(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-colors border border-red-500/20">
                <XCircle className="w-4 h-4" /> Từ chối
              </button>
              <button onClick={async () => {
                  try {
                    await adminApi.reviewUpload(id!, 'approve');
                    setDecision('approve');
                  } catch { /* error handled by api layer */ }
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-green-500 hover:bg-green-600 text-white text-xs font-bold transition-colors">
                <CheckCircle className="w-4 h-4" /> Duyệt
              </button>
            </div>
          )}

          {decision && (
            <span className={`flex items-center gap-1.5 text-sm font-bold ${decision === 'approve' ? 'text-green-400' : 'text-red-400'}`}>
              {decision === 'approve' ? <><CheckCircle className="w-4 h-4" /> Đã duyệt</> : <><XCircle className="w-4 h-4" /> Đã từ chối</>}
            </span>
          )}
        </div>
      </div>

      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-0 lg:gap-6 p-4">
        {/* Left: Chapter Preview */}
        <div className="flex-1 min-w-0">
          {/* Page controls */}
          <div className="flex items-center justify-between mb-3 bg-card border border-border rounded-xl p-3">
            <div className="flex items-center gap-2">
              <button onClick={() => setCurrentPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0}
                className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-bold min-w-[80px] text-center">
                Trang {currentPage + 1} / {pages.length}
              </span>
              <button onClick={() => setCurrentPage(Math.min(pages.length - 1, currentPage + 1))} disabled={currentPage === pages.length - 1}
                className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setZoom(Math.max(50, zoom - 25))} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-bold text-muted-foreground min-w-[40px] text-center">{zoom}%</span>
              <button onClick={() => setZoom(Math.min(200, zoom + 25))} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
                <ZoomIn className="w-4 h-4" />
              </button>
              <button onClick={() => setZoom(100)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Image viewer */}
          <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
            <div className="overflow-auto flex items-start justify-center bg-black/5 dark:bg-black/20 min-h-[60vh]" style={{ maxHeight: '70vh' }}>
              <motion.img
                key={currentPage}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                src={pages[currentPage]}
                alt={`Trang ${currentPage + 1}`}
                className="object-contain transition-transform"
                style={{ width: `${zoom}%`, maxWidth: `${zoom}%` }}
              />
            </div>
          </div>

          {/* Thumbnail strip */}
          <div className="bg-card border border-border rounded-xl p-3 overflow-x-auto">
            <div className="flex gap-2">
              {pages.map((page, i) => (
                <button key={i} onClick={() => setCurrentPage(i)}
                  className={`shrink-0 w-16 h-24 rounded-lg overflow-hidden border-2 transition-all ${
                    currentPage === i ? 'border-primary ring-2 ring-primary/30 scale-105' : 'border-border/50 opacity-60 hover:opacity-100'
                  }`}>
                  <OptimizedImage src={page} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Info Panel */}
        <div className="w-full lg:w-80 shrink-0 space-y-4 mt-4 lg:mt-0">
          {/* Chapter Info */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" /> Thông tin chapter
            </h3>
            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Truyện</span>
                <span className="text-xs font-bold text-right max-w-[60%] truncate">{upload.mangaTitle}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Chapter</span>
                <span className="text-xs font-bold">Ch.{upload.chapterNumber} – {upload.chapterTitle}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Số trang</span>
                <span className="text-xs font-bold">{pages.length} trang</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Ngôn ngữ</span>
                <span className="text-xs font-bold uppercase">{upload.language}</span>
              </div>
            </div>
          </div>

          {/* Uploader Info */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <User className="w-4 h-4 text-blue-400" /> Người upload
            </h3>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 font-black">
                {upload.uploaderName[0]}
              </div>
              <div>
                <p className="text-sm font-bold">{upload.uploaderName}</p>
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Globe className="w-3 h-3" /> {upload.groupName}
                </p>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400" /> Lịch sử
            </h3>
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
                  <div className="w-0.5 flex-1 bg-border mt-1" />
                </div>
                <div>
                  <p className="text-xs font-bold">Upload</p>
                  <p className="text-[10px] text-muted-foreground">{new Date(upload.createdAt).toLocaleString('vi-VN')}</p>
                </div>
              </div>
              {upload.publishedAt && (
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-400" />
                    <div className="w-0.5 flex-1 bg-border mt-1" />
                  </div>
                  <div>
                    <p className="text-xs font-bold">Xuất bản</p>
                    <p className="text-[10px] text-muted-foreground">{new Date(upload.publishedAt).toLocaleString('vi-VN')}</p>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-2.5 h-2.5 rounded-full ${decision ? (decision === 'approve' ? 'bg-green-400' : 'bg-red-400') : 'bg-muted-foreground/30 border-2 border-muted-foreground/50'}`} />
                </div>
                <div>
                  <p className="text-xs font-bold">{decision ? (decision === 'approve' ? 'Đã duyệt' : 'Đã từ chối') : 'Chờ duyệt'}</p>
                  <p className="text-[10px] text-muted-foreground">{decision ? 'Vừa xong' : 'Đang chờ admin'}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Quality checklist */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" /> Kiểm tra chất lượng
            </h3>
            {[
              { label: 'Hình ảnh rõ nét', checked: true },
              { label: 'Bản dịch chính xác', checked: false },
              { label: 'Đúng thứ tự trang', checked: true },
              { label: 'Không có watermark', checked: true },
              { label: 'Nội dung phù hợp', checked: false },
            ].map((item, i) => (
              <label key={i} className="flex items-center gap-2.5 cursor-pointer group">
                <input type="checkbox" defaultChecked={item.checked}
                  className="w-4 h-4 rounded border-border accent-primary" />
                <span className="text-xs group-hover:text-foreground text-muted-foreground transition-colors">{item.label}</span>
              </label>
            ))}
          </div>

          {/* Admin note */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-purple-400" /> Ghi chú admin
            </h3>
            <textarea placeholder="Thêm ghi chú..." rows={3}
              className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
        </div>
      </div>

      {/* Reject Modal */}
      {showReject && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowReject(false)}>
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            onClick={e => e.stopPropagation()}
            className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-border flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center">
                <XCircle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="font-bold">Từ chối chapter</h3>
                <p className="text-xs text-muted-foreground">Ch.{upload.chapterNumber} – {upload.chapterTitle}</p>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-2 block">Chọn lý do</label>
                <div className="space-y-1.5">
                  {rejectReasons.map(r => (
                    <button key={r} onClick={() => setRejectReason(r)}
                      className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium transition-all border ${
                        rejectReason === r
                          ? 'border-red-400 bg-red-500/10 text-red-400'
                          : 'border-border/50 bg-secondary/30 hover:bg-secondary/50 text-muted-foreground hover:text-foreground'
                      }`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-muted-foreground mb-1.5 block">Hoặc nhập lý do khác</label>
                <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  placeholder="Nhập lý do từ chối..." rows={2}
                  className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50 resize-none" />
              </div>
            </div>
            <div className="p-4 border-t border-border flex gap-2 justify-end">
              <button onClick={() => setShowReject(false)} className="px-4 py-2 rounded-xl bg-secondary text-xs font-bold hover:bg-secondary/80 transition-colors">Hủy</button>
              <button onClick={async () => {
                  try {
                    await adminApi.reviewUpload(id!, 'reject', rejectReason);
                    setDecision('reject');
                    setShowReject(false);
                  } catch { /* error handled by api layer */ }
                }} disabled={!rejectReason}
                className="px-4 py-2 rounded-xl bg-red-500 text-white text-xs font-bold hover:bg-red-600 transition-colors disabled:opacity-50">
                Xác nhận từ chối
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
};

export default AdminChapterReview;
