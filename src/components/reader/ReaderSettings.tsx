import { motion } from 'framer-motion';
import { useReaderStore, PageDirection, ImageFit } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ReadingMode } from '@/types/manga';
import {
  AlignVerticalSpaceAround, Columns, Smartphone, Sun, ZoomIn, ZoomOut,
  RotateCcw, Play, Pause, Eye, EyeOff, ArrowLeftRight, Maximize2,
  Image as ImageIcon, GripVertical, BookOpen, Frame, Search,
  RefreshCw, Settings2, ArrowRight, ArrowLeft
} from 'lucide-react';

const ReaderSettings = () => {
  const store = useReaderStore();
  const updateReaderSettings = useSettingsStore(s => s.updateReader);

  const handleModeChange = (mode: ReadingMode) => {
    updateReaderSettings({ readingMode: mode });
  };

  const handleDirectionChange = (direction: PageDirection) => {
    updateReaderSettings({ pageDirection: direction });
  };

  const handleImageFitChange = (fit: ImageFit) => {
    updateReaderSettings({ imageFit: fit });
  };

  const modes: { value: ReadingMode; icon: typeof Columns; label: string }[] = [
    { value: 'vertical', icon: AlignVerticalSpaceAround, label: 'Cuộn dọc' },
    { value: 'horizontal', icon: Columns, label: 'Lật trang' },
    { value: 'webtoon', icon: Smartphone, label: 'Webtoon' },
  ];

  const directions: { value: PageDirection; label: string; icon: typeof ArrowRight }[] = [
    { value: 'ltr', label: 'Trái → Phải', icon: ArrowRight },
    { value: 'rtl', label: 'Phải → Trái', icon: ArrowLeft },
  ];

  const fits: { value: ImageFit; icon: typeof Maximize2; label: string }[] = [
    { value: 'width', icon: ArrowLeftRight, label: 'Vừa chiều ngang' },
    { value: 'height', icon: Maximize2, label: 'Vừa chiều cao' },
    { value: 'original', icon: ImageIcon, label: 'Kích thước gốc' },
  ];

  const Btn = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
        active ? 'bg-primary text-primary-foreground shadow-md' : 'bg-secondary/50 text-muted-foreground hover:text-foreground border border-border/30'
      }`}
    >
      {children}
    </button>
  );

  const SectionLabel = ({ icon: Icon, children }: { icon: typeof BookOpen; children: React.ReactNode }) => (
    <p className="text-xs text-muted-foreground mb-2 font-bold flex items-center gap-1.5">
      <Icon className="w-3.5 h-3.5" /> {children}
    </p>
  );

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden border-t border-border"
    >
      <div className="container mx-auto px-4 py-4 space-y-4 max-h-[60vh] overflow-y-auto scrollbar-hide">
        {/* Reading mode */}
        <div>
          <SectionLabel icon={BookOpen}>Chế độ đọc</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {modes.map(m => (
              <Btn key={m.value} active={store.mode === m.value} onClick={() => handleModeChange(m.value)}>
                <m.icon className="w-3.5 h-3.5" /> {m.label}
              </Btn>
            ))}
          </div>
        </div>

        {/* Page direction (horizontal only) */}
        {store.mode === 'horizontal' && (
          <div>
            <SectionLabel icon={ArrowLeftRight}>Hướng trang</SectionLabel>
            <div className="flex gap-1.5">
              {directions.map(d => (
                <Btn key={d.value} active={store.pageDirection === d.value} onClick={() => handleDirectionChange(d.value)}>
                  <d.icon className="w-3.5 h-3.5" /> {d.label}
                </Btn>
              ))}
            </div>
          </div>
        )}

        {/* Image fit */}
        <div>
          <SectionLabel icon={Frame}>Hiển thị ảnh</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {fits.map(f => (
              <Btn key={f.value} active={store.imageFit === f.value} onClick={() => handleImageFitChange(f.value)}>
                <f.icon className="w-3.5 h-3.5" /> {f.label}
              </Btn>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Zoom */}
          <div>
            <SectionLabel icon={Search}>Thu phóng: {store.zoom}%</SectionLabel>
            <div className="flex items-center gap-2">
              <button onClick={() => store.setZoom(store.zoom - 10)} className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"><ZoomOut className="w-3.5 h-3.5" /></button>
              <input type="range" min={50} max={200} value={store.zoom} onChange={e => store.setZoom(Number(e.target.value))} className="flex-1 accent-primary h-1" />
              <button onClick={() => store.setZoom(store.zoom + 10)} className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"><ZoomIn className="w-3.5 h-3.5" /></button>
              <button onClick={() => store.setZoom(100)} className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"><RotateCcw className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          {/* Brightness */}
          <div>
            <SectionLabel icon={Sun}>Độ sáng: {store.brightness}%</SectionLabel>
            <input type="range" min={30} max={100} value={store.brightness} onChange={e => store.setBrightness(Number(e.target.value))} className="w-full accent-primary h-1" />
          </div>
        </div>

        {/* Page gap (vertical/webtoon) */}
        {store.mode !== 'horizontal' && (
          <div>
            <SectionLabel icon={GripVertical}>Khoảng cách trang: {store.pageGap}px</SectionLabel>
            <input type="range" min={0} max={32} value={store.pageGap} onChange={e => store.setPageGap(Number(e.target.value))} className="w-full accent-primary h-1" />
          </div>
        )}

        {/* Auto scroll */}
        {store.mode !== 'horizontal' && (
          <div>
            <SectionLabel icon={RefreshCw}>Tự cuộn</SectionLabel>
            <div className="flex items-center gap-3">
              <button
                onClick={() => store.setAutoScroll(!store.autoScroll)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  store.autoScroll
                    ? 'bg-destructive text-destructive-foreground shadow-md'
                    : 'bg-primary text-primary-foreground shadow-md'
                }`}
              >
                {store.autoScroll ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {store.autoScroll ? 'Dừng' : 'Bật'}
              </button>
              {store.autoScroll && (
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[10px] text-muted-foreground">Chậm</span>
                  <input type="range" min={1} max={8} value={store.autoScrollSpeed} onChange={e => store.setAutoScrollSpeed(Number(e.target.value))} className="flex-1 accent-primary h-1" />
                  <span className="text-[10px] text-muted-foreground">Nhanh</span>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </motion.div>
  );
};

export default ReaderSettings;
