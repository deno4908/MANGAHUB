import { useState, useRef, useEffect, useCallback, useContext, memo } from 'react';
import { ImageFailureContext } from './ImageFailureContext';
import { acquireCover, cachedCover, canCacheCover, invalidateCover } from '@/lib/coverCache';
import { motion } from 'framer-motion';
import { ImageOff, RefreshCw } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import { cn } from '@/lib/utils';

interface OptimizedImageProps {
  src: string;
  /** Fallback URL used if the primary image fails or stays too slow */
  fallbackSrc?: string;
  fallbackDelayMs?: number;
  alt: string;
  className?: string;
  priority?: boolean;
  aspectRatio?: string;
  rootMargin?: string;
  maxRetries?: number;
  cacheCover?: boolean;
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
  fallbackDelayMs,
  alt,
  className = '',
  priority = false,
  aspectRatio,
  rootMargin = '400px',
  maxRetries = 2,
  cacheCover = true,
  onClick,
  draggable,
  style,
}: OptimizedImageProps) => {
  const reportUnavailable = useContext(ImageFailureContext);
  const mode = useThemeStore((s) => s.mode);
  const themedFallbackSrc = mode === 'dark' ? DARK_FALLBACK_SRC : LIGHT_FALLBACK_SRC;

  const normalizedSrc = isNoCoverSrc(src) ? themedFallbackSrc : src;
  const normalizedFallbackSrc = (() => {
    const raw = String(fallbackSrc || '').trim();
    if (!raw) return themedFallbackSrc;
    return isNoCoverSrc(raw) ? themedFallbackSrc : raw;
  })();

  const cachedInitialSrc = loadedCache.has(normalizedSrc)
    ? normalizedSrc
    : (normalizedFallbackSrc && loadedCache.has(normalizedFallbackSrc) ? normalizedFallbackSrc : normalizedSrc);
  const alreadyCached = loadedCache.has(cachedInitialSrc);

  const [activeSrc, setActiveSrc]   = useState(cachedInitialSrc);
  const [loaded, setLoaded]         = useState(alreadyCached);
  const [error, setError]           = useState(false);
  const [inView, setInView]         = useState(priority || alreadyCached);
  const [retryCount, setRetryCount] = useState(0);
  const [needsRecover, setNeedsRecover] = useState(false);
  const [recoverAttempts, setRecoverAttempts] = useState(0);
  const [coverResource, setCoverResource] = useState<{ source: string; attempt: number; url: string }>();
  const [visible, setVisible] = useState(priority || alreadyCached);

  const hasRemoteCandidate =
    isRemoteUrl(normalizedSrc) || isRemoteUrl(normalizedFallbackSrc);
  const maxRecoverAttempts = Math.max(1, maxRetries + 1);
  const fallbackSwitchDelayMs =
    typeof fallbackDelayMs === 'number'
      ? Math.max(0, fallbackDelayMs)
      : (isRemoteUrl(normalizedSrc) ? 10_000 : 0);

  const containerRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(alreadyCached);

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  // ── Intersection observer ──────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); setVisible(true); return; }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setInView(true);
      },
      { rootMargin, threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  // ── Delayed fallback ───────────────────────────────────────────────────────
  // Give the primary CDN a fair chance before switching. If the remote
  // fallback also stalls, show a local cover instead of leaving a permanent
  // skeleton; recovery below keeps trying the remote sources in background.
  useEffect(() => {
    if (!inView || loaded || error || !isRemoteUrl(activeSrc)) return;
    // Managed downloads have a deadline that starts when a queue slot opens.
    // Do not abandon healthy covers just because visible images were ahead.
    if (cacheCover && canCacheCover(activeSrc)) return;

    const isPrimarySource = activeSrc === normalizedSrc;
    const timeoutMs = isPrimarySource ? fallbackSwitchDelayMs : 12_000;
    if (timeoutMs <= 0) return;

    const timer = window.setTimeout(() => {
      if (loadedRef.current) return;
      loadedRef.current = false;
      setLoaded(false);
      setError(false);

      if (isPrimarySource && normalizedFallbackSrc && activeSrc !== normalizedFallbackSrc) {
        if (isNoCoverSrc(normalizedFallbackSrc)) reportUnavailable?.(normalizedSrc);
        setActiveSrc(normalizedFallbackSrc);
        return;
      }

      if (activeSrc !== themedFallbackSrc) {
        reportUnavailable?.(normalizedSrc);
        if (hasRemoteCandidate) setNeedsRecover(true);
        setActiveSrc(themedFallbackSrc);
      }
    }, timeoutMs);

    return () => window.clearTimeout(timer);
  }, [
    inView,
    loaded,
    error,
    activeSrc,
    normalizedSrc,
    normalizedFallbackSrc,
    fallbackSwitchDelayMs,
    themedFallbackSrc,
    hasRemoteCandidate,
    reportUnavailable,
    cacheCover,
  ]);

  // ── Reset when src prop changes ────────────────────────────────────────────
  useEffect(() => {
    const cachedSrc = loadedCache.has(normalizedSrc)
      ? normalizedSrc
      : (normalizedFallbackSrc && loadedCache.has(normalizedFallbackSrc) ? normalizedFallbackSrc : normalizedSrc);
    setActiveSrc(cachedSrc);
    const cached = loadedCache.has(cachedSrc);
    loadedRef.current = cached;
    setLoaded(cached);
    setError(false);
    setRetryCount(0);
    setNeedsRecover(false);
    setRecoverAttempts(0);
    if (cached) setInView(true);
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
    if (loadedPlaceholder && hasRemoteCandidate) {
      setNeedsRecover(recoverAttempts < maxRecoverAttempts);
      return;
    }
    setNeedsRecover(false);
    setRecoverAttempts(0);
  }, [activeSrc, hasRemoteCandidate, recoverAttempts, maxRecoverAttempts]);

  const handleError = useCallback(() => {
    loadedCache.delete(activeSrc);
    if (cacheCover) invalidateCover(activeSrc);
    loadedRef.current = false;
    // Primary failed; switch to the fallback source if available.
    if (activeSrc === normalizedSrc && normalizedFallbackSrc && activeSrc !== normalizedFallbackSrc) {
      if (isNoCoverSrc(normalizedFallbackSrc)) reportUnavailable?.(normalizedSrc);
      setLoaded(false);
      setActiveSrc(normalizedFallbackSrc);
      return;
    }
    // Final local fallback when upstream sources fail.
    if (activeSrc !== themedFallbackSrc) {
      reportUnavailable?.(normalizedSrc);
      setLoaded(false);
      if (hasRemoteCandidate) setNeedsRecover(true);
      setActiveSrc(themedFallbackSrc);
      return;
    }
    // Both sources failed
    if (hasRemoteCandidate) setNeedsRecover(true);
    setError(true);
  }, [normalizedSrc, normalizedFallbackSrc, activeSrc, themedFallbackSrc, hasRemoteCandidate, reportUnavailable, cacheCover]);

  const useCoverCache = cacheCover && canCacheCover(activeSrc);
  // Metadata can update recovery URLs while the primary is still loading.
  // Keep its shared download attached and use the newest recovery handler
  // only if it fails, rather than aborting and starting the same URL again.
  const coverErrorRef = useRef(handleError);
  coverErrorRef.current = handleError;
  useEffect(() => {
    if (!inView || error || !useCoverCache) return;
    let mounted = true;
    const resource = acquireCover(activeSrc, priority ? 'visible' : 'normal');
    void resource.promise.then(url => {
      if (mounted) setCoverResource({ source: activeSrc, attempt: retryCount, url });
    }, () => { if (mounted) coverErrorRef.current(); });
    return () => { mounted = false; resource.release(); };
  }, [activeSrc, retryCount, inView, error, useCoverCache, priority]);

  const handleManualRetry = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    loadedRef.current = false;
    setLoaded(false);
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
      loadedRef.current = false;
      setLoaded(false);
      setActiveSrc(normalizedSrc);
      setError(false);
      setRetryCount(r => r + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [error, retryCount, maxRetries, normalizedSrc]);

  // If a card ended up showing placeholder cover, keep trying to recover real cover in background.
  useEffect(() => {
    // Wait for the current attempt to finish. Previously this timer kept
    // rotating sources while a download was still queued or in flight.
    if (!inView || !needsRecover || !hasRemoteCandidate || (!isNoCoverSrc(activeSrc) && !error)) return;
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
      setNeedsRecover(false);
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
    activeSrc,
    error,
  ]);

  // A temporary CDN outage must not pin a mounted card to the placeholder
  // forever. Retry quietly at a bounded rate, only near the viewport and while
  // the tab is visible. Navigating to a detail page is no longer needed.
  useEffect(() => {
    if (!visible || !hasRemoteCandidate || recoverAttempts < maxRecoverAttempts
        || (!isNoCoverSrc(activeSrc) && !error)) return;
    const recover = () => {
      if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
      setRecoverAttempts(0);
      setNeedsRecover(true);
    };
    const timer = window.setInterval(recover, 30_000);
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
    };
  }, [visible, activeSrc, error, hasRemoteCandidate, recoverAttempts, maxRecoverAttempts]);

  // Build src with cache-buster on retries
  const remoteSrc = retryCount === 0
    ? activeSrc
    : `${activeSrc}${activeSrc.includes('?') ? '&' : '?'}retry=${retryCount}`;
  const imgSrc = useCoverCache
    ? (coverResource?.source === activeSrc && coverResource.attempt === retryCount
      ? coverResource.url : cachedCover(activeSrc))
    : remoteSrc;

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

      {inView && !error && imgSrc && (
        <motion.img
          initial={alreadyCached ? false : { opacity: 0 }}
          animate={{ opacity: loaded ? 1 : 0 }}
          transition={{ duration: alreadyCached ? 0 : 0.25, ease: 'easeOut' }}
          src={imgSrc}
          alt={alt}
          className={cn('w-full h-full', className)}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          referrerPolicy="no-referrer"
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
