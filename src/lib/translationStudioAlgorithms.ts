export type StudioAlgorithmPreset = 'clarity-pro' | 'ink-clean' | 'print-binary';

export interface StudioPresetOption {
  id: StudioAlgorithmPreset;
  label: string;
  description: string;
}

export interface StudioImageMetrics {
  contrastScore: number;
  noiseScore: number;
  textDensity: number;
  readabilityScore: number;
  recommendations: string[];
}

export const STUDIO_PRESET_OPTIONS: StudioPresetOption[] = [
  {
    id: 'clarity-pro',
    label: 'Clarity Pro',
    description: 'Tăng dynamic range + sharpen nhẹ cho trang cần rõ nét bong bóng.',
  },
  {
    id: 'ink-clean',
    label: 'Ink Clean',
    description: 'Lọc nhiễu hạt + giữ nét mực, hợp với ảnh chụp có nhiễu cao.',
  },
  {
    id: 'print-binary',
    label: 'Print Binary',
    description: 'Nhị phân hóa đen trắng để tối ưu OCR và in ấn.',
  },
];

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Không mở được ảnh đầu vào cho studio algorithm'));
    if (!String(src || '').startsWith('data:')) {
      image.crossOrigin = 'anonymous';
    }
    image.src = src;
  });

const createImageDataContext = async (src: string): Promise<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
}> => {
  const image = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.naturalWidth || image.width || 1);
  canvas.height = Math.max(1, image.naturalHeight || image.height || 1);

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Không khởi tạo được canvas context');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  return { canvas, context, imageData };
};

const luminance = (r: number, g: number, b: number): number => (0.299 * r) + (0.587 * g) + (0.114 * b);

const percentileFromHistogram = (histogram: number[], percentile: number, total: number): number => {
  const target = Math.max(0, Math.min(total, Math.round(total * percentile)));
  let accum = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    accum += histogram[i] || 0;
    if (accum >= target) return i;
  }
  return 255;
};

const applyContrastStretch = (pixels: Uint8ClampedArray) => {
  const histogram = new Array<number>(256).fill(0);
  let total = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const l = Math.max(0, Math.min(255, Math.round(luminance(pixels[i], pixels[i + 1], pixels[i + 2]))));
    histogram[l] += 1;
    total += 1;
  }

  const low = percentileFromHistogram(histogram, 0.02, total);
  const high = percentileFromHistogram(histogram, 0.98, total);
  const range = Math.max(1, high - low);

  for (let i = 0; i < pixels.length; i += 4) {
    const r = clamp01((pixels[i] - low) / range);
    const g = clamp01((pixels[i + 1] - low) / range);
    const b = clamp01((pixels[i + 2] - low) / range);

    // Slight gamma compression for manga panels to keep ink edges stable.
    pixels[i] = clampByte((Math.pow(r, 0.92) * 255));
    pixels[i + 1] = clampByte((Math.pow(g, 0.92) * 255));
    pixels[i + 2] = clampByte((Math.pow(b, 0.92) * 255));
  }
};

const applySharpen = (pixels: Uint8ClampedArray, width: number, height: number, amount: number) => {
  if (width < 3 || height < 3) return;
  const source = new Uint8ClampedArray(pixels);

  const indexOf = (x: number, y: number) => ((y * width) + x) * 4;

  for (let y = 1; y < (height - 1); y += 1) {
    for (let x = 1; x < (width - 1); x += 1) {
      const center = indexOf(x, y);
      const left = indexOf(x - 1, y);
      const right = indexOf(x + 1, y);
      const top = indexOf(x, y - 1);
      const bottom = indexOf(x, y + 1);

      for (let c = 0; c < 3; c += 1) {
        const value = source[center + c];
        const laplace = (5 * value) - source[left + c] - source[right + c] - source[top + c] - source[bottom + c];
        pixels[center + c] = clampByte((value * (1 - amount)) + (laplace * amount));
      }
    }
  }
};

const applyMedianDenoise = (pixels: Uint8ClampedArray, width: number, height: number) => {
  if (width < 3 || height < 3) return;
  const source = new Uint8ClampedArray(pixels);
  const indexOf = (x: number, y: number) => ((y * width) + x) * 4;

  for (let y = 1; y < (height - 1); y += 1) {
    for (let x = 1; x < (width - 1); x += 1) {
      const neighbors: number[] = [];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const idx = indexOf(x + dx, y + dy);
          neighbors.push(luminance(source[idx], source[idx + 1], source[idx + 2]));
        }
      }
      neighbors.sort((a, b) => a - b);
      const median = neighbors[4];
      const idx = indexOf(x, y);
      // Blend to avoid overly flat panels.
      const base = 0.45;
      const denoise = 0.55;
      pixels[idx] = clampByte((source[idx] * base) + (median * denoise));
      pixels[idx + 1] = clampByte((source[idx + 1] * base) + (median * denoise));
      pixels[idx + 2] = clampByte((source[idx + 2] * base) + (median * denoise));
    }
  }
};

const otsuThreshold = (pixels: Uint8ClampedArray): number => {
  const histogram = new Array<number>(256).fill(0);
  let total = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const gray = Math.max(0, Math.min(255, Math.round(luminance(pixels[i], pixels[i + 1], pixels[i + 2]))));
    histogram[gray] += 1;
    total += 1;
  }

  let sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let bestVariance = -1;
  let threshold = 128;

  for (let i = 0; i < 256; i += 1) {
    weightBackground += histogram[i];
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground <= 0) break;

    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;

    const variance = weightBackground * weightForeground * Math.pow(meanBackground - meanForeground, 2);
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = i;
    }
  }

  return threshold;
};

const applyBinary = (pixels: Uint8ClampedArray, threshold: number) => {
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    const next = gray >= threshold ? 255 : 0;
    pixels[i] = next;
    pixels[i + 1] = next;
    pixels[i + 2] = next;
  }
};

export const runTranslationAlgorithmPreset = async (
  sourceImageUrl: string,
  preset: StudioAlgorithmPreset,
): Promise<string> => {
  const { canvas, context, imageData } = await createImageDataContext(sourceImageUrl);
  const pixels = imageData.data;

  if (preset === 'clarity-pro') {
    applyContrastStretch(pixels);
    applySharpen(pixels, imageData.width, imageData.height, 0.34);
  } else if (preset === 'ink-clean') {
    applyMedianDenoise(pixels, imageData.width, imageData.height);
    applyContrastStretch(pixels);
    applySharpen(pixels, imageData.width, imageData.height, 0.22);
  } else {
    applyContrastStretch(pixels);
    applySharpen(pixels, imageData.width, imageData.height, 0.18);
    const threshold = otsuThreshold(pixels);
    applyBinary(pixels, threshold);
  }

  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
};

export const analyzeTranslationImage = async (sourceImageUrl: string): Promise<StudioImageMetrics> => {
  const { imageData } = await createImageDataContext(sourceImageUrl);
  const pixels = imageData.data;

  let mean = 0;
  let darkPixels = 0;
  const grayValues: number[] = [];

  for (let i = 0; i < pixels.length; i += 4) {
    const gray = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    grayValues.push(gray);
    mean += gray;
    if (gray < 95) darkPixels += 1;
  }

  const count = Math.max(1, grayValues.length);
  mean /= count;

  let varianceSum = 0;
  for (let i = 0; i < grayValues.length; i += 1) {
    const diff = grayValues[i] - mean;
    varianceSum += diff * diff;
  }
  const stdDev = Math.sqrt(varianceSum / count);

  const width = imageData.width;
  const height = imageData.height;
  const idx = (x: number, y: number) => (y * width) + x;

  let edgeEnergy = 0;
  let edgeCount = 0;

  for (let y = 0; y < (height - 1); y += 1) {
    for (let x = 0; x < (width - 1); x += 1) {
      const center = grayValues[idx(x, y)];
      const right = grayValues[idx(x + 1, y)];
      const bottom = grayValues[idx(x, y + 1)];
      edgeEnergy += Math.abs(center - right);
      edgeEnergy += Math.abs(center - bottom);
      edgeCount += 2;
    }
  }

  const contrastScore = clamp01(stdDev / 72);
  const noiseScore = clamp01((edgeEnergy / Math.max(1, edgeCount)) / 42);
  const textDensity = clamp01(darkPixels / count);

  const densityBalance = 1 - Math.min(1, Math.abs(textDensity - 0.18) / 0.18);
  const readabilityScore = clamp01(
    (contrastScore * 0.55) +
    ((1 - noiseScore) * 0.2) +
    (densityBalance * 0.25),
  );

  const recommendations: string[] = [];
  if (contrastScore < 0.35) recommendations.push('Độ tương phản thấp, nên dùng preset Clarity Pro.');
  if (noiseScore > 0.48) recommendations.push('Ảnh có nhiều hạt, nên dùng preset Ink Clean trước khi dịch AI.');
  if (textDensity > 0.34) recommendations.push('Mật độ mực đậm cao, hãy tách theo vùng để tránh xóa quá tay.');
  if (recommendations.length === 0) {
    recommendations.push('Ảnh đang ở mức ổn, có thể vào thẳng AI remove + translate.');
  }

  return {
    contrastScore,
    noiseScore,
    textDensity,
    readabilityScore,
    recommendations,
  };
};
