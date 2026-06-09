import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light';
export type AccentColor = 'red' | 'purple' | 'blue' | 'orange' | 'pink' | 'green';

interface ThemeStore {
  mode: ThemeMode;
  accent: AccentColor;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
}

const STORAGE_KEY = 'manga-theme';

function loadTheme(): { mode: ThemeMode; accent: AccentColor } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      mode: saved.mode || 'dark',
      accent: saved.accent || 'red',
    };
  } catch {
    return { mode: 'dark', accent: 'red' };
  }
}

function saveTheme(mode: ThemeMode, accent: AccentColor) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, accent }));
}

function applyMode(mode: ThemeMode) {
  const el = document.documentElement;
  if (mode === 'dark') {
    el.classList.add('dark');
  } else {
    el.classList.remove('dark');
  }
}

// Accent color HSL values for --primary
const ACCENT_HSL: Record<AccentColor, string> = {
  red: '0 72% 51%',
  purple: '265 50% 55%',
  blue: '210 60% 50%',
  orange: '20 85% 55%',
  pink: '340 60% 55%',
  green: '155 55% 42%',
};

function applyAccent(accent: AccentColor) {
  const hsl = ACCENT_HSL[accent];
  document.documentElement.style.setProperty('--primary', hsl);
  document.documentElement.style.setProperty('--ring', hsl);
  document.documentElement.style.setProperty('--sidebar-primary', hsl);
  document.documentElement.style.setProperty('--sidebar-ring', hsl);
}

const initial = loadTheme();

export const useThemeStore = create<ThemeStore>((set) => ({
  mode: initial.mode,
  accent: initial.accent,
  setMode: (mode) => {
    applyMode(mode);
    set((s) => {
      saveTheme(mode, s.accent);
      return { mode };
    });
  },
  setAccent: (accent) => {
    applyAccent(accent);
    set((s) => {
      saveTheme(s.mode, accent);
      return { accent };
    });
  },
}));

// Apply initial theme on load
applyMode(initial.mode);
applyAccent(initial.accent);
