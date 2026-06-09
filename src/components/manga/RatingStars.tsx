import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ratingApi } from '@/lib/api';
import { useUserStore } from '@/store/userStore';
import { toast } from 'sonner';

interface RatingStarsProps {
  rating: number;
  count?: number;
  size?: 'sm' | 'md';
  mangaSlug?: string;
  interactive?: boolean;
  userScore?: number | null;
  onRated?: (score: number) => void;
}

const RatingStars = ({ rating, count, size = 'sm', mangaSlug, interactive = false, userScore, onRated }: RatingStarsProps) => {
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  const [hovered, setHovered] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [localUserScore, setLocalUserScore] = useState<number | null>(userScore ?? null);
  const isLoggedIn = useUserStore(s => s.isLoggedIn);

  useEffect(() => {
    setLocalUserScore(userScore ?? null);
  }, [userScore]);

  const handleRate = async (score: number) => {
    if (!interactive || !mangaSlug || !isLoggedIn || submitting) return;
    const prevScore = localUserScore;
    setLocalUserScore(score);
    setSubmitting(true);
    try {
      await ratingApi.rate(mangaSlug, score);
      onRated?.(score);
      toast.success(`Đã đánh giá ${score} sao!`);
    } catch {
      setLocalUserScore(prevScore);
      toast.error('Không thể đánh giá. Vui lòng thử lại.');
    } finally {
      setSubmitting(false);
    }
  };

  const displayRating = hovered > 0 ? hovered : (localUserScore ?? rating);
  const showUserScore = interactive && localUserScore != null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {[1, 2, 3, 4, 5].map(star => (
        <Star
          key={star}
          className={`${iconSize} transition-colors ${interactive ? 'cursor-pointer' : ''} ${
            star <= Math.round(displayRating)
              ? 'text-manga-yellow fill-manga-yellow'
              : 'text-muted-foreground'
          }`}
          onMouseEnter={() => interactive && setHovered(star)}
          onMouseLeave={() => interactive && setHovered(0)}
          onClick={() => handleRate(star)}
        />
      ))}
      <span className={`${textSize} font-semibold ml-1`}>{Number(rating).toFixed(1)}</span>
      {count !== undefined && count > 0 && (
        <span className={`${textSize} text-muted-foreground`}>({count.toLocaleString()})</span>
      )}
      {showUserScore && (
        <span className={`${textSize} text-primary font-semibold ml-2`}>
          Bạn: {localUserScore}★
        </span>
      )}
    </div>
  );
};

export default RatingStars;
