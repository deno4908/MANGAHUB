import { useCallback, useEffect, useMemo, useState } from "react";
import Cropper, { Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import { ImageIcon, Loader2, RotateCcw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type MaintenanceImageCropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MaintenanceImageEditorModalProps = {
  open: boolean;
  imageSrc: string;
  fileName?: string;
  fileType?: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: (cropArea: MaintenanceImageCropArea) => void;
};

const ASPECT_OPTIONS = [
  { label: "16:9", value: 16 / 9 },
  { label: "4:3", value: 4 / 3 },
  { label: "1:1", value: 1 },
];

const MaintenanceImageEditorModal = ({
  open,
  imageSrc,
  fileName = "",
  fileType = "",
  loading = false,
  onCancel,
  onConfirm,
}: MaintenanceImageEditorModalProps) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(16 / 9);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const isGif = useMemo(
    () => fileType.toLowerCase().includes("gif") || fileName.toLowerCase().endsWith(".gif"),
    [fileName, fileType],
  );

  useEffect(() => {
    if (!open) return;
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setAspect(16 / 9);
    setCroppedAreaPixels(null);
  }, [open, imageSrc]);

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleConfirm = () => {
    if (!croppedAreaPixels) return;
    onConfirm({
      x: Math.round(croppedAreaPixels.x),
      y: Math.round(croppedAreaPixels.y),
      width: Math.round(croppedAreaPixels.width),
      height: Math.round(croppedAreaPixels.height),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !loading) onCancel();
      }}
    >
      <DialogContent className="max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-primary" />
            Chỉnh ảnh bảo trì
          </DialogTitle>
          <DialogDescription>
            Cắt ảnh theo khung hiển thị trước khi upload lên Supabase Storage.
            {isGif ? " GIF sẽ được cắt ở backend để giữ animation." : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="relative h-[360px] overflow-hidden rounded-lg border border-border bg-muted sm:h-[460px]">
            {imageSrc ? (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                minZoom={1}
                maxZoom={4}
                aspect={aspect}
                showGrid
                onCropChange={setCrop}
                onCropComplete={onCropComplete}
                onZoomChange={setZoom}
              />
            ) : null}
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="truncate text-sm font-bold">{fileName || "Ảnh bảo trì"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Chuẩn khuyến nghị: 16:9 cho màn hình bảo trì.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-black uppercase text-muted-foreground">Tỉ lệ khung</p>
              <div className="grid grid-cols-3 gap-2">
                {ASPECT_OPTIONS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    disabled={loading}
                    onClick={() => setAspect(item.value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-black transition-colors ${
                      aspect === item.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-muted-foreground">Zoom</span>
                <span className="font-bold">{zoom.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                disabled={loading}
                className="w-full"
              />
            </div>

            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setCrop({ x: 0, y: 0 });
                setZoom(1);
                setAspect(16 / 9);
              }}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw className="h-4 w-4" />
              Đặt lại
            </button>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={loading}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-bold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={loading || !croppedAreaPixels}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loading ? "Đang upload" : "Cắt & upload"}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MaintenanceImageEditorModal;

