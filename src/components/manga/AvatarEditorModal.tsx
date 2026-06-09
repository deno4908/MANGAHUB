import { useCallback, useState } from 'react';
import Cropper, { Area } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

type AvatarCropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type AvatarEditorModalProps = {
  open: boolean;
  imageSrc: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: (cropArea: AvatarCropArea) => void;
};

const AvatarEditorModal = ({ open, imageSrc, loading = false, onCancel, onConfirm }: AvatarEditorModalProps) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const onCropComplete = useCallback((_croppedArea: Area, croppedAreaPx: Area) => {
    setCroppedAreaPixels(croppedAreaPx);
  }, []);

  const handleConfirm = () => {
    if (!croppedAreaPixels) return;
    onConfirm({
      x: croppedAreaPixels.x,
      y: croppedAreaPixels.y,
      width: croppedAreaPixels.width,
      height: croppedAreaPixels.height,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !loading) onCancel();
      }}
    >
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>Chỉnh ảnh đại diện</DialogTitle>
          <DialogDescription>
            Kéo để canh khung, dùng thanh zoom để phóng to. GIF được giữ animation sau khi cắt.
          </DialogDescription>
        </DialogHeader>

        <div className="p-4 pt-2 space-y-4">
          <div className="relative h-[340px] bg-muted rounded-xl overflow-hidden border">
            {imageSrc ? (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                minZoom={1}
                maxZoom={3}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Zoom</span>
              <span className="font-semibold">{zoom.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-full"
              disabled={loading}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-secondary disabled:opacity-60"
            >
              Huỷ
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading || !croppedAreaPixels}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {loading ? 'Đang upload...' : 'Lưu avatar'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AvatarEditorModal;
