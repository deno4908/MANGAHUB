import { Comment } from '@/types/manga';
import { motion, AnimatePresence } from 'framer-motion';
import { ThumbsUp, Reply, User, MessageCircle, Send, Smile, ChevronDown, ChevronUp, Zap, Flame, Heart, Star, MoreHorizontal, Flag, Shield, Upload, Crown, Sparkles, Trash2, Edit3 } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { commentApi, reportApi } from '@/lib/api';
import { useUserStore } from '@/store/userStore';
import {
  getNameEffectClass,
  getNameEffectStyle,
  getNameFontClass,
  NAME_VIP_BADGE_CLASS,
  NAME_VIP_BADGE_ICON_CLASS,
  normalizeNameEffectForAccess,
  normalizeNameFontForAccess,
} from '@/lib/nameStyles';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// Random avatar colors for comic feel
const avatarColors = [
  'from-manga-orange to-manga-red',
  'from-primary to-purple-500',
  'from-manga-green to-teal-400',
  'from-manga-yellow to-manga-orange',
  'from-pink-500 to-manga-red',
  'from-cyan-400 to-primary',
];

const getAvatarColor = (userId: string) => {
  const idx = userId.charCodeAt(1) % avatarColors.length;
  return avatarColors[idx];
};

const reactionEmojis = ['🔥', '❤️', '😂', '😱', '💯', '👏', '😍', '😢', '🤔', '😡', '👀', '🎉', '🥲', '💀', '🫡', '🤣', '😤', '🥰', '💪', '🙏', '✨', '🤯', '😏', '🫠'];

const normalizeReactionMap = (input: unknown): Record<string, number> => {
  if (!input || typeof input !== 'object') return {};

  return Object.entries(input as Record<string, unknown>).reduce<Record<string, number>>((acc, [emoji, rawCount]) => {
    const key = String(emoji || '').trim();
    const count = Number(rawCount);
    if (!key || !Number.isFinite(count) || count <= 0) return acc;
    acc[key] = Math.floor(count);
    return acc;
  }, {});
};

const mapApiComment = (c: any): Comment => ({
  id: c.id,
  userId: c.user_id,
  username: c.username || 'User',
  profileUsername: c.profile_username || c.profileUsername || '',
  chapterId: c.chapter_id || undefined,
  avatar: c.avatar || '',
  role: c.role,
  isVip: c.is_vip || false,
  isLiked: c.is_liked || false,
  nameColor: c.name_color || undefined,
  nameFont: c.name_font || undefined,
  nameEffect: c.name_effect || undefined,
  content: c.content,
  imageUrl: c.image_url || undefined,
  createdAt: c.created_at,
  likes: c.likes || 0,
  reactions: normalizeReactionMap(c.reactions),
  myReaction: c.my_reaction ?? null,
  replies: (c.replies || []).map((r: any) => mapApiComment(r)),
});

const CommentItem = ({ comment, depth = 0, mangaSlug, chapterId, postChapterId, getChapterLabel, onReplyPosted, onCommentDeleted, onCommentUpdated }: { comment: Comment; depth?: number; mangaSlug?: string; chapterId?: string; postChapterId?: string; getChapterLabel?: (comment: Comment) => string | null; onReplyPosted?: (reply: Comment, parentId: string) => void; onCommentDeleted?: (commentId: string) => void; onCommentUpdated?: (commentId: string, newContent: string) => void }) => {
  const [liked, setLiked] = useState(comment.isLiked ?? false);
  const [likeCount, setLikeCount] = useState(comment.likes);
  const [showReplies, setShowReplies] = useState(true);
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyImageFile, setReplyImageFile] = useState<File | null>(null);
  const [replyImagePreview, setReplyImagePreview] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [showEditInput, setShowEditInput] = useState(false);
  const [editText, setEditText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [showReplyEmojiPicker, setShowReplyEmojiPicker] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAllReactions, setShowAllReactions] = useState(false);
  const [showReportMenu, setShowReportMenu] = useState(false);
  const [isReacting, setIsReacting] = useState(false);
  const reactionMenuRef = useRef<HTMLDivElement>(null);
  const replyImageInputRef = useRef<HTMLInputElement>(null);
  const user = useUserStore(s => s.user);
  const isLoggedIn = useUserStore(s => s.isLoggedIn);
  const canDelete = !!user && user.id === comment.userId;
  const chapterLabel = getChapterLabel?.(comment);
  const profileTarget = String(comment.profileUsername || comment.userId || '').trim();
  const profilePath = profileTarget ? `/u/${encodeURIComponent(profileTarget)}` : '';
  const commentNameFont = normalizeNameFontForAccess(comment.nameFont, comment);
  const commentNameEffect = normalizeNameEffectForAccess(comment.nameEffect, comment);

  const handleSendReply = async () => {
    if (sendingReply) return;
    if ((!replyText.trim() && !replyImageFile) || !mangaSlug || !user) return;
    setSendingReply(true);
    try {
      let imageUrl = '';
      if (replyImageFile) {
        const uploaded = await commentApi.uploadImage(
          mangaSlug,
          replyImageFile,
          postChapterId || chapterId,
        );
        imageUrl = uploaded?.image_url || '';
      }
      const content = replyText.trim();
      const res = await commentApi.create({
        manga_slug: mangaSlug,
        chapter_id: postChapterId || chapterId,
        content,
        parent_id: comment.id,
        image_url: imageUrl || undefined,
      });
      if (res.comment) {
        const newReply: Comment = {
          id: res.comment.id, userId: user.id, chapterId,
          username: user.displayName || user.username,
          profileUsername: user.username,
          avatar: user.avatar || '', role: user.role,
          isVip: user.isVip || false,
          nameColor: user.nameColor,
          nameFont: user.nameFont,
          nameEffect: user.nameEffect,
          content,
          imageUrl: imageUrl || undefined,
          createdAt: new Date().toISOString(),
          likes: 0,
          reactions: {},
          myReaction: null,
          replies: [],
        };
        onReplyPosted?.(newReply, comment.id);
        setReplyText('');
        setReplyImageFile(null);
        setReplyImagePreview('');
        setShowReplyInput(false);
        toast.success('Đã gửi phản hồi!');
      }
    } catch { toast.error('Không thể gửi phản hồi.'); }
    finally { setSendingReply(false); }
  };

  useEffect(() => {
    if (!showAllReactions) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (reactionMenuRef.current && !reactionMenuRef.current.contains(e.target as Node)) {
        setShowAllReactions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAllReactions]);
  const [selectedReaction, setSelectedReaction] = useState<string | null>(comment.myReaction ?? null);
  const [reactions, setReactions] = useState<Record<string, number>>(() => ({ ...(comment.reactions || {}) }));

  useEffect(() => {
    setLiked(comment.isLiked ?? false);
    setLikeCount(comment.likes);
    setSelectedReaction(comment.myReaction ?? null);
    setReactions({ ...(comment.reactions || {}) });
  }, [comment.id, comment.isLiked, comment.likes, comment.myReaction, comment.reactions]);

  const handleLike = async () => {
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? prev - 1 : prev + 1);
    try {
      await commentApi.toggleLike(comment.id);
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : prev - 1);
    }
  };

  const handleReaction = async (emoji: string) => {
    if (!isLoggedIn) {
      toast.error('Vui lòng đăng nhập để thả reaction');
      return;
    }
    if (isReacting) return;

    const prevSelected = selectedReaction;
    const prevReactions = { ...reactions };
    const nextReactions = { ...reactions };

    let nextSelected: string | null = emoji;
    if (prevSelected === emoji) {
      const nextCount = (nextReactions[emoji] || 0) - 1;
      if (nextCount > 0) nextReactions[emoji] = nextCount;
      else delete nextReactions[emoji];
      nextSelected = null;
    } else {
      if (prevSelected) {
        const prevCount = (nextReactions[prevSelected] || 0) - 1;
        if (prevCount > 0) nextReactions[prevSelected] = prevCount;
        else delete nextReactions[prevSelected];
      }
      nextReactions[emoji] = (nextReactions[emoji] || 0) + 1;
    }

    setSelectedReaction(nextSelected);
    setReactions(nextReactions);
    setIsReacting(true);

    try {
      const res = await commentApi.toggleReaction(comment.id, emoji, prevSelected);
      if (res && Object.prototype.hasOwnProperty.call(res, 'selected_reaction')) {
        setSelectedReaction(res.selected_reaction ?? null);
      }
      if (res?.reactions) {
        setReactions(normalizeReactionMap(res.reactions));
      }
    } catch {
      setSelectedReaction(prevSelected);
      setReactions(prevReactions);
      toast.error('Không thể thả reaction');
    } finally {
      setIsReacting(false);
    }
  };

  const handleDeleteComment = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true);
    try {
      await commentApi.delete(comment.id);
      onCommentDeleted?.(comment.id);
      toast.success('Đã xóa bình luận');
    } catch {
      toast.error('Không thể xóa bình luận');
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleEditComment = async () => {
    if (!canDelete || !editText.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      await commentApi.update(comment.id, editText.trim());
      onCommentUpdated?.(comment.id, editText.trim());
      setShowEditInput(false);
      toast.success('Đã cập nhật bình luận');
    } catch {
      toast.error('Không thể sửa bình luận');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleReplyImageChange = (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Chỉ hỗ trợ file ảnh');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Ảnh bình luận tối đa 5MB');
      return;
    }
    setReplyImageFile(file);
    setReplyImagePreview(URL.createObjectURL(file));
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: depth > 0 ? 20 : 0, y: depth === 0 ? 15 : 0 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`${depth > 0 ? 'ml-6 md:ml-10' : ''} relative`}
    >
      {/* Comic-style connector line for replies */}
      {depth > 0 && (
        <div className="absolute -left-4 top-0 bottom-0 w-0.5 bg-gradient-to-b from-primary/40 to-transparent rounded-full" />
      )}

      <div className={`group relative rounded-xl p-4 transition-all duration-200 hover:bg-secondary/50 ${
        depth === 0 ? 'border border-border/50 bg-card/30 mb-3' : 'mb-2'
      }`}>
        {/* Comic speech bubble tail for top-level */}
        {depth === 0 && (
          <div className="absolute -left-0 top-6 w-2 h-2 bg-card/30 border-l border-b border-border/50 transform -translate-x-1/2 rotate-45 hidden md:block" />
        )}

        <div className="flex gap-3">
          {/* Comic-style avatar */}
          <Link
            to={profilePath || '#'}
            onClick={(event) => {
              if (!profilePath) event.preventDefault();
            }}
            aria-label={`Xem hồ sơ ${comment.username}`}
            className={`w-9 h-9 rounded-full overflow-hidden shrink-0 ring-1 ring-border/40 shadow-sm hover:ring-primary/60 transition-all ${comment.avatar ? '' : `bg-gradient-to-br ${getAvatarColor(comment.userId)} flex items-center justify-center`}`}
          >
            {comment.avatar ? (
              <img
                src={comment.avatar}
                alt={comment.username}
                className="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <span className="text-xs font-bold text-primary-foreground">
                {comment.username.charAt(0).toUpperCase()}
              </span>
            )}
          </Link>

          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <Link
                to={profilePath || '#'}
                onClick={(event) => {
                  if (!profilePath) event.preventDefault();
                }}
                className={`text-sm font-bold hover:underline underline-offset-4 ${getNameFontClass(commentNameFont)} ${getNameEffectClass(commentNameEffect)}`}
                style={{
                  color: comment.nameColor || undefined,
                  ...getNameEffectStyle(commentNameEffect, comment.nameColor),
                }}
              >
                {comment.username}
              </Link>
              {/* Role / VIP badges */}
              {(() => {
                const roleConfig: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
                  admin: { label: 'Admin', icon: <Shield className="w-2.5 h-2.5" />, cls: 'bg-destructive/15 text-destructive border-destructive/30' },
                  moderator: { label: 'Mod', icon: <Shield className="w-2.5 h-2.5" />, cls: 'bg-primary/15 text-primary border-primary/30' },
                  uploader: { label: 'Uploader', icon: <Upload className="w-2.5 h-2.5" />, cls: 'bg-accent text-accent-foreground border-accent' },
                };
                const badges: React.ReactNode[] = [];
                // Non-reader role badge
                if (comment.role && comment.role !== 'reader' && roleConfig[comment.role]) {
                  const cfg = roleConfig[comment.role];
                  badges.push(
                    <span key="role" className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${cfg.cls}`}>
                      {cfg.icon} {cfg.label}
                    </span>
                  );
                }
                // VIP badge — separate from role
                if (comment.isVip) {
                  badges.push(
                    <span key="vip" className={NAME_VIP_BADGE_CLASS}>
                      <Crown className={NAME_VIP_BADGE_ICON_CLASS} /> VIP
                    </span>
                  );
                }
                return badges.length > 0 ? <>{badges}</> : null;
              })()}
              {likeCount > 100 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-manga-orange/20 text-manga-orange text-[10px] font-bold">
                  <Flame className="w-2.5 h-2.5" /> HOT
                </span>
              )}
              {likeCount > 50 && likeCount <= 100 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                  <Zap className="w-2.5 h-2.5" /> TOP
                </span>
              )}
              {chapterLabel && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-[10px] font-bold border border-border">
                  {chapterLabel}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">{timeAgoVi(comment.createdAt)}</span>
            </div>

            {/* Comment content - comic bubble style */}
            <div className="relative">
              <p className="text-sm leading-relaxed text-foreground/90">{comment.content}</p>
              {comment.imageUrl && (
                <img
                  src={comment.imageUrl}
                  alt="comment-image"
                  className="mt-2 rounded-lg border border-border/60 max-h-72 object-contain bg-black/20"
                  loading="lazy"
                  decoding="async"
                />
              )}
            </div>

            {/* Reaction bar */}
            <div className="flex items-center gap-1 mt-2.5 flex-wrap overflow-visible">
              {/* Like button */}
              <motion.button
                whileTap={{ scale: 1.3 }}
                onClick={handleLike}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                  liked
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-secondary/80 text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent'
                }`}
              >
                <ThumbsUp className={`w-3 h-3 ${liked ? 'fill-current' : ''}`} />
                {likeCount}
              </motion.button>

              {/* Displayed reactions with counts */}
              {Object.entries(reactions).map(([emoji, count]) => (
                <motion.button
                  key={emoji}
                  whileTap={{ scale: 1.2 }}
                  onClick={() => handleReaction(emoji)}
                  className={`flex items-center gap-0.5 px-2 py-1 rounded-full text-xs font-medium transition-all ${
                    selectedReaction === emoji
                      ? 'bg-primary/15 border border-primary/30'
                      : 'bg-secondary/60 border border-border/30 hover:bg-secondary'
                  }`}
                >
                  <span className="text-[11px]">{emoji}</span>
                  <span className="text-[10px] text-muted-foreground">{count}</span>
                </motion.button>
              ))}

              {/* Add reaction picker (hover) - show first 4 unused */}
              <div className={`relative flex gap-0.5 transition-opacity items-center ${depth > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                {reactionEmojis.filter(e => !reactions[e]).slice(0, 4).map(emoji => (
                  <motion.button
                    key={emoji}
                    whileHover={{ scale: 1.3 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleReaction(emoji)}
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs hover:bg-secondary transition-all"
                  >
                    {emoji}
                  </motion.button>
                ))}
                {reactionEmojis.filter(e => !reactions[e]).length > 4 && (
                  <div className="relative" ref={reactionMenuRef}>
                    <motion.button
                      whileTap={{ scale: 0.9 }}
                      onClick={() => setShowAllReactions(!showAllReactions)}
                      className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-secondary transition-all"
                    >
                      <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
                    </motion.button>
                    <AnimatePresence>
                      {showAllReactions && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9, y: 5 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9, y: 5 }}
                          className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-card border border-border rounded-xl p-1.5 shadow-lg z-50 w-[11.5rem] max-h-[7.5rem] overflow-y-auto overflow-x-hidden"
                          onClick={e => e.stopPropagation()}
                        >
                          <div className="grid grid-cols-5 gap-0.5">
                            {reactionEmojis.filter(e => !reactions[e]).map(emoji => (
                              <motion.button
                                key={emoji}
                                whileHover={{ scale: 1.2 }}
                                whileTap={{ scale: 0.9 }}
                                onClick={() => { handleReaction(emoji); setShowAllReactions(false); }}
                                className="w-8 h-8 rounded-lg flex items-center justify-center text-sm hover:bg-secondary transition-all"
                              >
                                {emoji}
                              </motion.button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              <div className="ml-auto flex items-center gap-1 shrink-0 relative z-20">
                {/* Reply button */}
                <button
                  onClick={() => {
                    setShowEditInput(false);
                    setShowReplyInput(!showReplyInput);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                >
                  <Reply className="w-3 h-3" />
                  Trả lời
                </button>

                {canDelete && (
                  <button
                    onClick={() => {
                      setEditText(comment.content || '');
                      setShowReplyInput(false);
                      setShowEditInput(!showEditInput);
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                  >
                    <Edit3 className="w-3 h-3" />
                    Sửa
                  </button>
                )}

                {canDelete && (
                  <button
                    onClick={() => {
                      setShowReportMenu(false);
                      setShowDeleteConfirm(true);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-full text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}

                {!canDelete && (
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setShowReportMenu(true);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-full text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  >
                    <Flag className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Delete modal */}
            <AnimatePresence>
              {showDeleteConfirm && canDelete && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-[120] bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
                  onClick={() => !deleting && setShowDeleteConfirm(false)}
                >
                  <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="w-full max-w-sm bg-card border border-border rounded-2xl p-4 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-sm font-bold mb-1">Xóa bình luận</p>
                    <p className="text-xs text-muted-foreground mb-4">Bạn có chắc muốn xóa bình luận này?</p>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        disabled={deleting}
                        className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        Hủy
                      </button>
                      <button
                        onClick={handleDeleteComment}
                        disabled={deleting}
                        className="px-3 py-1.5 rounded-lg bg-destructive text-destructive-foreground text-xs font-semibold disabled:opacity-50"
                      >
                        {deleting ? 'Đang xóa...' : 'Xóa'}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Report modal */}
            <AnimatePresence>
              {showReportMenu && !canDelete && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-[120] bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
                  onClick={() => setShowReportMenu(false)}
                >
                  <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="w-full max-w-sm bg-card border border-border rounded-2xl p-3 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-sm font-bold px-2 py-1">Báo cáo bình luận</p>
                    {[
                      'Spam / Quảng cáo',
                      'Nội dung thù ghét',
                      'Spoiler không gắn thẻ',
                      'Ngôn ngữ không phù hợp',
                      'Quấy rối',
                    ].map(reason => (
                      <button
                        key={reason}
                        onClick={async () => {
                          setShowReportMenu(false);
                          try {
                            await reportApi.create({
                              report_type: 'comment',
                              target_id: comment.id,
                              title: `Báo cáo bình luận: ${reason}`,
                              description: `Bình luận của ${comment.username}: "${comment.content.slice(0, 100)}"`,
                            });
                            toast.success('Đã gửi báo cáo thành công!');
                          } catch {
                            toast.error('Không thể gửi báo cáo. Vui lòng thử lại.');
                          }
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-destructive/10 hover:text-destructive transition-colors"
                      >
                        {reason}
                      </button>
                    ))}
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Edit input */}
            <AnimatePresence>
              {showEditInput && canDelete && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 overflow-hidden"
                >
                  <div className="flex gap-2 items-start">
                    <div className="flex-1 relative">
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        placeholder="Sửa bình luận..."
                        className="w-full bg-secondary/50 border border-border rounded-xl p-2.5 pr-10 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30 transition-all"
                        rows={2}
                      />
                    </div>
                    <button
                      onClick={handleEditComment}
                      disabled={!editText.trim() || savingEdit}
                      className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-semibold disabled:opacity-50"
                    >
                      {savingEdit ? 'Đang lưu...' : 'Lưu'}
                    </button>
                    <button
                      onClick={() => setShowEditInput(false)}
                      className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      Hủy
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Reply input */}
            <AnimatePresence>
              {showReplyInput && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 overflow-visible"
                >
                  <div className="flex gap-2 items-start">
                    <div className={`w-6 h-6 rounded-full overflow-hidden shrink-0 ring-1 ring-border/40 ${user?.avatar ? '' : 'bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center'}`}>
                      {user?.avatar ? (
                        <img
                          src={user.avatar}
                          alt={user.displayName || user.username || 'User'}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span className="text-[9px] font-bold text-primary-foreground">
                          {(user?.displayName || user?.username || 'M').charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 relative">
                      <textarea
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        placeholder={`Trả lời ${comment.username}...`}
                        className="w-full bg-secondary/50 border border-border rounded-xl p-2.5 pr-24 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30 transition-all"
                        rows={2}
                      />
                      <input
                        ref={replyImageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleReplyImageChange(e.target.files?.[0] || null)}
                      />
                      <button
                        onClick={() => replyImageInputRef.current?.click()}
                        className="absolute right-[4.5rem] bottom-2 p-1.5 rounded-lg hover:bg-secondary transition-colors"
                      >
                        <Upload className="w-3 h-3 text-muted-foreground" />
                      </button>
                      <div className="absolute right-10 bottom-2">
                        <button
                          onClick={() => setShowReplyEmojiPicker(prev => !prev)}
                          className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                        >
                          <Smile className="w-3 h-3 text-muted-foreground" />
                        </button>
                        <AnimatePresence>
                          {showReplyEmojiPicker && (
                            <motion.div
                              initial={{ opacity: 0, y: 4, scale: 0.96 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: 4, scale: 0.96 }}
                              className="absolute right-0 bottom-9 z-50 bg-card border border-border rounded-xl shadow-lg p-2 w-56 max-h-36 overflow-y-auto"
                            >
                              <div className="grid grid-cols-8 gap-1">
                                {reactionEmojis.map((emoji) => (
                                  <button
                                    key={emoji}
                                    onClick={() => {
                                      setReplyText((prev) => `${prev}${emoji}`);
                                      setShowReplyEmojiPicker(false);
                                    }}
                                    className="w-6 h-6 rounded-md flex items-center justify-center text-sm hover:bg-secondary transition-colors"
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      <button onClick={handleSendReply} disabled={(!replyText.trim() && !replyImageFile) || sendingReply || !isLoggedIn}
                        className="absolute right-2 bottom-2 p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                        <Send className="w-3 h-3" />
                      </button>
                      {replyImagePreview && (
                        <div className="mt-2 relative w-fit">
                          <img
                            src={replyImagePreview}
                            alt="reply-preview"
                            className="max-h-28 rounded-lg border border-border/60"
                          />
                          <button
                            onClick={() => {
                              setReplyImageFile(null);
                              setReplyImagePreview('');
                            }}
                            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-[10px]"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Replies toggle */}
      {comment.replies.length > 0 && depth === 0 && (
        <button
          onClick={() => setShowReplies(!showReplies)}
          className="flex items-center gap-1.5 ml-12 mb-2 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          {showReplies ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showReplies ? 'Ẩn' : 'Xem'} {comment.replies.length} phản hồi
        </button>
      )}

      {/* Replies */}
      <AnimatePresence>
        {showReplies && comment.replies.map(r => (
          <CommentItem
            key={r.id}
            comment={r}
            depth={depth + 1}
            mangaSlug={mangaSlug}
            chapterId={chapterId}
            postChapterId={postChapterId}
            getChapterLabel={getChapterLabel}
            onReplyPosted={onReplyPosted}
            onCommentDeleted={onCommentDeleted}
            onCommentUpdated={onCommentUpdated}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );
};

const CommentSection = ({ mangaSlug, chapterId, postChapterId, chapterLabel, chapterMap }: { mangaSlug?: string; chapterId?: string; postChapterId?: string; chapterLabel?: string; chapterMap?: Record<string, string> } = {}) => {
  const [commentText, setCommentText] = useState('');
  const [activeTab, setActiveTab] = useState<'hot' | 'new'>('hot');
  const [comments, setComments] = useState<Comment[]>([]);
  const [isDegraded, setIsDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [postingComment, setPostingComment] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [commentImageFile, setCommentImageFile] = useState<File | null>(null);
  const [commentImagePreview, setCommentImagePreview] = useState('');
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const commentImageInputRef = useRef<HTMLInputElement>(null);
  const user = useUserStore(s => s.user);
  const isLoggedIn = useUserStore(s => s.isLoggedIn);

  const resolveChapterLabel = (c: Comment): string | null => {
    if (chapterId && chapterLabel) return chapterLabel;
    if (c.chapterLabel) return c.chapterLabel;
    if (c.chapterId && chapterMap && chapterMap[c.chapterId]) return chapterMap[c.chapterId];
    // Don't show raw IDs — only show chapter label if it can be properly resolved
    return null;
    return null;
  };

  const fetchCommentsPage = async (targetPage: number, append = false) => {
    if (!mangaSlug) return;
    const d: any = await commentApi.getByManga(mangaSlug, chapterId, targetPage);
    const fetched = (d.comments || []).map((c: any) => mapApiComment(c));
    setComments((prev) => append ? [...prev, ...fetched] : fetched);
    setIsDegraded((prev) => append ? prev || !!d.degraded : !!d.degraded);
    setHasMore(!!d.has_more);
    setPage(targetPage);
  };

  useEffect(() => {
    if (!mangaSlug) { setLoading(false); return; }
    setLoading(true);
    setIsDegraded(false);
    fetchCommentsPage(1, false)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [mangaSlug, chapterId]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const onMouseDown = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showEmojiPicker]);

  const handleLoadMore = async () => {
    if (!mangaSlug || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await fetchCommentsPage(page + 1, true);
    } finally {
      setLoadingMore(false);
    }
  };

  const handlePostComment = async () => {
    if (postingComment) return;
    if ((!commentText.trim() && !commentImageFile) || !mangaSlug || !user) return;
    setPostingComment(true);
    try {
      let imageUrl = '';
      if (commentImageFile) {
        const uploaded = await commentApi.uploadImage(
          mangaSlug,
          commentImageFile,
          postChapterId || chapterId,
        );
        imageUrl = uploaded?.image_url || '';
      }
      const content = commentText.trim();
      const res = await commentApi.create({
        manga_slug: mangaSlug,
        chapter_id: postChapterId || chapterId,
        content,
        image_url: imageUrl || undefined,
      });
      if (res.comment) {
        const newComment: Comment = {
          id: res.comment.id,
          userId: user.id,
          chapterId: postChapterId || chapterId,
          chapterLabel,
          username: user.displayName || user.username,
          profileUsername: user.username,
          avatar: user.avatar || '',
          role: user.role,
          isVip: user.isVip || false,
          nameColor: user.nameColor,
          nameFont: user.nameFont,
          nameEffect: user.nameEffect,
          content,
          imageUrl: imageUrl || undefined,
          createdAt: new Date().toISOString(),
          likes: 0,
          reactions: {},
          myReaction: null,
          replies: [],
        };
        setComments(prev => [newComment, ...prev]);
        setCommentText('');
        setCommentImageFile(null);
        setCommentImagePreview('');
      }
    } catch { /* toast handled in api layer */ }
    finally { setPostingComment(false); }
  };

  const handleCommentImageChange = (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Chỉ hỗ trợ file ảnh');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Ảnh bình luận tối đa 5MB');
      return;
    }
    setCommentImageFile(file);
    setCommentImagePreview(URL.createObjectURL(file));
  };

  const sortedComments = activeTab === 'hot'
    ? [...comments].sort((a, b) => b.likes - a.likes)
    : [...comments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const totalComments = comments.reduce((acc, c) => acc + 1 + c.replies.length, 0);

  return (
    <div>
      {/* Header with comic style */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg manga-gradient">
            <MessageCircle className="w-4 h-4 text-primary-foreground" />
          </div>
          <h3 className="text-lg font-extrabold">Bình luận</h3>
          <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-xs font-bold">{totalComments}</span>
        </div>

        {/* Sort tabs */}
        <div className="flex rounded-lg bg-secondary/50 p-0.5 border border-border/50">
          <button
            onClick={() => setActiveTab('hot')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
              activeTab === 'hot' ? 'bg-manga-orange/20 text-manga-orange' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Flame className="w-3 h-3" /> Nổi bật
          </button>
          <button
            onClick={() => setActiveTab('new')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
              activeTab === 'new' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Zap className="w-3 h-3" /> Mới nhất
          </button>
        </div>
      </div>

      {/* Comment input - comic speech bubble style */}
      <div className="relative mb-6 p-4 rounded-xl bg-card border border-border/60 shadow-sm">
        <div className="flex gap-3 items-start">
          <div className={`w-10 h-10 rounded-full overflow-hidden shrink-0 ring-1 ring-border/40 ${user?.avatar ? '' : 'bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center'}`}>
            {user?.avatar ? (
              <img
                src={user.avatar}
                alt={user.displayName || user.username || 'User'}
                className="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <span className="text-sm font-bold text-primary-foreground">
                {(user?.displayName || user?.username || 'M').charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1">
            <textarea
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Chia sẻ suy nghĩ của bạn về chapter này... 💬"
              className="w-full bg-secondary/30 border border-border/50 rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30 transition-all"
              rows={3}
            />
            <div className="flex items-center justify-between mt-2.5">
              <div className="relative flex gap-1" ref={emojiPickerRef}>
                <input
                  ref={commentImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) =>
                    handleCommentImageChange(e.target.files?.[0] || null)
                  }
                />
                <button type="button" onClick={() => setShowEmojiPicker(v => !v)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                  <Smile className="w-4 h-4 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={() => commentImageInputRef.current?.click()}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                >
                  <Upload className="w-4 h-4 text-muted-foreground" />
                </button>
                <AnimatePresence>
                  {showEmojiPicker && (
                    <motion.div
                      initial={{ opacity: 0, y: 6, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.95 }}
                      className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-xl p-2 shadow-lg w-56 max-h-40 overflow-y-auto"
                    >
                      <div className="grid grid-cols-8 gap-1">
                        {reactionEmojis.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => {
                              setCommentText((prev) => `${prev}${emoji}`);
                              setShowEmojiPicker(false);
                            }}
                            className="w-6 h-6 rounded-md hover:bg-secondary text-sm"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handlePostComment}
                disabled={postingComment || (!commentText.trim() && !commentImageFile) || !isLoggedIn}
                className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold shadow-lg transition-colors ${
                  (commentText.trim() || commentImageFile) && isLoggedIn && !postingComment
                    ? 'bg-primary text-white shadow-primary/20 hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed shadow-none'
                }`}
              >
                <Send className="w-3.5 h-3.5" />
                {postingComment ? 'Đang gửi...' : 'Đăng bình luận'}
              </motion.button>
            </div>
            {commentImagePreview && (
              <div className="mt-2 relative w-fit">
                <img
                  src={commentImagePreview}
                  alt="comment-preview"
                  className="max-h-32 rounded-lg border border-border/60"
                />
                <button
                  onClick={() => {
                    setCommentImageFile(null);
                    setCommentImagePreview('');
                  }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-[10px]"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Comments list */}
      {isDegraded && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-xs font-semibold text-amber-600 dark:text-amber-300">Dữ liệu bình luận đang tải chậm.</p>
          <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-200/90">
            Kết quả hiện tại có thể chưa đầy đủ. Vui lòng thử tải lại sau ít phút.
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : sortedComments.length === 0 ? (
        <div className="text-center py-10">
          <MessageCircle className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Chưa có bình luận nào. Hãy là người đầu tiên! 💬</p>
        </div>
      ) : (
        <div className="space-y-1">
          {sortedComments.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
            >
              <CommentItem
                comment={c}
                mangaSlug={mangaSlug}
                chapterId={chapterId}
                postChapterId={postChapterId}
                getChapterLabel={resolveChapterLabel}
                onReplyPosted={(reply, parentId) => {
                  const addReply = (list: Comment[]): Comment[] =>
                    list.map(cm => cm.id === parentId
                      ? { ...cm, replies: [...cm.replies, reply] }
                      : { ...cm, replies: addReply(cm.replies) });
                  setComments(prev => addReply(prev));
                }}
                onCommentDeleted={(commentId) => {
                  const removeById = (list: Comment[]): Comment[] =>
                    list
                      .filter(cm => cm.id !== commentId)
                      .map(cm => ({ ...cm, replies: removeById(cm.replies) }));
                  setComments(prev => removeById(prev));
                }}
                onCommentUpdated={(commentId, newContent) => {
                  const updateById = (list: Comment[]): Comment[] =>
                    list.map(cm => cm.id === commentId
                      ? { ...cm, content: newContent }
                      : { ...cm, replies: updateById(cm.replies) });
                  setComments(prev => updateById(prev));
                }}
              />
            </motion.div>
          ))}
        </div>
      )}

      {hasMore && (
        <div className="text-center mt-6">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="px-6 py-2.5 rounded-xl bg-secondary border border-border/50 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loadingMore ? 'Đang tải...' : 'Hiển thị thêm bình luận'}
          </button>
        </div>
      )}
    </div>
  );
};

function timeAgoVi(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngày trước`;
  if (days < 30) return `${Math.floor(days / 7)} tuần trước`;
  return `${Math.floor(days / 30)} tháng trước`;
}

export default CommentSection;
