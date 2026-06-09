import { create } from 'zustand';

export interface TranslationStudioImage {
  id: string;
  file: File | null;
  preview: string;
  name: string;
  size: number;
}

interface TranslationStudioState {
  sessionId: string;
  sourcePath: string;
  images: TranslationStudioImage[];
  initialIndex: number;
  updatedAt: number;
  startSession: (
    images: TranslationStudioImage[],
    initialIndex?: number,
    sourcePath?: string,
  ) => string;
  updateImageAt: (index: number, image: TranslationStudioImage) => void;
  clearSession: () => void;
}

const cloneImages = (images: TranslationStudioImage[]): TranslationStudioImage[] =>
  images.map((item) => ({
    id: String(item.id || ''),
    file: item.file || null,
    preview: String(item.preview || ''),
    name: String(item.name || ''),
    size: Number(item.size || 0),
  }));

const createSessionId = (): string =>
  `studio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const useTranslationStudioStore = create<TranslationStudioState>((set) => ({
  sessionId: '',
  sourcePath: '/upload/new',
  images: [],
  initialIndex: 0,
  updatedAt: 0,

  startSession: (images, initialIndex = 0, sourcePath = '/upload/new') => {
    const sessionId = createSessionId();
    const nextImages = cloneImages(images);

    set(() => ({
      sessionId,
      sourcePath,
      images: nextImages,
      initialIndex: Math.max(0, Math.min(initialIndex, Math.max(0, nextImages.length - 1))),
      updatedAt: Date.now(),
    }));

    return sessionId;
  },

  updateImageAt: (index, image) => {
    set((state) => {
      if (index < 0 || index >= state.images.length) return state;
      const nextImages = [...state.images];
      nextImages[index] = {
        id: String(image.id || nextImages[index].id),
        file: image.file || null,
        preview: String(image.preview || nextImages[index].preview || ''),
        name: String(image.name || nextImages[index].name || ''),
        size: Number(image.size || 0),
      };

      return {
        images: nextImages,
        updatedAt: Date.now(),
      };
    });
  },

  clearSession: () =>
    set(() => ({
      sessionId: '',
      sourcePath: '/upload/new',
      images: [],
      initialIndex: 0,
      updatedAt: Date.now(),
    })),
}));
