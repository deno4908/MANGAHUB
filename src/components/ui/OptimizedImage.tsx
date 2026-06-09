import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { motion } from 'framer-motion';
import { ImageOff, RefreshCw } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import { cn } from '@/lib/utils';

interface OptimizedImageProps {
  src: string;
  /** CDN/fallback URL raced in parallel with src from the moment image enters viewport */
  fallbackSrc?: string;
  alt: string;
  className?: string;
  priority?: boolean;
  aspectRatio?: string;
  rootMargin?: string;
  maxRetries?: number;
  onClick?: () => void;
  draggable?: boolean;
  style?: React.CSSProperties;
}

/** Browser-level memory cache — avoids re-fetching known-good URLs */
const loadedCache = new Set<string>();
const LIGHT_FALLBACK_SRC = '/no-cover.svg';
const DARK_FALLBACK_SRC = '/no-cover-dark.svg';

function isNoCoverSrc(value?: string): boolean {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.endsWith('/no-cover.svg') || raw.endsWith('/no-cover-dark.svg');
}

function isRemoteUrl(value?: string): boolean {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) || raw.startsWith('//');
}

const OptimizedImage = memo(({
  src,
  fallbackSrc,
  alt,
  className = '',
  priority = false,
  aspectRatio,
  rootMargin = '400px',
  maxRetries = 2,
  onClick,
  draggable,
  style,
}: OptimizedImageProps) => {
  const mode = useThemeStore((s) => s.mode);
  const themedFallbackSrc = mode === 'dark' ? DARK_FALLBACK_SRC : LIGHT_FALLBACK_SRC;

  const normalizedSrc = isNoCoverSrc(src) ? themedFallbackSrc : src;
  const normalizedFallbackSrc = (() => {
    const raw = String(fallbackSrc || '').trim();
    if (!raw) return themedFallbackSrc;
    return isNoCoverSrc(raw) ? themedFallbackSrc : raw;
  })();

  const alreadyCached =
    loadedCache.has(normalizedSrc) || (!!normalizedFallbackSrc && loadedCache.has(normalizedFallbackSrc));

  const [activeSrc, setActiveSrc]   = useState(normalizedSrc);
  const [loaded, setLoaded]         = useState(alreadyCached);
  const [error, setError]           = useState(false);
  const [inView, setInView]         = useState(priority || alreadyCached);
  const [retryCount, setRetryCount] = useState(0);
  const [needsRecover, setNeedsRecover] = useState(false);
  const [recoverAttempts, setRecoverAttempts] = useState(0);

  const hasRemoteCandidate =
    isRemoteUrl(normalizedSrc) || isRemoteUrl(normalizedFallbackSrc);
  const maxRecoverAttempts = Math.max(6, maxRetries + 3);

  // Keep a ref so the CDN race callback can check if proxy already won
  const loadedRef    = useRef(alreadyCached);
  const containerRef = useRef<HTMLDivElement>(null);
  loadedRef.current  = loaded;

  // ── Intersection observer ──────────────────────────────────────────────────
  useEffect(() => {
    if (priority || inView) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); observer.disconnect(); } },
      { rootMargin, threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [priority, inView, rootMargin]);

  // ── Parallel CDN race ──────────────────────────────────────────────────────
  // As soon as the image enters the viewport, start loading the CDN URL in a
  // hidden Image() in parallel with the visible <img> (which loads the proxy).
  // Whichever finishes first is displayed — no timeout, no sequential waiting.
  useEffect(() => {
    if (!inView || alreadyCached || !normalizedFallbackSrc) return;
    // Do not race local placeholder fallback (e.g. /no-cover.svg).
    // It loads instantly and can incorrectly replace a valid primary image.
    if (!isRemoteUrl(normalizedFallbackSrc)) return;

    let cancelled = false;
    const cdnImg = new window.Image();

    cdnImg.onload = () => {
      if (cancelled || loadedRef.current) return; // proxy already won, discard
      loadedCache.add(normalizedFallbackSrc);
      setActiveSrc(normalizedFallbackSrc);
      setLoaded(true);
    };
    // CDN error: ignore — proxy is still trying; handleError will catch both
    cdnImg.src = normalizedFallbackSrc;

    return () => { cancelled = true; };
  }, [inView, normalizedSrc, normalizedFallbackSrc, alreadyCached]);

  // ── Reset when src prop changes ────────────────────────────────────────────
  useEffect(() => {
    setActiveSrc(normalizedSrc);
    const cached = loadedCache.has(normalizedSrc) || (!!normalizedFallbackSrc && loadedCache.has(normalizedFallbackSrc));
    loadedRef.current = cached;
    setLoaded(cached);
    setError(false);
    setRetryCount(0);
    setNeedsRecover(false);
    setRecoverAttempts(0);
    if (cached) setInView(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSrc, normalizedFallbackSrc]);

  useEffect(() => {
    if (!isNoCoverSrc(activeSrc)) return;
    if (activeSrc === themedFallbackSrc) return;
    setActiveSrc(themedFallbackSrc);
  }, [activeSrc, themedFallbackSrc]);

  // ── Visible <img> handlers ─────────────────────────────────────────────────
  const handleLoad = useCallback(() => {
    if (!isNoCoverSrc(activeSrc)) {
      loadedCache.add(activeSrc);
    }
    loadedRef.current = true;
    setLoaded(true);
    const loadedPlaceholder = isNoCoverSrc(activeSrc);
    if (loadedPlaceholder && hasRemoteCandidate && recoverAttempts < maxRecoverAttempts) {
      setNeedsRecover(true);
      return;
    }
    setNeedsRecover(false);
    setRecoverAttempts(0);
  }, [activeSrc, hasRemoteCandidate, recoverAttempts, maxRecoverAttempts]);

  const handleError = useCallback(() => {
    // Proxy failed — if CDN race hasn't resolved yet, force-switch to CDN now.
    // The CDN Image() may already be in-flight so src switch = near-instant.
    if (normalizedFallbackSrc && activeSrc !== normalizedFallbackSrc) {
      setLoaded(false);
      setActiveSrc(normalizedFallbackSrc);
      return;
    }
    // Final local fallback when upstream sources fail.
    if (activeSrc !== themedFallbackSrc) {
      setLoaded(false);
      if (hasRemoteCandidate) setNeedsRecover(true);
      setActiveSrc(themedFallbackSrc);
      return;
    }
    // Both sources failed
    if (hasRemoteCandidate) setNeedsRecover(true);
    setError(true);
  }, [normalizedFallbackSrc, activeSrc, themedFallbackSrc, hasRemoteCandidate]);

  const handleManualRetry = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveSrc(normalizedSrc);
    setError(false);
    setNeedsRecover(false);
    setRecoverAttempts(0);
    setRetryCount(r => r + 1);
  }, [normalizedSrc]);

  // ── Auto-retry with back-off ───────────────────────────────────────────────
  useEffect(() => {
    if (!error || retryCount >= maxRetries) return;
    const delay = retryCount === 0 ? 1000 : 2500;
    const t = setTimeout(() => {
      setActiveSrc(normalizedSrc);
      setError(false);
      setRetryCount(r => r + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [error, retryCount, maxRetries, normalizedSrc]);

  // If a card ended up showing placeholder cover, keep trying to recover real cover in background.
  useEffect(() => {
    if (!inView || !needsRecover || !hasRemoteCandidate) return;
    if (recoverAttempts >= maxRecoverAttempts) {
      setNeedsRecover(false);
      return;
    }

    const delay = recoverAttempts === 0
      ? 800
      : Math.min(6000, 1200 * (recoverAttempts + 1));

    const t = setTimeout(() => {
      // Alternate between proxy and CDN on each attempt for better recovery odds
      const candidates = [normalizedSrc, normalizedFallbackSrc].filter(
        (u) => isRemoteUrl(u) && !isNoCoverSrc(u),
      );
      const nextSrc = candidates.length > 0
        ? candidates[recoverAttempts % candidates.length]
        : '';

      if (!nextSrc || isNoCoverSrc(nextSrc)) {
        setNeedsRecover(false);
        return;
      }

      loadedRef.current = false;
      setLoaded(false);
      setError(false);
      setActiveSrc(nextSrc);
      setRetryCount((r) => r + 1);
      setRecoverAttempts((count) => count + 1);
    }, delay);

    return () => clearTimeout(t);
  }, [
    inView,
    needsRecover,
    hasRemoteCandidate,
    recoverAttempts,
    maxRecoverAttempts,
    normalizedSrc,
    normalizedFallbackSrc,
  ]);

  // Build src with cache-buster on retries
  const imgSrc = retryCount === 0
    ? activeSrc
    : `${activeSrc}${activeSrc.includes('?') ? '&' : '?'}retry=${retryCount}`;

  return (
    <div
      ref={containerRef}
      className={cn('relative overflow-hidden', className)}
      style={{ aspectRatio, ...style }}
      onClick={onClick}
    >
      {!loaded && !error && (
        <div className="absolute inset-0 bg-secondary/60 animate-pulse" />
      )}

      {error && retryCount >= maxRetries && (
        <div className="absolute inset-0 bg-secondary/40 flex flex-col items-center justify-center gap-2">
          <ImageOff className="w-6 h-6 text-muted-foreground/50" />
          <button
            onClick={handleManualRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/90 text-primary-foreground text-xs font-bold hover:bg-primary transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Thử lại
          </button>
        </div>
      )}

      {inView && !error && (
        <motion.img
          initial={alreadyCached ? false : { opacity: 0 }}
          animate={{ opacity: loaded ? 1 : 0 }}
          transition={{ duration: alreadyCached ? 0 : 0.25, ease: 'easeOut' }}
          src={imgSrc}
          alt={alt}
          className={cn('w-full h-full', className)}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          draggable={draggable}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
    </div>
  );
});

OptimizedImage.displayName = 'OptimizedImage';
export default OptimizedImage;
