import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  GaugeCircle,
  Layers,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import ImageEditorModal from '@/components/manga/ImageEditorModal';
import {
  STUDIO_PRESET_OPTIONS,
  analyzeTranslationImage,
  runTranslationAlgorithmPreset,
  type StudioAlgorithmPreset,
  type StudioImageMetrics,
} from '@/lib/translationStudioAlgorithms';
import {
  useTranslationStudioStore,
  type TranslationStudioImage,
} from '@/store/translationStudioStore';

type BatchScope = 'current' | 'all' | 'range';

const toPercent = (value: number): string => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;

const getPreviewSources = (image: TranslationStudioImage | null | undefined): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of [image?.preview, image?.fallbackPreview]) {
    const source = String(candidate || '').trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    output.push(source);
  }
  return output;
};

const runWithPreviewFallback = async <T,>(
  image: TranslationStudioImage | null | undefined,
  runner: (source: string) => Promise<T>,
): Promise<T> => {
  const sources = getPreviewSources(image);
  if (!sources.length) {
    throw new Error('Khong co anh de xu ly');
  }

  let lastError: unknown = null;
  for (const source of sources) {
    try {
      return await runner(source);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Khong doc duoc anh');
};

const makeEditedImageFromDataUrl = async (
  image: TranslationStudioImage,
  pageIndex: number,
  imageDataUrl: string,
  tag = 'studio',
): Promise<TranslationStudioImage> => {
  const response = await fetch(imageDataUrl);
  if (!response.ok) {
    throw new Error('Không đọc được ảnh kết quả từ studio');
  }

  const blob = await response.blob();
  const extRaw = String(blob.type || '').split('/')[1] || 'png';
  const ext = extRaw === 'jpeg' ? 'jpg' : extRaw;
  const baseName = String(image?.name || `page-${pageIndex + 1}`)
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const nextName = `${baseName || `page-${pageIndex + 1}`}-${tag}.${ext}`;
  const file = new File([blob], nextName, { type: blob.type || 'image/png' });

  return {
    id: image.id,
    file,
    preview: URL.createObjectURL(file),
    fallbackPreview: undefined,
    name: file.name,
    size: file.size,
  };
};

const UploadTranslationStudio = () => {
  const navigate = useNavigate();

  const sessionId = useTranslationStudioStore((state) => state.sessionId);
  const sourcePath = useTranslationStudioStore((state) => state.sourcePath);
  const studioImages = useTranslationStudioStore((state) => state.images);
  const initialIndex = useTranslationStudioStore((state) => state.initialIndex);
  const updateImageAt = useTranslationStudioStore((state) => state.updateImageAt);
  const clearSession = useTranslationStudioStore((state) => state.clearSession);

  const [activeIndex, setActiveIndex] = useState(0);
  const [preset, setPreset] = useState<StudioAlgorithmPreset>('clarity-pro');
  const [batchScope, setBatchScope] = useState<BatchScope>('current');
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [metrics, setMetrics] = useState<StudioImageMetrics | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorBusyLabel, setEditorBusyLabel] = useState('');

  const totalPages = studioImages.length;

  useEffect(() => {
    setActiveIndex(Math.max(0, Math.min(initialIndex, Math.max(0, totalPages - 1))));
  }, [initialIndex, totalPages]);

  useEffect(() => {
    setRangeStart(1);
    setRangeEnd(Math.max(1, totalPages));
  }, [totalPages]);

  const activeImage = studioImages[activeIndex] || null;

  useEffect(() => {
    let active = true;
    if (!getPreviewSources(activeImage).length) {
      setMetrics(null);
      return;
    }

    setIsAnalyzing(true);
    runWithPreviewFallback(activeImage, analyzeTranslationImage)
      .then((payload) => {
        if (!active) return;
        setMetrics(payload);
      })
      .catch(() => {
        if (!active) return;
        setMetrics(null);
      })
      .finally(() => {
        if (!active) return;
        setIsAnalyzing(false);
      });

    return () => {
      active = false;
    };
  }, [activeImage?.fallbackPreview, activeImage?.preview]);

  const editorImages = useMemo(
    () => studioImages.map((item) => ({
      id: item.id,
      preview: item.preview || item.fallbackPreview || '',
      fallbackPreview: item.fallbackPreview,
      name: item.name,
    })),
    [studioImages],
  );

  const resolveTargetIndexes = (): number[] => {
    if (totalPages <= 0) return [];
    if (batchScope === 'current') return [Math.max(0, Math.min(activeIndex, totalPages - 1))];
    if (batchScope === 'all') return Array.from({ length: totalPages }, (_, index) => index);

    const start = Math.max(1, Math.min(rangeStart, rangeEnd));
    const end = Math.min(totalPages, Math.max(rangeStart, rangeEnd));
    const output: number[] = [];
    for (let index = start; index <= end; index += 1) {
      output.push(index - 1);
    }
    return output;
  };

  const applyPresetBatch = async () => {
    if (isBatchRunning) return;

    const targetIndexes = resolveTargetIndexes();
    if (targetIndexes.length === 0) {
      toast.error('Không có trang nào để xử lý');
      return;
    }

    setIsBatchRunning(true);
    setBatchProgress(0);

    let successCount = 0;
    let failedCount = 0;

    try {
      for (let i = 0; i < targetIndexes.length; i += 1) {
        const pageIndex = targetIndexes[i];
        const latestImages = useTranslationStudioStore.getState().images;
        const sourceImage = latestImages[pageIndex];

        if (!getPreviewSources(sourceImage).length) {
          failedCount += 1;
          setBatchProgress((i + 1) / targetIndexes.length);
          continue;
        }

        try {
          const dataUrl = await runWithPreviewFallback(sourceImage, (source) =>
            runTranslationAlgorithmPreset(source, preset),
          );
          const nextImage = await makeEditedImageFromDataUrl(sourceImage, pageIndex, dataUrl, preset);
          updateImageAt(pageIndex, nextImage);
          successCount += 1;
        } catch {
          failedCount += 1;
        }

        setBatchProgress((i + 1) / targetIndexes.length);
      }

      if (successCount > 0 && failedCount === 0) {
        toast.success(`Đã xử lý ${successCount} trang bằng preset ${preset}`);
      } else if (successCount > 0) {
        toast.success(`Xử lý xong ${successCount}/${targetIndexes.length} trang`);
      } else {
        toast.error('Không thể xử lý trang nào, vui lòng thử lại');
      }
    } finally {
      setIsBatchRunning(false);
    }
  };

  const handleApplySingleFromEditor = async (index: number, imageDataUrl: string) => {
    const latestImages = useTranslationStudioStore.getState().images;
    const sourceImage = latestImages[index];
    if (!sourceImage) return;

    const nextImage = await makeEditedImageFromDataUrl(sourceImage, index, imageDataUrl, 'manual');
    updateImageAt(index, nextImage);
  };

  const handleBackToUpload = () => {
    if (editorBusy) {
      toast.warning(editorBusyLabel ? `Đợi "${editorBusyLabel}" xử lý xong rồi áp dụng` : 'Đợi editor xử lý xong rồi áp dụng');
      return;
    }

    if (!sessionId) {
      navigate('/upload/new');
      return;
    }

    navigate(sourcePath || '/upload/new', {
      state: {
        studioApplied: true,
        studioSessionId: sessionId,
      },
    });
  };

  const handleExitWithoutApply = () => {
    clearSession();
    navigate(sourcePath || '/upload/new');
  };

  if (!sessionId || totalPages === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-10 max-w-3xl">
          <div className="rounded-2xl border border-border bg-card p-6">
            <h1 className="text-xl font-bold">Translation Studio chưa có dữ liệu</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Hãy quay lại trang upload chapter, chọn ảnh, sau đó bấm "Vào chỉnh sửa" để mở studio.
            </p>
            <div className="mt-5 flex gap-3">
              <Link
                to="/upload/new"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
              >
                <ArrowLeft className="h-4 w-4" /> Về Upload Chapter
              </Link>
              <Link
                to="/upload"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold"
              >
                Về Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-[1600px] px-4 py-6">
        <div className="mb-4 rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-primary font-bold">Translation Studio Pro</p>
              <h1 className="mt-1 text-2xl font-black leading-tight">Trang chỉnh sửa dịch truyện chuyên biệt</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleExitWithoutApply}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-xs font-semibold"
              >
                <ArrowLeft className="h-4 w-4" /> Thoát không áp dụng
              </button>
              <button
                type="button"
                onClick={handleBackToUpload}
                disabled={editorBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CheckCircle2 className="h-4 w-4" /> Áp dụng và quay về upload
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
          <aside className="space-y-4">
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <Layers className="h-4 w-4 text-primary" /> Studio Session
              </h2>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <p>Tổng trang: <span className="font-bold text-foreground">{totalPages}</span></p>
                <p>Trang hiện tại: <span className="font-bold text-foreground">{activeIndex + 1}</span></p>
                <p>Session: <span className="font-mono text-[11px] text-foreground">{sessionId}</span></p>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <SlidersHorizontal className="h-4 w-4 text-primary" /> Batch Preset Pipeline
              </h2>

              <div className="mt-3 space-y-2">
                {STUDIO_PRESET_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setPreset(option.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      preset === option.id
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-secondary/30 hover:bg-secondary/50'
                    }`}
                  >
                    <p className="text-xs font-bold">{option.label}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p>
                  </button>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => setBatchScope('current')}
                  className={`rounded-md px-2 py-1.5 font-semibold ${batchScope === 'current' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
                >
                  Trang hien tai
                </button>
                <button
                  type="button"
                  onClick={() => setBatchScope('all')}
                  className={`rounded-md px-2 py-1.5 font-semibold ${batchScope === 'all' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
                >
                  Toàn bộ
                </button>
                <button
                  type="button"
                  onClick={() => setBatchScope('range')}
                  className={`rounded-md px-2 py-1.5 font-semibold ${batchScope === 'range' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
                >
                  Theo khoảng
                </button>
              </div>

              {batchScope === 'range' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, totalPages)}
                    value={rangeStart}
                    onChange={(event) => setRangeStart(Number(event.target.value || 1))}
                    className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs"
                  />
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, totalPages)}
                    value={rangeEnd}
                    onChange={(event) => setRangeEnd(Number(event.target.value || 1))}
                    className="rounded-md border border-border bg-secondary px-2 py-1.5 text-xs"
                  />
                </div>
              )}

              <button
                type="button"
                onClick={applyPresetBatch}
                disabled={isBatchRunning}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60"
              >
                {isBatchRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                {isBatchRunning ? 'Đang xử lý preset...' : 'Chạy preset đã chọn'}
              </button>

              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.round(batchProgress * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Tiến độ: {Math.round(batchProgress * 100)}%</p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <GaugeCircle className="h-4 w-4 text-primary" /> Page Quality Analyzer
              </h2>

              {isAnalyzing && (
                <p className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang phân tích chất lượng trang...
                </p>
              )}

              {!isAnalyzing && metrics && (
                <div className="mt-3 space-y-2 text-xs">
                  <p className="text-muted-foreground">Readability: <span className="font-bold text-foreground">{toPercent(metrics.readabilityScore)}</span></p>
                  <p className="text-muted-foreground">Contrast: <span className="font-bold text-foreground">{toPercent(metrics.contrastScore)}</span></p>
                  <p className="text-muted-foreground">Noise: <span className="font-bold text-foreground">{toPercent(metrics.noiseScore)}</span></p>
                  <p className="text-muted-foreground">Text density: <span className="font-bold text-foreground">{toPercent(metrics.textDensity)}</span></p>

                  <div className="rounded-lg border border-border bg-secondary/30 p-2.5">
                    <p className="text-[11px] font-bold text-foreground flex items-center gap-1">
                      <Sparkles className="h-3.5 w-3.5 text-primary" /> Gợi ý thông minh
                    </p>
                    <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                      {metrics.recommendations.map((item, index) => (
                        <p key={`${item}-${index}`}>- {item}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <Wand2 className="h-4 w-4 text-primary" /> Workflow đề nghị
              </h2>
              <div className="mt-3 space-y-1.5 text-[11px] text-muted-foreground">
                <p>- Bước 1: Chạy Ink Clean cho những trang bị hạt và nhiều artifact.</p>
                <p>- Bước 2: Dùng công cụ Mask và Tô để xóa chính xác các bóng thoại khó.</p>
                <p>- Bước 3: Chạy AI remove + translate ngay trong panel editor.</p>
                <p>- Bước 4: Dùng compare trước/sau và Apply về upload chapter.</p>
              </div>
            </section>
          </aside>

          <section className="rounded-2xl border border-border bg-card p-2 sm:p-3">
            <ImageEditorModal
              open
              variant="page"
              title="Translation Studio Canvas"
              closeLabel="Quay về Upload"
              images={editorImages}
              initialIndex={initialIndex}
              onClose={handleBackToUpload}
              onApply={handleApplySingleFromEditor}
              onIndexChange={setActiveIndex}
              autoApplyChanges
              onBusyChange={(busy, label) => {
                setEditorBusy(busy);
                setEditorBusyLabel(label);
              }}
            />
          </section>
        </div>
      </div>
    </div>
  );
};

export default UploadTranslationStudio;
