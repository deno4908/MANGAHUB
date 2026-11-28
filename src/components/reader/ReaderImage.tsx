import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { RefreshCw } from 'lucide-react';
import { getMangaDexImageFallback, getPreferredMangaDexImageUrl, rememberMangaDexImageFailure } from '@/lib/mangaDexImages';
import { acquireReaderImage, canCacheReaderImage, invalidateCover } from '@/lib/coverCache';
import { observeReaderPage } from '@/lib/readerViewport';

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

const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const MIN_RECOVERY_MS = 30_000;
const RECOVERY_DEADLINE_MS = 60_000;

const ReaderImage = memo(({ src, alt, index, imageFit, pageGap, onVisible, priority = false, fallbackSrc }: ReaderImageProps) => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [inView, setInView] = useState(priority);
  const [visible, setVisible] = useState(priority);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [download, setDownload] = useState<{ key: string; url: string }>();
  const imgRef = useRef<HTMLDivElement>(null);
  const resourceRef = useRef<ReturnType<typeof acquireReaderImage>>();
  const began = useRef(0);
  const failedAt = useRef(0);
  const retryAfterAt = useRef(0);
  const wasVisible = useRef(priority);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const nearViewport = useCallback(() => {
    const rect = imgRef.current?.getBoundingClientRect();
    return !!rect && rect.bottom >= -1000 && rect.top <= window.innerHeight + 1000;
  }, []);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    return observeReaderPage(el, {
      near: () => setInView(true),
      visible: value => {
        setVisible(value);
        if (value) onVisibleRef.current?.(index);
      },
    });
  }, [index]);

  useEffect(() => {
    began.current = 0;
    setLoaded(false);setError(false);setWaiting(false);setAttempt(0);setNaturalSize(null);
  }, [src, cycle]);

  const fallback = fallbackSrc || getMangaDexImageFallback(src);
  const activeSrc = attempt % 2 === 1 && fallback && fallback !== src ? fallback : getPreferredMangaDexImageUrl(src);
  const retry = cycle * (RETRY_DELAYS.length + 1) + attempt;
  const url = retry ? `${activeSrc}${activeSrc.includes('?') ? '&' : '?'}retry=${retry}` : activeSrc;
  const key = `${activeSrc}:${cycle}:${attempt}`;
  const managed = canCacheReaderImage(activeSrc);
  const failed = useCallback((reason?: unknown) => {
    failedAt.current = Date.now();
    const cooldown = reason && typeof reason === 'object' && 'retryAfterMs' in reason ? Number(reason.retryAfterMs) : 0;
    retryAfterAt.current = failedAt.current + (Number.isFinite(cooldown) ? Math.max(0, Math.min(60_000, cooldown)) : 0);
    rememberMangaDexImageFailure(activeSrc);
    invalidateCover(url);setLoaded(false);setWaiting(true);
  }, [url, activeSrc]);

  // Own proxies need the verified website token and QQ relay recovery. Native
  // CDN URLs remain ordinary images, preserving their direct download speed.
  useEffect(() => {
    if (!inView || error || waiting || !managed) return;
    let disposed = false;
    const resource = acquireReaderImage(url, visible || priority ? 'visible' : 'prefetch');
    resourceRef.current = resource;
    void resource.promise.then(objectUrl => { if (!disposed) setDownload({ key, url: objectUrl }); },
      reason => { if (!disposed) failed(reason); });
    return () => { disposed = true;resource.release();if (resourceRef.current === resource) resourceRef.current = undefined; };
    // Visibility only sets the priority at acquisition. Scrolling must not
    // cancel an in-flight download or replace an already decoded <img>.
  }, [key, inView, managed, error, waiting, url, failed]);

  useEffect(() => {
    if (visible || priority) resourceRef.current?.promote('visible');
  }, [visible, priority]);

  useEffect(() => {
    if (!inView || loaded || error || waiting || managed) return;
    const timer = window.setTimeout(failed, /\/truyenqq\/image\//.test(activeSrc) ? 25_000 : 18_000);
    return () => window.clearTimeout(timer);
  }, [key, activeSrc, inView, loaded, error, waiting, failed, managed]);

  useEffect(() => {
    if (!inView || loaded || error) return;
    if (!began.current) began.current = Date.now();
    const elapsed = Date.now() - began.current;
    const timer = window.setTimeout(() => setError(true), Math.max(0, RECOVERY_DEADLINE_MS - elapsed));
    return () => window.clearTimeout(timer);
  }, [inView, loaded, error, cycle, src]);

  useEffect(() => {
    if (!waiting || error || !inView) return;
    const backoff = attempt < RETRY_DELAYS.length ? Math.max(0, RETRY_DELAYS[attempt] - (Date.now() - failedAt.current))
      : Math.max(0, MIN_RECOVERY_MS - (Date.now() - began.current));
    const delay = Math.max(backoff, retryAfterAt.current - Date.now());
    const timer = window.setTimeout(() => {
      if (navigator.onLine === false || document.visibilityState === 'hidden' || !nearViewport()) return;
      if (attempt >= RETRY_DELAYS.length || Date.now() - began.current >= RECOVERY_DEADLINE_MS) setError(true);
      else { setAttempt(value => value + 1);setWaiting(false); }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [waiting, error, inView, attempt, cycle, visible, nearViewport]);

  useEffect(() => {
    const recover = () => {
      if (!loaded && (waiting || error) && inView && nearViewport() && navigator.onLine !== false && document.visibilityState !== 'hidden') setCycle(value => value + 1);
    };
    // A long-hidden, distant page can exhaust its recovery window. Resume it
    // when the reader returns to that page, not all past failures at tab focus.
    // The transition check keeps a visible outage's retry budget bounded.
    if (visible && !wasVisible.current && error) recover();
    wasVisible.current = visible;
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => { window.removeEventListener('online', recover);document.removeEventListener('visibilitychange', recover); };
  }, [loaded, inView, waiting, error, visible, nearViewport]);

  const fitClass = imageFit === 'width' ? 'block w-full h-auto' : imageFit === 'height'
    ? 'block max-h-screen max-w-full w-auto h-auto mx-auto object-contain' : 'block max-w-full h-auto mx-auto';
  const placeholder = { aspectRatio: naturalSize ? `${naturalSize.w}/${naturalSize.h}` : '2/3' };
  const imageSrc = managed ? download?.key === key ? download.url : undefined : url;

  return (
    <div ref={imgRef} data-reader-page={index} style={{ marginBottom: `${pageGap}px` }} className="relative w-full min-w-0 max-w-full overflow-hidden">
      {!loaded && !error && <div className={`flex w-full items-center justify-center bg-secondary/50 ${inView ? 'animate-pulse' : ''}`} style={placeholder}>
        <div className="text-muted-foreground text-xs font-medium">Trang {index + 1}</div>
      </div>}
      {error ? <div className="w-full bg-secondary/30 flex flex-col items-center justify-center gap-3 border border-border rounded-lg" style={placeholder}>
        <p className="text-muted-foreground text-sm">Không thể tải ảnh</p>
        <button onClick={event => { event.stopPropagation();setCycle(value => value + 1); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition-opacity">
          <RefreshCw className="w-4 h-4" /> Thử lại
        </button>
      </div> : inView && !waiting && imageSrc ? <img key={key} src={imageSrc} alt={alt}
        className={`${fitClass} select-none ${loaded ? '' : 'invisible absolute'}`} loading="eager" decoding="async"
        fetchPriority={visible || priority ? 'high' : 'auto'} referrerPolicy="no-referrer" draggable={false}
        onLoad={event => {
          setNaturalSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight });setLoaded(true);
          // The decoded <img> keeps its pixels when its object URL is revoked.
          // Stop pinning every previously read blob in JS for a long chapter;
          // the shared cache can now enforce its byte limit without replacing
          // the displayed image or downloading it again on reverse scroll.
          resourceRef.current?.release();resourceRef.current = undefined;
        }}
        onError={failed} /> : null}
    </div>
  );
});
ReaderImage.displayName = 'ReaderImage';
export default ReaderImage;
