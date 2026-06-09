import { useState } from 'react';
import { useUserStore } from '@/store/userStore';
import { notificationApi } from '@/lib/api';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { getMangaDetailPath } from '@/lib/mangaLinks';
import {
  Bell, BookOpen, MessageCircle, Settings, CheckCheck,
  Trash2, Filter, ChevronRight, X
} from 'lucide-react';

const NotificationsPage = () => {
  const { notifications, markNotificationRead, markAllNotificationsRead } = useUserStore();
  const [filter, setFilter] = useState<string>('all');

  const filtered = filter === 'all' ? notifications :
    filter === 'unread' ? notifications.filter(n => !n.read) :
    notifications.filter(n => n.type === filter);

  const unreadCount = notifications.filter(n => !n.read).length;

  const typeIcons: Record<string, any> = {
    new_chapter: BookOpen,
    reply: MessageCircle,
    system: Settings,
    follow_update: Bell,
  };

  const typeLabels: Record<string, string> = {
    new_chapter: 'Chapter mới',
    reply: 'Phản hồi',
    system: 'Hệ thống',
    follow_update: 'Theo dõi',
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins} phút trước`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} giờ trước`;
    return `${Math.floor(hours / 24)} ngày trước`;
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-comic tracking-wide text-gradient">🔔 Thông Báo</h1>
            {unreadCount > 0 && <p className="text-xs text-muted-foreground mt-1">{unreadCount} chưa đọc</p>}
          </div>
          <div className="flex gap-2">
            {unreadCount > 0 && (
              <button onClick={markAllNotificationsRead}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-secondary border border-border text-sm font-bold text-muted-foreground hover:text-foreground transition-colors">
                <CheckCheck className="w-4 h-4" /> Đọc tất cả
              </button>
            )}
            {notifications.length > 0 && (
              <button onClick={async () => {
                if (!confirm('Xoá tất cả thông báo?')) return;
                try { await notificationApi.clear(); useUserStore.setState({ notifications: [], unreadCount: 0 }); toast.success('Đã xoá tất cả thông báo'); } catch {}
              }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-secondary border border-border text-sm font-bold text-destructive/70 hover:text-destructive transition-colors">
                <Trash2 className="w-4 h-4" /> Xoá tất cả
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-1.5 mb-5 overflow-x-auto scrollbar-hide pb-1">
          {[
            { key: 'all', label: 'Tất cả' },
            { key: 'unread', label: `Chưa đọc (${unreadCount})` },
            { key: 'new_chapter', label: 'Chapter mới' },
            { key: 'reply', label: 'Phản hồi' },
            { key: 'system', label: 'Hệ thống' },
            { key: 'follow_update', label: 'Theo dõi' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                filter === f.key ? 'bg-primary text-primary-foreground' : 'bg-secondary/50 text-muted-foreground hover:text-foreground'
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Notification list */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <Bell className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-muted-foreground font-medium">Không có thông báo</p>
            </div>
          ) : (
            filtered.map((notif, i) => {
              const Icon = typeIcons[notif.type] || Bell;
              return (
                <motion.div key={notif.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                  <div
                    onClick={() => markNotificationRead(notif.id)}
                    className={`flex items-start gap-3 p-4 rounded-xl border transition-all cursor-pointer group ${
                      notif.read ? 'bg-card border-border/50 hover:border-primary/20' : 'bg-primary/5 border-primary/20 hover:border-primary/40'
                    }`}
                  >
                    <div className={`p-2 rounded-lg shrink-0 ${notif.read ? 'bg-secondary' : 'manga-gradient'}`}>
                      <Icon className={`w-4 h-4 ${notif.read ? 'text-muted-foreground' : 'text-primary-foreground'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-bold ${notif.read ? 'text-foreground/70' : 'text-foreground'}`}>{notif.title}</p>
                        {!notif.read && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notif.message}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-[10px] text-muted-foreground">{timeAgo(notif.createdAt)}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-bold">{typeLabels[notif.type]}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {(notif.mangaId || notif.chapterId) && (
                        <Link to={notif.chapterId ? `/chapter/${notif.chapterId}` : getMangaDetailPath(notif.mangaId)}
                          state={notif.chapterId && notif.mangaId ? { mangaSlug: notif.mangaId } : undefined}
                          className="p-2 rounded-lg hover:bg-secondary transition-colors"
                          onClick={e => e.stopPropagation()}>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </Link>
                      )}
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await notificationApi.delete(notif.id);
                          useUserStore.setState(s => ({
                            notifications: s.notifications.filter(n => n.id !== notif.id),
                            unreadCount: !notif.read ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
                          }));
                        } catch {}
                      }} className="p-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default NotificationsPage;
