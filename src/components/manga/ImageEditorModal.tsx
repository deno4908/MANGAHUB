import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Wand2, Type, Eraser, ScanSearch, X, Plus, Trash2, Check, Bot, Undo2, Languages, Copy, ArrowRight } from "lucide-react";
import { imageEditorApi } from "@/lib/api";
import { toast } from "sonner";

interface EditorImageItem {
  id: string;
  preview: string;
  fallbackPreview?: string;
  name: string;
}

interface ImageEditorModalProps {
  open: boolean;
  images: EditorImageItem[];
  initialIndex?: number;
  onClose: () => void;
  onApply: (index: number, imageDataUrl: string) => void | Promise<void>;
  autoApplyChanges?: boolean;
  variant?: "modal" | "page";
  title?: string;
  closeLabel?: string;
  onIndexChange?: (index: number) => void;
  onBusyChange?: (busy: boolean, label: string) => void;
}

interface EditorRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EditorOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontName: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
}

const DEFAULT_FONT_OPTIONS = [
  "Comic Sans MS",
  "Segoe UI",
  "Arial",
  "Tahoma",
  "Verdana",
  "Times New Roman",
];

const AI_PROVIDER_STORAGE_KEY = "mb:editor:ai-provider";
const AI_MODEL_STORAGE_KEY = "mb:editor:ai-model";
const OPENAI_BASE_URL_STORAGE_KEY = "mb:editor:openai-base-url";
const LEGACY_GEMINI_COOKIE_STORAGE_KEY = "mb:editor:gemini-cookies";
const LEGACY_OPENAI_API_KEY_STORAGE_KEY = "mb:editor:openai-api-key";
const GEMINI_DEFAULT_MODEL = "unspecified";
const OPENAI_DEFAULT_MODEL = "gpt-image-1";
const GEMINI_MODEL_OPTIONS = [
  "unspecified",
  "gemini-3-flash",
  "gemini-3-pro",
  "gemini-3-flash-thinking",
  "gemini-3-pro-plus",
  "gemini-3-flash-plus",
  "gemini-3-flash-thinking-plus",
  "gemini-3-pro-advanced",
  "gemini-3-flash-advanced",
  "gemini-3-flash-thinking-advanced",
];
const OPENAI_MODEL_OPTIONS = ["gpt-image-1"];

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeDataUrlName = (name: string, index: number): string => {
  const base = String(name || `page-${index + 1}`)
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || `page-${index + 1}`}.png`;
};

const uniqueImageSources = (...candidates: Array<string | undefined | null>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of candidates) {
    const source = String(candidate || "").trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    output.push(source);
  }
  return output;
};

const ImageEditorModal = ({
  open,
  images,
  initialIndex = 0,
  onClose,
  onApply,
  autoApplyChanges = false,
  variant = "modal",
  title = "Editor Anh Truyen",
  closeLabel = "Dong",
  onIndexChange,
  onBusyChange,
}: ImageEditorModalProps) => {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [workingImageUrl, setWorkingImageUrl] = useState("");
  const [tool, setTool] = useState<"mask" | "brush" | "text" | "translate">("mask");
  const [regions, setRegions] = useState<EditorRegion[]>([]);
  const [overlays, setOverlays] = useState<EditorOverlay[]>([]);
  const [draftRegion, setDraftRegion] = useState<EditorRegion | null>(null);
  const [pointerStart, setPointerStart] = useState<{ x: number; y: number } | null>(null);
  const [isBrushPainting, setIsBrushPainting] = useState(false);
  const [hasBrushMask, setHasBrushMask] = useState(false);
  const [brushRadius, setBrushRadius] = useState(14);
  const [naturalSize, setNaturalSize] = useState({ width: 1, height: 1 });
  const [displaySize, setDisplaySize] = useState({ width: 1, height: 1 });
  const [textValue, setTextValue] = useState("");
  const [textFontName, setTextFontName] = useState(DEFAULT_FONT_OPTIONS[0]);
  const [textFontSize, setTextFontSize] = useState(34);
  const [textColor, setTextColor] = useState("#111111");
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  const [textBoxSize, setTextBoxSize] = useState({ w: 280, h: 130 });
  const [textAnchor, setTextAnchor] = useState<{ x: number; y: number } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [fontOptions, setFontOptions] = useState<string[]>(DEFAULT_FONT_OPTIONS);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [detectedFontHint, setDetectedFontHint] = useState("");
  const [geminiCookies, setGeminiCookies] = useState("");
  const [aiProvider, setAiProvider] = useState<"gemini" | "openai-compatible">("gemini");
  const [aiModel, setAiModel] = useState(GEMINI_DEFAULT_MODEL);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [aiUserPrompt, setAiUserPrompt] = useState("");
  const [compareImageUrl, setCompareImageUrl] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [imageHistory, setImageHistory] = useState<string[]>([]);
  // ── Translate tool state ──
  const [translateTargetLang, setTranslateTargetLang] = useState("vi");
  const [ocrResult, setOcrResult] = useState<{ text: string; lines: Array<{ text: string; confidence: number }>; gpu_used: boolean; detected_language?: string; avg_confidence?: number } | null>(null);
  const [translatedText, setTranslatedText] = useState("");
  const [translateModel, setTranslateModel] = useState("");
  const [translateRegion, setTranslateRegion] = useState<EditorRegion | null>(null);
  const [showTranslatePopup, setShowTranslatePopup] = useState(false);

  const pushHistory = (url: string) => {
    if (url) setImageHistory((prev) => [...prev, url]);
  };

  const handleUndo = () => {
    setImageHistory((prev) => {
      if (prev.length === 0) return prev;
      const newHistory = [...prev];
      const lastUrl = newHistory.pop()!;
      setWorkingImageUrl(lastUrl);
      setShowCompare(false);
      return newHistory;
    });
  };

  const getModelOptionsByProvider = (provider: "gemini" | "openai-compatible") =>
    provider === "gemini" ? GEMINI_MODEL_OPTIONS : OPENAI_MODEL_OPTIONS;

  const getDefaultModelByProvider = (provider: "gemini" | "openai-compatible") =>
    provider === "gemini" ? GEMINI_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;

  const currentImage = images[currentIndex] || null;

  const scaleX = displaySize.width / naturalSize.width;
  const scaleY = displaySize.height / naturalSize.height;

  const allRegions = useMemo(() => {
    if (!draftRegion) return regions;
    return [...regions, draftRegion];
  }, [regions, draftRegion]);

  const resetEditorState = (nextImageUrl: string) => {
    setWorkingImageUrl(nextImageUrl || "");
    setRegions([]);
    setOverlays([]);
    setDraftRegion(null);
    setPointerStart(null);
    setIsBrushPainting(false);
    setHasBrushMask(false);
    brushLastPointRef.current = null;
    setTextAnchor(null);
    setDetectedFontHint("");

    const canvas = brushCanvasRef.current;
    if (canvas) {
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  useEffect(() => {
    if (!open) return;
    const nextIndex = clamp(initialIndex, 0, Math.max(0, images.length - 1));
    setCurrentIndex(nextIndex);
  }, [open, initialIndex, images.length]);

  useEffect(() => {
    if (!open) return;
    if (!images.length) return;
    const safeIndex = clamp(currentIndex, 0, images.length - 1);
    if (safeIndex !== currentIndex) {
      setCurrentIndex(safeIndex);
      return;
    }
    const nextImage = images[safeIndex];
    resetEditorState(nextImage?.preview || nextImage?.fallbackPreview || "");
  }, [currentIndex, images, open]);

  useEffect(() => {
    if (!open || !onIndexChange) return;
    onIndexChange(currentIndex);
  }, [currentIndex, onIndexChange, open]);

  useEffect(() => {
    if (!open) return;
    try {
      localStorage.removeItem(LEGACY_GEMINI_COOKIE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_OPENAI_API_KEY_STORAGE_KEY);
      setGeminiCookies("");
      const savedProvider = localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "gemini";
      const normalizedProvider = savedProvider === "openai-compatible" ? "openai-compatible" : "gemini";
      const rawModel = (localStorage.getItem(AI_MODEL_STORAGE_KEY) || "").trim();
      const modelOptions = getModelOptionsByProvider(normalizedProvider);

      // For openai-compatible, accept any model string the user typed
      let resolvedModel = rawModel;
      if (normalizedProvider === "openai-compatible") {
        resolvedModel = rawModel || OPENAI_DEFAULT_MODEL;
      } else {
        if (normalizedProvider === "gemini" && rawModel.toLowerCase() === "nano-banana") {
          resolvedModel = GEMINI_DEFAULT_MODEL;
        }
        if (!modelOptions.includes(resolvedModel)) {
          resolvedModel = getDefaultModelByProvider(normalizedProvider);
        }
      }

      setAiProvider(normalizedProvider);
      setAiModel(resolvedModel);
      setOpenaiApiKey("");
      setOpenaiBaseUrl(localStorage.getItem(OPENAI_BASE_URL_STORAGE_KEY) || "");
    } catch {
      setGeminiCookies("");
      setAiProvider("gemini");
      setAiModel(GEMINI_DEFAULT_MODEL);
      setOpenaiApiKey("");
      setOpenaiBaseUrl("");
    }
  }, [open]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // Ctrl+Z = undo
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (!isBusy && imageHistory.length > 0) handleUndo();
        return;
      }

      // ArrowRight = next page
      if (e.key === "ArrowRight" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (!isBusy && currentIndex < images.length - 1) {
          setCurrentIndex((prev) => Math.min(images.length - 1, prev + 1));
        }
        return;
      }

      // ArrowLeft = prev page
      if (e.key === "ArrowLeft" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (!isBusy && currentIndex > 0) {
          setCurrentIndex((prev) => Math.max(0, prev - 1));
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, isBusy, imageHistory.length, currentIndex, images.length]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setOcrEnabled(false);
    imageEditorApi
      .getFonts()
      .then((payload) => {
        if (!active) return;
        setOcrEnabled(payload?.ocr_enabled === true);
        const nextFonts = Array.isArray(payload?.fonts)
          ? payload.fonts
              .map((row: any) => String(row?.name || "").trim())
              .filter(Boolean)
          : [];
        if (nextFonts.length > 0) {
          setFontOptions(Array.from(new Set(nextFonts)));
          if (!nextFonts.includes(textFontName)) {
            setTextFontName(nextFonts[0]);
          }
        }
      })
      .catch(() => {
        // Keep local fallback list.
      });

    return () => {
      active = false;
    };
  }, [open]);

  const updateGeminiCookies = (value: string) => {
    setGeminiCookies(value);
  };

  const updateAiProvider = (value: "gemini" | "openai-compatible") => {
    setAiProvider(value);
    const modelOptions = getModelOptionsByProvider(value);
    const nextModel = modelOptions.includes(aiModel)
      ? aiModel
      : getDefaultModelByProvider(value);
    setAiModel(nextModel);
    try {
      localStorage.setItem(AI_PROVIDER_STORAGE_KEY, value);
      localStorage.setItem(AI_MODEL_STORAGE_KEY, nextModel);
    } catch {
      // Ignore localStorage write errors.
    }
  };

  const updateAiModel = (value: string) => {
    setAiModel(value);
    try {
      localStorage.setItem(AI_MODEL_STORAGE_KEY, value);
    } catch {
      // Ignore localStorage write errors.
    }
  };

  const updateOpenaiApiKey = (value: string) => {
    setOpenaiApiKey(value);
  };

  const updateOpenaiBaseUrl = (value: string) => {
    setOpenaiBaseUrl(value);
    try {
      localStorage.setItem(OPENAI_BASE_URL_STORAGE_KEY, value);
    } catch {
      // Ignore localStorage write errors.
    }
  };

  useEffect(() => {
    if (!open) return;

    const handleResize = () => {
      if (!imageRef.current) return;
      const rect = imageRef.current.getBoundingClientRect();
      setDisplaySize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [open, workingImageUrl]);

  useEffect(() => {
    if (!open) return;
    const canvas = brushCanvasRef.current;
    if (!canvas) return;
    const nextWidth = Math.max(1, Math.round(displaySize.width));
    const nextHeight = Math.max(1, Math.round(displaySize.height));
    if (canvas.width === nextWidth && canvas.height === nextHeight) return;

    canvas.width = nextWidth;
    canvas.height = nextHeight;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    setHasBrushMask(false);
    setIsBrushPainting(false);
    brushLastPointRef.current = null;
  }, [displaySize.height, displaySize.width, open, workingImageUrl]);

  const toNaturalPoint = (clientX: number, clientY: number) => {
    if (!imageRef.current) return null;
    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = ((clientX - rect.left) * naturalSize.width) / rect.width;
    const y = ((clientY - rect.top) * naturalSize.height) / rect.height;

    return {
      x: clamp(Math.round(x), 0, naturalSize.width - 1),
      y: clamp(Math.round(y), 0, naturalSize.height - 1),
    };
  };

  const toDisplayPoint = (clientX: number, clientY: number) => {
    if (!imageRef.current) return null;
    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = ((clientX - rect.left) * displaySize.width) / rect.width;
    const y = ((clientY - rect.top) * displaySize.height) / rect.height;

    return {
      x: clamp(Math.round(x), 0, Math.max(0, displaySize.width - 1)),
      y: clamp(Math.round(y), 0, Math.max(0, displaySize.height - 1)),
    };
  };

  const drawBrushStroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = brushCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.save();
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = "rgba(255,255,255,1)";
    context.fillStyle = "rgba(255,255,255,1)";
    context.lineWidth = Math.max(2, brushRadius * 2);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.arc(to.x, to.y, Math.max(1, brushRadius), 0, Math.PI * 2);
    context.fill();
    context.restore();
    setHasBrushMask(true);
  };

  const clearBrushMask = () => {
    const canvas = brushCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    setHasBrushMask(false);
    setIsBrushPainting(false);
    brushLastPointRef.current = null;
  };

  const startDrawing = (clientX: number, clientY: number) => {
    if (tool === "brush") {
      const point = toDisplayPoint(clientX, clientY);
      if (!point) return;
      setIsBrushPainting(true);
      brushLastPointRef.current = point;
      drawBrushStroke(point, point);
      return;
    }

    const point = toNaturalPoint(clientX, clientY);
    if (!point) return;

    // Both mask and text tools use drag-to-create-box
    setPointerStart(point);
    setDraftRegion({
      id: uid(),
      x: point.x,
      y: point.y,
      w: 1,
      h: 1,
    });
  };

  const updateDrawing = (clientX: number, clientY: number) => {
    if (tool === "brush") {
      if (!isBrushPainting) return;
      const point = toDisplayPoint(clientX, clientY);
      if (!point) return;
      const last = brushLastPointRef.current || point;
      drawBrushStroke(last, point);
      brushLastPointRef.current = point;
      return;
    }

    if (tool !== "mask" && tool !== "text" && tool !== "translate") return;
    if (!pointerStart) return;

    const point = toNaturalPoint(clientX, clientY);
    if (!point) return;

    const x = Math.min(pointerStart.x, point.x);
    const y = Math.min(pointerStart.y, point.y);
    const w = Math.max(1, Math.abs(point.x - pointerStart.x));
    const h = Math.max(1, Math.abs(point.y - pointerStart.y));

    setDraftRegion((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        x,
        y,
        w,
        h,
      };
    });
  };

  const finishDrawing = () => {
    if (tool === "brush") {
      setIsBrushPainting(false);
      brushLastPointRef.current = null;
      return;
    }

    if (tool !== "mask" && tool !== "text" && tool !== "translate") return;
    setPointerStart(null);
    setDraftRegion((prev) => {
      if (!prev) return null;
      if (prev.w < 6 || prev.h < 6) return null;
      if (tool === "translate") {
        // Save region for OCR
        setTranslateRegion({ ...prev });
        setOcrResult(null);
        setTranslatedText("");
        return null;
      }
      if (tool === "text") {
        // For text tool, create an overlay with the drawn box
        const text = String(textValue || "").trim();
        if (!text) {
          toast.error("Nhập nội dung chữ trước khi kéo vùng");
          return null;
        }
        const overlay: EditorOverlay = {
          id: prev.id,
          text,
          x: prev.x,
          y: prev.y,
          w: prev.w,
          h: prev.h,
          fontName: textFontName,
          fontSize: clamp(textFontSize, 12, 140),
          color: textColor,
          align: textAlign,
        };
        setOverlays((existing) => [...existing, overlay]);
      } else {
        setRegions((existing) => [...existing, prev]);
      }
      return null;
    });
  };

  const clearRegions = () => setRegions([]);
  const clearOverlays = () => setOverlays([]);

  // addTextOverlay is now handled by drag-to-create in finishDrawing

  const getWorkingFile = async () => {
    const sources = uniqueImageSources(workingImageUrl, currentImage?.fallbackPreview);
    if (sources.length > 1) {
      let lastError: unknown = null;
      for (const source of sources) {
        try {
          const response = await fetch(source);
          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
          }
          const blob = await response.blob();
          const fileName = normalizeDataUrlName(currentImage?.name || "page", currentIndex);
          if (source !== workingImageUrl && currentImage?.preview === workingImageUrl) {
            setWorkingImageUrl(source);
          }
          return new File([blob], fileName, { type: blob.type || "image/png" });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Khong doc duoc anh hien tai");
    }

    if (!workingImageUrl) {
      throw new Error("Chưa có ảnh để chỉnh sửa");
    }
    const response = await fetch(workingImageUrl);
    if (!response.ok) {
      throw new Error("Không đọc được ảnh hiện tại");
    }
    const blob = await response.blob();
    const fileName = normalizeDataUrlName(currentImage?.name || "page", currentIndex);
    return new File([blob], fileName, { type: blob.type || "image/png" });
  };

  const runAction = async (label: string, action: () => Promise<void>) => {
    if (isBusy) return;
    setIsBusy(true);
    setBusyLabel(label);
    onBusyChange?.(true, label);
    try {
      await action();
    } catch (error: any) {
      toast.error(error?.message || `${label} thất bại`);
    } finally {
      setIsBusy(false);
      setBusyLabel("");
      onBusyChange?.(false, "");
    }
  };

  const setEditedImageUrl = async (nextUrl: string) => {
    setWorkingImageUrl(nextUrl);
    if (autoApplyChanges) {
      await onApply(currentIndex, nextUrl);
    }
  };

  const applyInpaintRegion = () =>
    runAction("Xóa raw vùng chọn", async () => {
      if (regions.length === 0) {
        throw new Error("Cần vẽ ít nhất 1 vùng để xóa raw");
      }
      const file = await getWorkingFile();
      const payload = await imageEditorApi.inpaint(file, {
        mode: "region",
        regions: regions.map((region) => ({
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
        })),
      });
      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      setRegions([]);
      clearBrushMask();
      toast.success("Đã xóa raw vùng chọn");
    });

  const applyInpaintBrush = () =>
    runAction("Xóa raw theo nét tô", async () => {
      if (!hasBrushMask) {
        throw new Error("Hãy tô vùng cần xóa raw trước khi xử lý");
      }

      const canvas = brushCanvasRef.current;
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
        throw new Error("Không khởi tạo được brush mask");
      }

      const file = await getWorkingFile();
      const payload = await imageEditorApi.inpaint(file, {
        mode: "brush",
        brushMask: canvas.toDataURL("image/png"),
        brushRadius,
        maskWidth: canvas.width,
        maskHeight: canvas.height,
      });

      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      clearBrushMask();
      setRegions([]);

      const maskedPixels = Number(payload?.masked_pixels || 0);
      if (maskedPixels > 0) {
        toast.success(`Đã xóa raw theo nét tô (${maskedPixels.toLocaleString()} px)`);
      } else {
        toast.success("Đã xóa raw theo nét tô");
      }
    });

  const applyInpaintAll = () =>
    runAction("Xóa raw toàn ảnh", async () => {
      if (!ocrEnabled) throw new Error("OCR và xóa chữ tự động đang tạm khóa.");
      const file = await getWorkingFile();
      const payload = await imageEditorApi.inpaint(file, { mode: "all" });
      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      clearBrushMask();
      const detected = Number(payload?.detected || 0);
      const maskCoverage = Number(payload?.mask_coverage || 0);
      if (detected > 0) {
        toast.success(`Đã xóa raw toàn ảnh (${detected} vùng)`);
      } else {
        toast.success("Đã xử lý xóa raw toàn ảnh");
      }

      if (Number.isFinite(maskCoverage) && maskCoverage >= 0.12) {
        const coveragePercent = Math.round(maskCoverage * 100);
        toast.warning(`Auto mode đã tác động khoảng ${coveragePercent}% ảnh. Nếu còn bệt, dùng công cụ Tô để xóa chính xác hơn.`);
      }
    });

  const applyAddText = () =>
    runAction("Chèn chữ", async () => {
      if (overlays.length === 0) {
        throw new Error("Cần thêm ít nhất 1 khung chữ");
      }
      const file = await getWorkingFile();
      const payload = await imageEditorApi.addText(
        file,
        overlays.map((overlay) => ({
          x: overlay.x,
          y: overlay.y,
          w: overlay.w,
          h: overlay.h,
          text: overlay.text,
          font_name: overlay.fontName,
          font_size: overlay.fontSize,
          color: overlay.color,
          align: overlay.align,
        })),
      );
      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      setOverlays([]);
      toast.success("Đã chèn chữ lên ảnh");
    });

  // ── Translate tool actions ──
  const applyOcrRegion = () =>
    runAction("OCR nhận diện chữ", async () => {
      if (!ocrEnabled) throw new Error("OCR đang tạm khóa.");
      if (!translateRegion) {
        throw new Error("Hãy chọn tool Dịch rồi kéo 1 vùng chứa chữ trên ảnh");
      }
      const file = await getWorkingFile();
      const payload = await imageEditorApi.ocrRegion(
        file,
        { x: translateRegion.x, y: translateRegion.y, w: translateRegion.w, h: translateRegion.h },
      );
      setOcrResult(payload);
      const langLabel: Record<string, string> = { ja: "Nhật", ko: "Hàn", zh: "Trung", en: "Anh", vi: "Việt" };
      const detectedName = langLabel[payload.detected_language] || payload.detected_language || "?";
      toast.success(`Phát hiện ${payload.detections_count} dòng chữ (${detectedName})${payload.gpu_used ? " • GPU" : ""}`);
    });

  const applyTranslateText = () =>
    runAction("Dịch văn bản", async () => {
      if (!ocrResult?.text) {
        throw new Error("Chưa có text OCR để dịch. Hãy chạy OCR trước.");
      }
      const payload = await imageEditorApi.translateText(
        ocrResult.text,
        ocrResult.detected_language || "ja",
        translateTargetLang,
      );
      setTranslatedText(payload.translated_text);
      setTranslateModel(payload.model || "");
      setShowTranslatePopup(true);
      toast.success(`Đã dịch thành công`);
    });

  const applyDetectFont = () =>
    runAction("Nhận diện font", async () => {
      const targetRegion = regions[0];
      if (!targetRegion) {
        throw new Error("Vui lòng vẽ ít nhất 1 vùng để nhận diện font");
      }
      const file = await getWorkingFile();
      const payload = await imageEditorApi.detectFont(
        file,
        {
          x: targetRegion.x,
          y: targetRegion.y,
          w: targetRegion.w,
          h: targetRegion.h,
        },
        textValue,
      );

      const nextFont = String(payload?.font_name || "").trim();
      const confidence = Number(payload?.confidence || 0);
      if (nextFont) {
        setTextFontName(nextFont);
      }
      setDetectedFontHint(
        nextFont
          ? `Gợi ý font: ${nextFont} (${Math.round(confidence * 100)}%)`
          : "Không nhận diện được font",
      );
      toast.success(nextFont ? `Đã nhận diện font: ${nextFont}` : "Không nhận diện được font");
    });

  const applyAiTranslate = () =>
    runAction("AI xóa chữ + dịch", async () => {
      const cookiesRaw = geminiCookies.trim();
      const apiKeyRaw = openaiApiKey.trim();
      const modelRaw = aiModel.trim();
      const baseUrlRaw = openaiBaseUrl.trim();
      const userPrompt = aiUserPrompt.trim();

      if (aiProvider === "gemini" && !cookiesRaw) {
        throw new Error("Vui lòng dán cookie Gemini trước khi chạy AI");
      }
      if (aiProvider === "openai-compatible" && !apiKeyRaw) {
        throw new Error("Vui lòng nhập API key cho provider chuẩn OpenAI");
      }

      const file = await getWorkingFile();
      const payload = await imageEditorApi.aiTranslate(file, {
        targetLanguage: "vi",
        fontName: textFontName,
        geminiCookies: aiProvider === "gemini" ? cookiesRaw : "",
        aiProvider,
        aiModel: modelRaw,
        aiApiKey: aiProvider === "openai-compatible" ? apiKeyRaw : "",
        aiBaseUrl: aiProvider === "openai-compatible" ? baseUrlRaw : "",
        userPrompt: aiProvider === "gemini" ? userPrompt : "",
        regions: regions.map((region) => ({
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
        })),
      });

      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      setCompareImageUrl(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      setShowCompare(true);
      setRegions([]);
      setOverlays([]);
      clearBrushMask();
      const provider = String(payload?.provider || "").trim().toLowerCase();
      if (provider === "gemini") {
        toast.success("Gemini đã xóa chữ cũ và thay bằng bản dịch mới");
      } else if (provider === "openai-compatible") {
        toast.success("Provider chuẩn OpenAI đã xóa chữ cũ và thay bằng bản dịch mới");
      } else {
        toast.success("Đã xử lý AI dịch ảnh");
      }
    });

  const applyAiRemoveOnly = () =>
    runAction("AI chỉ xóa raw", async () => {
      const cookiesRaw = geminiCookies.trim();
      const apiKeyRaw = openaiApiKey.trim();
      const modelRaw = aiModel.trim();
      const baseUrlRaw = openaiBaseUrl.trim();

      if (aiProvider === "gemini" && !cookiesRaw) {
        throw new Error("Vui lòng dán cookie Gemini trước khi chạy AI");
      }
      if (aiProvider === "openai-compatible" && !apiKeyRaw) {
        throw new Error("Vui lòng nhập API key cho provider chuẩn OpenAI");
      }

      const file = await getWorkingFile();
      const payload = await imageEditorApi.aiRemoveOnly(file, {
        geminiCookies: aiProvider === "gemini" ? cookiesRaw : "",
        aiProvider,
        aiModel: modelRaw,
        aiApiKey: aiProvider === "openai-compatible" ? apiKeyRaw : "",
        aiBaseUrl: aiProvider === "openai-compatible" ? baseUrlRaw : "",
        regions: regions.map((region) => ({
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
        })),
      });

      const nextUrl = String(payload?.image_data_url || "").trim();
      if (!nextUrl) throw new Error("Không nhận được ảnh kết quả");
      pushHistory(workingImageUrl);
      setCompareImageUrl(workingImageUrl);
      await setEditedImageUrl(nextUrl);
      setShowCompare(true);
      setRegions([]);
      clearBrushMask();
      toast.success("AI đã xóa chữ khỏi ảnh");
    });

  const handleApplyToUpload = async () => {
    if (!workingImageUrl) return;
    await onApply(currentIndex, workingImageUrl);
    toast.success("Đã áp dụng ảnh chỉnh sửa vào danh sách upload");
  };

  if (!open) return null;

  const isModal = variant === "modal";
  const rootClassName = isModal
    ? "fixed inset-0 z-[130] bg-black/70 backdrop-blur-sm p-2 sm:p-4"
    : "h-full min-h-[720px]";
  const shellClassName = isModal
    ? "mx-auto h-full max-w-7xl rounded-2xl border border-border bg-card shadow-2xl overflow-hidden"
    : "h-full w-full rounded-2xl border border-border bg-card shadow-lg overflow-hidden";

  return (
    <div className={rootClassName} onClick={isModal ? onClose : undefined}>
      <div
        className={shellClassName}
        onClick={isModal ? (event) => event.stopPropagation() : undefined}
      >
        <div className="h-full grid grid-cols-1 lg:grid-cols-[340px_1fr]">
          <div className="border-r border-border p-4 overflow-y-auto space-y-3 bg-secondary/15">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-primary" /> {title}
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 p-1.5 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4" />
                {!isModal && <span className="text-[11px] font-semibold">{closeLabel}</span>}
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground">Trang hiện tại</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={currentIndex <= 0 || isBusy}
                  onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
                  className="px-2 py-1 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  Trước
                </button>
                <span className="text-xs font-semibold text-muted-foreground">
                  {images.length ? `${currentIndex + 1}/${images.length}` : "0/0"}
                </span>
                <button
                  type="button"
                  disabled={currentIndex >= images.length - 1 || isBusy}
                  onClick={() => setCurrentIndex((prev) => Math.min(images.length - 1, prev + 1))}
                  className="px-2 py-1 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  Sau
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground">Công cụ</label>
              <div className="grid grid-cols-5 gap-1.5">
                <button
                  type="button"
                  onClick={() => setTool("mask")}
                  className={`px-2 py-1.5 rounded-md text-xs font-semibold ${
                    tool === "mask" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5 inline mr-1" /> Mask
                </button>
                <button
                  type="button"
                  onClick={() => setTool("brush")}
                  className={`px-2 py-1.5 rounded-md text-xs font-semibold ${
                    tool === "brush" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5 inline mr-1" /> Tô
                </button>
                <button
                  type="button"
                  onClick={() => setTool("text")}
                  className={`px-2 py-1.5 rounded-md text-xs font-semibold ${
                    tool === "text" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Type className="w-3.5 h-3.5 inline mr-1" /> Text
                </button>
                <button
                  type="button"
                  onClick={() => { setTool("translate"); setTranslateRegion(null); setOcrResult(null); setTranslatedText(""); }}
                  disabled={!ocrEnabled}
                  title={ocrEnabled ? "Nhận diện và dịch chữ" : "OCR đang tạm khóa"}
                  className={`px-2 py-1.5 rounded-md text-xs font-semibold disabled:opacity-40 ${
                    tool === "translate" ? "bg-violet-600 text-white" : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Languages className="w-3.5 h-3.5 inline mr-1" /> Dịch
                </button>
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={isBusy || imageHistory.length === 0}
                  className="px-2 py-1.5 rounded-md text-xs font-semibold bg-orange-600/80 text-white disabled:opacity-30"
                  title={`Quay lại (${imageHistory.length})`}
                >
                  <Undo2 className="w-3.5 h-3.5 inline mr-1" /> Quay lại
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground">Vùng raw ({regions.length})</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={applyInpaintRegion}
                  disabled={isBusy || regions.length === 0}
                  className="flex-1 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50"
                >
                  Xóa vùng chọn
                </button>
                <button
                  type="button"
                  onClick={clearRegions}
                  disabled={isBusy || regions.length === 0}
                  className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="rounded-md border border-border bg-secondary/20 p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-muted-foreground">
                    Tô xóa raw {hasBrushMask ? "(đã có nét tô)" : "(chưa tô)"}
                  </label>
                  <span className="text-[11px] font-semibold text-primary">{brushRadius}px</span>
                </div>

                <input
                  type="range"
                  min={4}
                  max={42}
                  value={brushRadius}
                  onChange={(event) => setBrushRadius(Number(event.target.value || 14))}
                  className="w-full"
                />

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={applyInpaintBrush}
                    disabled={isBusy || !hasBrushMask}
                    className="flex-1 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50"
                  >
                    Xóa theo nét tô
                  </button>
                  <button
                    type="button"
                    onClick={clearBrushMask}
                    disabled={isBusy || !hasBrushMask}
                    className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={applyInpaintAll}
                disabled={isBusy || !ocrEnabled}
                title={ocrEnabled ? "Xóa raw toàn ảnh" : "OCR đang tạm khóa"}
                className="w-full px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
              >
                {ocrEnabled ? "Xóa raw toàn ảnh" : "Xóa tự động · Tạm khóa"}
              </button>
            </div>

            <div className="space-y-2 border border-border rounded-lg p-2.5 bg-card">
              <label className="text-[11px] font-semibold text-muted-foreground">Thêm chữ</label>
              <textarea
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                rows={2}
                placeholder="Nhập nội dung cần chèn"
                className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
              />

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={textFontName}
                  onChange={(event) => setTextFontName(event.target.value)}
                  className="bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                >
                  {fontOptions.map((font) => (
                    <option key={font} value={font}>{font}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={12}
                  max={140}
                  value={textFontSize}
                  onChange={(event) => setTextFontSize(Number(event.target.value || 34))}
                  className="bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="color"
                  value={textColor}
                  onChange={(event) => setTextColor(event.target.value)}
                  className="h-[30px] w-full bg-secondary border border-border rounded-md px-1"
                />
                <select
                  value={textAlign}
                  onChange={(event) => setTextAlign(event.target.value as "left" | "center" | "right")}
                  className="bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                >
                  <option value="left">Canh trái</option>
                  <option value="center">Canh giữa</option>
                  <option value="right">Canh phải</option>
                </select>
              </div>

              {detectedFontHint && (
                <p className="text-[11px] text-primary font-medium">{detectedFontHint}</p>
              )}

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Chọn tool Text rồi kéo vùng trên ảnh để tạo box chữ. Nhập nội dung trước khi kéo.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={applyDetectFont}
                  disabled={isBusy || regions.length === 0}
                  className="flex-1 px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  <ScanSearch className="w-3.5 h-3.5 inline mr-1" /> Nhận diện font
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={applyAddText}
                  disabled={isBusy || overlays.length === 0}
                  className="flex-1 px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  Chèn chữ lên ảnh ({overlays.length})
                </button>
                <button
                  type="button"
                  onClick={clearOverlays}
                  disabled={isBusy || overlays.length === 0}
                  className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-semibold disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* ── Translate Tool Section ── */}
            {tool === "translate" && (
              <div className="space-y-2.5 border-2 border-violet-500/40 rounded-lg p-3 bg-violet-500/5">
                <div className="flex items-center gap-2">
                  <Languages className="w-4 h-4 text-violet-400" />
                  <label className="text-xs font-bold text-violet-300">Dịch manga</label>
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  <strong>1.</strong> Kéo vùng chứa chữ → <strong>2.</strong> OCR tự nhận diện ngôn ngữ → <strong>3.</strong> Dịch tự động
                </p>

                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-muted-foreground">Dịch sang</label>
                  <select
                    value={translateTargetLang}
                    onChange={(e) => setTranslateTargetLang(e.target.value)}
                    className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                  >
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">Tiếng Anh</option>
                    <option value="ja">Tiếng Nhật</option>
                    <option value="ko">Tiếng Hàn</option>
                    <option value="zh">Tiếng Trung</option>
                  </select>
                </div>

                {/* Region indicator */}
                {translateRegion ? (
                  <div className="flex items-center gap-2 rounded-md bg-violet-500/10 border border-violet-500/30 px-2.5 py-1.5">
                    <Check className="w-3.5 h-3.5 text-violet-400" />
                    <span className="text-[11px] font-semibold text-violet-300">
                      Đã chọn vùng ({translateRegion.w}×{translateRegion.h}px)
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-1.5">
                    <ScanSearch className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-[11px] font-semibold text-yellow-300">
                      Kéo chuột trên ảnh để chọn vùng chứa chữ
                    </span>
                  </div>
                )}

                {/* Step 2: OCR */}
                <button
                  type="button"
                  onClick={applyOcrRegion}
                  disabled={isBusy || !translateRegion || !ocrEnabled}
                  className="w-full px-3 py-2 rounded-lg bg-violet-600 text-white text-xs font-bold disabled:opacity-40 hover:bg-violet-500 transition-colors"
                >
                  <ScanSearch className="w-3.5 h-3.5 inline mr-1.5" />
                  OCR nhận diện chữ
                </button>

                {/* OCR Result */}
                {ocrResult && (
                  <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-emerald-400">
                        ✓ {ocrResult.lines.length} dòng • {({ja:"Nhật",ko:"Hàn",zh:"Trung",en:"Anh",vi:"Việt",th:"Thái"} as Record<string,string>)[ocrResult.detected_language || ""] || "?"} • {Math.round((ocrResult.avg_confidence ?? 0) * 100)}% {ocrResult.gpu_used ? "• GPU" : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(ocrResult.text); toast.success("Đã copy text gốc"); }}
                        className="p-1 rounded hover:bg-secondary transition-colors"
                        title="Copy text gốc"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </button>
                    </div>
                    <div className="max-h-[100px] overflow-y-auto rounded bg-black/20 p-2">
                      <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono">{ocrResult.text}</pre>
                    </div>
                    {ocrResult.lines.map((line, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-mono bg-secondary px-1 rounded">{Math.round(line.confidence * 100)}%</span>
                        <span className="truncate">{line.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Step 3: Translate */}
                {ocrResult && (
                  <button
                    type="button"
                    onClick={applyTranslateText}
                    disabled={isBusy}
                    className="w-full px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-40 hover:bg-emerald-500 transition-colors"
                  >
                    <ArrowRight className="w-3.5 h-3.5 inline mr-1.5" />
                    Dịch sang {translateTargetLang === "vi" ? "Tiếng Việt" : translateTargetLang.toUpperCase()}
                  </button>
                )}

                {/* Translation Result — compact indicator in sidebar */}
                {translatedText && (
                  <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-[11px] font-semibold text-emerald-300 truncate flex-1">Đã dịch xong</span>
                    <button
                      type="button"
                      onClick={() => setShowTranslatePopup(true)}
                      className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold hover:bg-emerald-500 transition-colors shrink-0"
                    >
                      Xem
                    </button>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(translatedText); toast.success("Đã copy bản dịch"); }}
                      className="p-1 rounded hover:bg-secondary transition-colors shrink-0"
                      title="Copy"
                    >
                      <Copy className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2 border border-border rounded-lg p-2.5 bg-card">
              <label className="text-[11px] font-semibold text-muted-foreground">AI provider</label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateAiProvider("gemini")}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-semibold transition-colors ${
                    aiProvider === "gemini"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" /> Gemini
                </button>

                <button
                  type="button"
                  onClick={() => updateAiProvider("openai-compatible")}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-semibold transition-colors ${
                    aiProvider === "openai-compatible"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Bot className="w-3.5 h-3.5" /> AI API
                </button>
              </div>

              {aiProvider === "openai-compatible" && (
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-muted-foreground">Model</label>
                  <input
                    type="text"
                    value={aiModel}
                    onChange={(event) => updateAiModel(event.target.value)}
                    placeholder="gpt-image-1, dall-e-3, flux-pro, ..."
                    className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Nhập tên model bất kỳ mà provider hỗ trợ (ví dụ: gpt-image-1, dall-e-3, gemini-2.0-flash-exp, flux-pro...)
                  </p>
                </div>
              )}

              {aiProvider === "gemini" ? (
                <>
                  <label className="text-[11px] font-semibold text-muted-foreground">
                    Cookie Gemini (__Secure-1PSID)
                  </label>
                  <textarea
                    value={geminiCookies}
                    onChange={(event) => updateGeminiCookies(event.target.value)}
                    rows={3}
                    placeholder="Dán cookie header hoặc JSON cookie export"
                    className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 resize-y"
                  />
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-muted-foreground">
                      Yêu cầu dịch thêm <span className="font-normal">(tùy chọn)</span>
                    </label>
                    <textarea
                      value={aiUserPrompt}
                      onChange={(event) => setAiUserPrompt(event.target.value)}
                      rows={4}
                      maxLength={2000}
                      placeholder="Ví dụ: Minh là nam, An là nữ; Minh xưng anh - em với An. Dịch tự nhiên, gần gũi."
                      className="w-full resize-y rounded-md border border-border bg-secondary px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <p className="text-right text-[10px] text-muted-foreground">{aiUserPrompt.length}/2000</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Cần tối thiểu __Secure-1PSID. Nếu có __Secure-1PSIDTS thì dán cùng để ổn định hơn.
                  </p>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-muted-foreground">API key</label>
                    <input
                      type="password"
                      value={openaiApiKey}
                      onChange={(event) => updateOpenaiApiKey(event.target.value)}
                      placeholder="Nhập API key"
                      className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-muted-foreground">Base URL (tuỳ chọn)</label>
                    <input
                      type="text"
                      value={openaiBaseUrl}
                      onChange={(event) => updateOpenaiBaseUrl(event.target.value)}
                      placeholder="https://api.openai.com/v1 hoặc endpoint tương thích"
                      className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs"
                    />
                  </div>

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Tương thích với OpenAI, Together.ai, Fireworks, Groq, Replicate, Azure OpenAI, v.v.
                    Nhập Base URL của provider và API key của bạn.
                  </p>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyAiRemoveOnly}
                disabled={isBusy || (aiProvider === "gemini" ? !geminiCookies.trim() : !openaiApiKey.trim())}
                className="flex-1 px-3 py-2 rounded-lg bg-orange-600 text-white text-xs font-bold disabled:opacity-50"
              >
                <Eraser className="w-3.5 h-3.5 inline mr-1" />
                AI chỉ xóa raw
              </button>
              <button
                type="button"
                onClick={applyAiTranslate}
                disabled={isBusy || (aiProvider === "gemini" ? !geminiCookies.trim() : !openaiApiKey.trim())}
                className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 inline mr-1" />
                Xóa + Dịch
              </button>
            </div>

            <button
              type="button"
              onClick={handleApplyToUpload}
              disabled={isBusy || !workingImageUrl}
              className="w-full px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5 inline mr-1" /> Áp dụng ảnh đã chỉnh
            </button>

            {isBusy && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {busyLabel || "Đang xử lý..."}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Phím tắt: ← → chuyển trang, Ctrl+Z quay lại. Mask kéo khung xóa, Tô vẽ vùng xóa, Text kéo vùng chèn chữ.
              {ocrEnabled ? " Dịch chọn vùng → OCR → dịch." : " OCR đang tạm khóa."}
            </p>
          </div>

          <div className="relative bg-background p-2 sm:p-4 overflow-auto">
            {compareImageUrl && showCompare && workingImageUrl ? (
              <div className="flex flex-col items-center gap-2 h-full">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-muted-foreground">So sánh trước / sau</span>
                  <button
                    type="button"
                    onClick={() => setShowCompare(false)}
                    className="px-2.5 py-1 rounded-md bg-secondary text-xs font-semibold hover:bg-secondary/80 transition-colors"
                  >
                    Đóng so sánh
                  </button>
                </div>
                <div className="flex gap-3 flex-1 overflow-auto w-full justify-center items-start">
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1 max-w-[50%]">
                    <span className="text-[11px] font-bold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded">Ảnh gốc</span>
                    <img
                      src={compareImageUrl}
                      alt="Ảnh gốc"
                      className="max-w-full max-h-[78vh] object-contain rounded-lg border border-orange-400/40 select-none"
                      draggable={false}
                    />
                  </div>
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1 max-w-[50%]">
                    <span className="text-[11px] font-bold text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Ảnh đã dịch</span>
                    <img
                      src={workingImageUrl}
                      alt="Ảnh đã dịch"
                      className="max-w-full max-h-[78vh] object-contain rounded-lg border border-emerald-400/40 select-none"
                      draggable={false}
                    />
                  </div>
                </div>
              </div>
            ) : workingImageUrl ? (
              <div className="relative mx-auto w-fit">
                {compareImageUrl && (
                  <button
                    type="button"
                    onClick={() => setShowCompare(true)}
                    className="absolute top-2 right-2 z-10 px-2.5 py-1.5 rounded-md bg-black/60 text-white text-[11px] font-semibold hover:bg-black/80 backdrop-blur-sm transition-colors"
                  >
                    So sánh trước/sau
                  </button>
                )}
                <img
                  ref={imageRef}
                  src={workingImageUrl}
                  alt={currentImage?.name || "Editor preview"}
                  className="max-w-full max-h-[82vh] object-contain rounded-lg border border-border select-none"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    setNaturalSize({
                      width: Math.max(1, image.naturalWidth),
                      height: Math.max(1, image.naturalHeight),
                    });
                    const rect = image.getBoundingClientRect();
                    setDisplaySize({
                      width: Math.max(1, Math.round(rect.width)),
                      height: Math.max(1, Math.round(rect.height)),
                    });
                  }}
                  onError={() => {
                    const fallback = currentImage?.fallbackPreview;
                    if (fallback && workingImageUrl !== fallback && currentImage?.preview === workingImageUrl) {
                      setWorkingImageUrl(fallback);
                    }
                  }}
                  draggable={false}
                />

                <div
                  className={`absolute inset-0 ${tool === "text" ? "cursor-copy" : tool === "translate" ? "cursor-cell" : "cursor-crosshair"}`}
                  onMouseDown={(event) => startDrawing(event.clientX, event.clientY)}
                  onMouseMove={(event) => updateDrawing(event.clientX, event.clientY)}
                  onMouseUp={finishDrawing}
                  onMouseLeave={finishDrawing}
                >
                  <canvas
                    ref={brushCanvasRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      opacity: 0.36,
                      mixBlendMode: "screen",
                    }}
                  />

                  {allRegions.map((region, index) => {
                    const left = region.x * scaleX;
                    const top = region.y * scaleY;
                    const width = region.w * scaleX;
                    const height = region.h * scaleY;
                    return (
                      <div
                        key={region.id}
                        className="absolute border-2 border-yellow-400 bg-yellow-400/10"
                        style={{ left, top, width, height }}
                      >
                        <span className="absolute -top-5 left-0 text-[10px] px-1.5 py-0.5 rounded bg-yellow-400 text-black font-bold">
                          {index + 1}
                        </span>
                      </div>
                    );
                  })}

                  {overlays.map((overlay, index) => {
                    const left = overlay.x * scaleX;
                    const top = overlay.y * scaleY;
                    const width = overlay.w * scaleX;
                    const height = overlay.h * scaleY;
                    return (
                      <div
                        key={overlay.id}
                        className="absolute border-2 border-emerald-400 bg-emerald-400/10"
                        style={{ left, top, width, height }}
                      >
                        <span className="absolute -top-5 left-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500 text-white font-bold">
                          T{index + 1}
                        </span>
                      </div>
                    );
                  })}

                  {/* Translate region indicator */}
                  {translateRegion && tool === "translate" && (() => {
                    const left = translateRegion.x * scaleX;
                    const top = translateRegion.y * scaleY;
                    const width = translateRegion.w * scaleX;
                    const height = translateRegion.h * scaleY;
                    return (
                      <div
                        className="absolute border-2 border-violet-400 bg-violet-400/15 border-dashed"
                        style={{ left, top, width, height }}
                      >
                        <span className="absolute -top-5 left-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-500 text-white font-bold">
                          OCR
                        </span>
                      </div>
                    );
                  })()}

                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                Chưa có ảnh để chỉnh sửa
              </div>
            )}

            {/* ── Translation Popup (glassmorphism overlay) ── */}
            {showTranslatePopup && translatedText && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center p-4"
                onClick={() => setShowTranslatePopup(false)}
              >
                {/* Backdrop */}
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm rounded-lg" />

                {/* Popup card */}
                <div
                  className="relative w-full max-w-lg rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
                  style={{
                    background: "linear-gradient(135deg, rgba(30,27,46,0.95) 0%, rgba(20,20,35,0.97) 100%)",
                    boxShadow: "0 0 40px rgba(139,92,246,0.15), 0 0 80px rgba(16,185,129,0.08)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Gradient accent bar */}
                  <div className="h-1 w-full bg-gradient-to-r from-violet-500 via-emerald-400 to-violet-500" />

                  {/* Header */}
                  <div className="flex items-center justify-between px-5 pt-4 pb-2">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-emerald-500 flex items-center justify-center shadow-lg">
                        <Languages className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white">Kết quả dịch</h4>
                        <p className="text-[10px] text-white/40 font-medium">{translateModel ? translateModel.split("/").pop()?.replace(":free", "") : "AI"} • OpenRouter</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowTranslatePopup(false)}
                      className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
                    >
                      <X className="w-4 h-4 text-white/60" />
                    </button>
                  </div>

                  {/* Content */}
                  <div className="px-5 pb-5 space-y-3">
                    {/* Original text */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-violet-400 uppercase tracking-wider">Gốc</span>
                        <button
                          type="button"
                          onClick={() => { navigator.clipboard.writeText(ocrResult?.text || ""); toast.success("Đã copy text gốc"); }}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
                        >
                          <Copy className="w-2.5 h-2.5" /> Copy
                        </button>
                      </div>
                      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 max-h-[120px] overflow-y-auto">
                        <pre className="text-xs text-white/60 whitespace-pre-wrap break-words font-mono leading-relaxed">{ocrResult?.text || ""}</pre>
                      </div>
                    </div>

                    {/* Arrow divider */}
                    <div className="flex items-center gap-3 px-2">
                      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500/20 to-emerald-500/20 border border-white/10 flex items-center justify-center">
                        <ArrowRight className="w-3 h-3 text-emerald-400" />
                      </div>
                      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    </div>

                    {/* Translated text */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Bản dịch</span>
                        <button
                          type="button"
                          onClick={() => { navigator.clipboard.writeText(translatedText); toast.success("Đã copy bản dịch"); }}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
                        >
                          <Copy className="w-2.5 h-2.5" /> Copy
                        </button>
                      </div>
                      <div
                        className="rounded-xl p-3 max-h-[160px] overflow-y-auto border"
                        style={{
                          background: "linear-gradient(135deg, rgba(16,185,129,0.06) 0%, rgba(139,92,246,0.04) 100%)",
                          borderColor: "rgba(16,185,129,0.15)",
                        }}
                      >
                        <pre className="text-sm text-emerald-100 whitespace-pre-wrap break-words leading-relaxed font-sans">{translatedText}</pre>
                      </div>
                    </div>

                    {/* Footer actions */}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(translatedText); toast.success("Đã copy bản dịch"); }}
                        className="flex-1 px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-xs font-bold hover:from-emerald-500 hover:to-emerald-400 transition-all shadow-lg shadow-emerald-500/20"
                      >
                        <Copy className="w-3.5 h-3.5 inline mr-1.5" />
                        Copy bản dịch
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTranslatePopup(false)}
                        className="px-4 py-2 rounded-xl bg-white/5 text-white/70 text-xs font-semibold hover:bg-white/10 transition-colors border border-white/[0.06]"
                      >
                        Đóng
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditorModal;
