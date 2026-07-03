import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { RefreshCw } from 'lucide-react';
import { getMangaDexImageFallback } from '@/lib/mangaDexImages';

interface ReaderImageProps {
  src: string;
  alt: string;
  index: number;
  imageFit: 'width' | 'height' | 'original';
  pageGap: number;
  onVisible?: (index: number) => void;
  priority?: boolean;
  fallbackSrc?: string;
}

const ReaderImage = memo(({ src, alt, index, imageFit, pageGap, onVisible, priority = false, fallbackSrc }: ReaderImageProps) => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [inView, setInView] = useState(priority);
  const [visible, setVisible] = useState(priority);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [useFallbackSource, setUseFallbackSource] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const preloadObserver = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { rootMargin: '6000px 0px', threshold: 0 }
    );

    const visibleObserver = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) onVisibleRef.current?.(index);
      },
      { rootMargin: '0px', threshold: 0.05 }
    );

    preloadObserver.observe(el);
    visibleObserver.observe(el);
    return () => { preloadObserver.disconnect(); visibleObserver.disconnect(); };
  }, [index]);

  useEffect(() => {
    setLoaded(false);
    setError(false);
    setRetryCount(0);
    setNaturalSize(null);
    setUseFallbackSource(false);
  }, [src]);

  const fitClass =
    imageFit === 'width' ? 'block w-full h-auto' :
    imageFit === 'height' ? 'block max-h-screen max-w-full w-auto h-auto mx-auto object-contain' :
    'block max-w-full h-auto mx-auto';

  const handleRetry = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setError(false);
    setRetryCount(r => r + 1);
  }, []);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    setLoaded(true);
  }, []);

  const fallbackSource = fallbackSrc || getMangaDexImageFallback(src);
  const hasExplicitFallback = Boolean(fallbackSrc);
  const activeSrc = useFallbackSource && fallbackSource ? fallbackSource : src;
  const imgSrc = retryCount > 0 ? `${activeSrc}${activeSrc.includes('?') ? '&' : '?'}retry=${retryCount}` : activeSrc;

  useEffect(() => {
    if (!inView || loaded || error) return;
    const timeout = window.setTimeout(() => {
      if (!useFallbackSource && fallbackSource) {
        setUseFallbackSource(true);
        setRetryCount(0);
        return;
      }
      if (retryCount < 2) {
        setRetryCount((count) => count + 1);
        return;
      }
      setError(true);
    }, useFallbackSource
      ? 18_000
      : hasExplicitFallback
        ? (visible || priority ? 2_500 : 4_500)
        : visible
          ? 5_000
          : priority
            ? 6_500
            : 8_000);
    return () => window.clearTimeout(timeout);
  }, [inView, visible, loaded, error, useFallbackSource, fallbackSource, retryCount, priority, hasExplicitFallback]);

  const placeholderStyle: React.CSSProperties = naturalSize
    ? { aspectRatio: `${naturalSize.w}/${naturalSize.h}` }
    : { aspectRatio: '2/3' };

  const containerStyle: React.CSSProperties = {
    marginBottom: `${pageGap}px`,
  };

  return (
    <div ref={imgRef} style={containerStyle} className="relative w-full min-w-0 max-w-full overflow-hidden">
      {!loaded && !error && (
        <div className={`flex w-full items-center justify-center bg-secondary/50 ${inView || priority ? 'animate-pulse' : ''}`} style={placeholderStyle}>
          <div className="text-muted-foreground text-xs font-medium">Trang {index + 1}</div>
        </div>
      )}

      {error ? (
        <div className="w-full bg-secondary/30 flex flex-col items-center justify-center gap-3 border border-border rounded-lg" style={placeholderStyle}>
          <p className="text-muted-foreground text-sm">Không thể tải ảnh</p>
          <button
            onClick={handleRetry}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition-opacity"
          >
            <RefreshCw className="w-4 h-4" /> Thử lại
          </button>
        </div>
      ) : (inView || priority) ? (
        <img
          src={imgSrc}
          alt={alt}
          className={`${fitClass} select-none ${loaded ? '' : 'invisible absolute'}`}
          loading="eager"
          decoding="async"
          fetchPriority={visible || priority ? 'high' : 'auto'}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={handleLoad}
          onError={() => {
            if (!useFallbackSource && fallbackSource) {
              setUseFallbackSource(true);
              setLoaded(false);
              setRetryCount(0);
              return;
            }
            setError(true);
          }}
        />
      ) : null}
    </div>
  );
});

ReaderImage.displayName = 'ReaderImage';

export default ReaderImage;
