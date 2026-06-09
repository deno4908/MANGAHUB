import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { uploadApi, groupApi } from '@/lib/api';
import {
  Upload, Plus, Clock, CheckCircle, XCircle, FileText,
  Users, BarChart3, TrendingUp, Eye, BookOpen
} from 'lucide-react';

const statusMap: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  draft: { label: 'Bản nháp', color: 'text-muted-foreground bg-secondary', icon: FileText },
  pending: { label: 'Chờ duyệt', color: 'text-yellow-400 bg-yellow-400/10', icon: Clock },
  published: { label: 'Đã xuất bản', color: 'text-green-400 bg-green-400/10', icon: CheckCircle },
  rejected: { label: 'Bị từ chối', color: 'text-red-400 bg-red-400/10', icon: XCircle },
};

const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
};

const UploadDashboard = () => {
  const [tab, setTab] = useState<'uploads' | 'groups' | 'stats'>('uploads');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [uploads, setUploads] = useState<any[]>([]);
  const [mangaUploads, setMangaUploads] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);

  useEffect(() => {
    uploadApi.getMyUploads(1).then(d => setUploads(d.uploads || [])).catch(() => {});
    uploadApi.getMyMangaUploads(1).then(d => setMangaUploads(d.uploads || [])).catch(() => {});
    groupApi.getMyGroups().then(d => setGroups(d.groups || [])).catch(() => {});
  }, []);

  const combinedUploads = [
    ...uploads.map((u: any) => ({ ...u, upload_kind: 'chapter' })),
    ...mangaUploads.map((u: any) => ({
      ...u,
      upload_kind: 'manga',
      manga_title: u.title,
      chapter_number: null,
      chapter_title: 'Đề xuất truyện mới',
    })),
  ].sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

  const filteredUploads = statusFilter === 'all'
    ? combinedUploads
    : combinedUploads.filter((u: any) => u.status === statusFilter);

  const stats = {
    total: combinedUploads.length,
    published: combinedUploads.filter((u: any) => u.status === 'published').length,
    pending: combinedUploads.filter((u: any) => u.status === 'pending').length,
    rejected: combinedUploads.filter((u: any) => u.status === 'rejected').length,
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-6xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Upload className="w-6 h-6 text-primary" /> Bảng điều khiển Upload</h1>
            <p className="text-sm text-muted-foreground mt-1">Quản lý chapter đã tải lên</p>
          </div>
          <Link
            to="/upload/new"
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> Upload Chapter mới
          </Link>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Tổng upload', value: stats.total, icon: Upload, color: 'text-primary' },
            { label: 'Đã xuất bản', value: stats.published, icon: CheckCircle, color: 'text-green-400' },
            { label: 'Chờ duyệt', value: stats.pending, icon: Clock, color: 'text-yellow-400' },
            { label: 'Bị từ chối', value: stats.rejected, icon: XCircle, color: 'text-red-400' },
          ].map(s => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-card border border-border rounded-xl p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <s.icon className={`w-5 h-5 ${s.color}`} />
                <span className="text-2xl font-bold">{s.value}</span>
              </div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-secondary/30 p-1 rounded-xl w-fit">
          {[
            { key: 'uploads' as const, label: 'Uploads', icon: Upload },
            { key: 'groups' as const, label: 'Nhóm dịch', icon: Users },
            { key: 'stats' as const, label: 'Thống kê', icon: BarChart3 },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>

        {/* Uploads tab */}
        {tab === 'uploads' && (
          <div>
            {/* Status filter */}
            <div className="flex gap-1.5 mb-4 flex-wrap">
              {['all', 'draft', 'pending', 'published', 'rejected'].map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-secondary/50 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {s === 'all' ? 'Tất cả' : statusMap[s].label}
                </button>
              ))}
            </div>

            {/* Upload list */}
            <div className="space-y-2">
              {filteredUploads.map((upload, i) => {
                const st = statusMap[upload.status];
                return (
                  <motion.div
                    key={upload.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-sm line-clamp-1">{upload.manga_title || upload.title || 'Không có tiêu đề'}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {upload.upload_kind === 'manga'
                            ? `Manga mới • ${upload.author || ''}`
                            : `Ch. ${upload.chapter_number} • ${upload.chapter_title || ''}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold ${st.color}`}>
                          <st.icon className="w-3 h-3" /> {st.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{upload.created_at ? new Date(upload.created_at).toLocaleString('vi') : ''}</span>
                      </div>
                    </div>
                    {upload.status === 'rejected' && upload.rejection_reason && (
                      <p className="text-xs text-red-400 mt-2 bg-red-400/5 px-3 py-1.5 rounded-lg">
                        ❌ Lý do: {upload.rejection_reason}
                      </p>
                    )}
                  </motion.div>
                );
              })}
              {filteredUploads.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                  <Upload className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Không có upload nào</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Groups tab */}
        {tab === 'groups' && (
          <div className="space-y-4">
            {groups.map((group: any) => (
              <motion.div
                key={group.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-card border border-border rounded-xl p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-lg">{group.name}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{group.description}</p>
                    <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> {group.total_uploads || 0} uploads</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
            {groups.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Bạn chưa tham gia nhóm dịch nào</p>
              </div>
            )}
          </div>
        )}

        {/* Stats tab */}
        {tab === 'stats' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-xl p-5">
              <h3 className="font-bold mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-primary" /> Upload theo trạng thái</h3>
              <div className="space-y-3">
                {[
                  { label: 'Đã xuất bản', value: stats.published, color: 'bg-green-500' },
                  { label: 'Chờ duyệt', value: stats.pending, color: 'bg-yellow-500' },
                  { label: 'Bị từ chối', value: stats.rejected, color: 'bg-red-500' },
                  { label: 'Bản nháp', value: stats.total - stats.published - stats.pending - stats.rejected, color: 'bg-muted-foreground' },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-24">{item.label}</span>
                    <div className="flex-1 bg-secondary/30 rounded-full h-2">
                      <div className={`${item.color} h-full rounded-full transition-all`} style={{ width: stats.total > 0 ? `${(item.value / stats.total) * 100}%` : '0%' }} />
                    </div>
                    <span className="text-xs font-bold w-6 text-right">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <h3 className="font-bold mb-4 flex items-center gap-2"><Eye className="w-4 h-4 text-primary" /> Chapters đã xuất bản</h3>
              <div className="space-y-3">
                {combinedUploads.filter((u: any) => u.status === 'published').slice(0, 5).map((upload: any) => (
                  <div key={upload.id} className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium line-clamp-1">{upload.manga_title || upload.title}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {upload.upload_kind === 'manga' ? 'Manga mới' : `Ch. ${upload.chapter_number}`}
                      </p>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{upload.created_at ? new Date(upload.created_at).toLocaleDateString('vi') : ''}</span>
                  </div>
                ))}
                {combinedUploads.filter((u: any) => u.status === 'published').length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">Chưa có chapter nào được xuất bản</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default UploadDashboard;
