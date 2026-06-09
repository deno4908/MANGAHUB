import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { RefreshCw } from 'lucide-react';

interface ReaderImageProps {
  src: string;
  alt: string;
  index: number;
  imageFit: 'width' | 'height' | 'original';
  pageGap: number;
  onVisible?: (index: number) => void;
  priority?: boolean;
}

const ReaderImage = memo(({ src, alt, index, imageFit, pageGap, onVisible, priority = false }: ReaderImageProps) => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [inView, setInView] = useState(priority);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [useDirectSource, setUseDirectSource] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const preloadObserver = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { rootMargin: '2500px 0px', threshold: 0 }
    );

    const visibleObserver = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisibleRef.current?.(index); },
      { rootMargin: '0px', threshold: 0.3 }
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
    setUseDirectSource(false);
  }, [src]);

  const fitClass =
    imageFit === 'width' ? 'w-full h-auto' :
    imageFit === 'height' ? 'h-screen w-auto mx-auto' :
    'max-w-full max-h-screen mx-auto';

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

  const getDirectSource = useCallback((value: string): string | null => {
    try {
      const parsed = new URL(value, window.location.origin);
      const encoded = parsed.searchParams.get('url');
      if (!encoded) return null;
      const decoded = decodeURIComponent(encoded);
      return decoded.startsWith('http://') || decoded.startsWith('https://') ? decoded : null;
    } catch {
      return null;
    }
  }, []);

  const directSource = getDirectSource(src);
  const activeSrc = useDirectSource && directSource ? directSource : src;
  const imgSrc = retryCount > 0 ? `${activeSrc}${activeSrc.includes('?') ? '&' : '?'}retry=${retryCount}` : activeSrc;

  const placeholderStyle: React.CSSProperties = naturalSize
    ? { aspectRatio: `${naturalSize.w}/${naturalSize.h}` }
    : { aspectRatio: '2/3' };

  const containerStyle: React.CSSProperties = {
    marginBottom: `${pageGap}px`,
    contentVisibility: priority ? 'visible' : 'auto',
    // Only specify height estimate — hardcoding width (e.g. 800px) causes
    // horizontal overflow on mobile viewports smaller than that estimate.
    containIntrinsicSize: naturalSize
      ? `auto ${naturalSize.w}px auto ${naturalSize.h}px`
      : '0px 1400px',
  };

  return (
    <div ref={imgRef} style={containerStyle} className="relative">
      {!loaded && !error && (
        <div className="w-full bg-secondary/50 animate-pulse flex items-center justify-center" style={placeholderStyle}>
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
          loading={priority ? 'eager' : 'lazy'}
          decoding={priority ? 'sync' : 'async'}
          fetchPriority={priority ? 'high' : 'auto'}
          draggable={false}
          onLoad={handleLoad}
          onError={() => {
            if (!useDirectSource && directSource) {
              setUseDirectSource(true);
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
