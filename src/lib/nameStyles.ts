import React from 'react';

const FONT_CLASS_MAP: Record<string, string> = {
  default: 'font-sans',
  serif: 'font-serif',
  mono: 'font-mono',
  cursive: 'italic',
  fantasy: 'tracking-widest uppercase',
  rounded: 'tracking-wide',
  bold: 'font-black',
  thin: 'font-light tracking-wider',
  condensed: 'tracking-tighter font-bold',
  wide: 'tracking-[0.3em]',
  uppercase: 'uppercase font-semibold',
  lowercase: 'lowercase',
  capitalize: 'capitalize',
  smallcaps: 'text-xs uppercase tracking-widest font-bold',
  heavy: 'font-black text-lg',
  elegant: 'font-serif italic tracking-wide',
  tech: 'font-mono uppercase tracking-wider font-bold',
  handwrite: 'italic font-light',
  gothic: 'font-black uppercase tracking-tight',
  'retro-font': 'font-bold italic tracking-wide',
  pixel: 'font-mono text-sm tracking-widest',
  newspaper: 'font-serif font-bold uppercase',
  whisper: 'font-extralight text-sm tracking-[0.2em]',
  military: 'font-bold uppercase tracking-[0.15em]',
  'manga-style': 'font-black italic',
  minimal: 'font-thin tracking-[0.25em] uppercase',
  typewriter: 'font-mono font-medium',
  display: 'font-extrabold text-lg tracking-tight',
  sketch: 'font-light italic tracking-wider',
  royal: 'font-serif font-semibold tracking-wide',
  cinematic: 'font-serif font-black uppercase tracking-[0.08em]',
  luxe: 'font-serif italic font-semibold tracking-[0.06em]',
  stencil: 'font-black uppercase tracking-[0.2em]',
  hacker: 'font-mono text-[0.92rem] uppercase tracking-[0.08em]',
  titan: 'font-black text-xl uppercase tracking-tight',
  airy: 'font-light italic tracking-[0.18em]',
  'comic-pop': 'font-extrabold tracking-[0.06em] uppercase',
  bookish: 'font-serif tracking-[0.01em]',
  razor: 'font-semibold tracking-[-0.02em]',
  rune: 'font-serif font-bold uppercase tracking-[0.12em]',
  zen: 'font-light lowercase tracking-[0.12em]',
  noble: 'font-serif font-bold tracking-[0.05em]',
};

export type NameStyleAccessUser = {
  role?: string | null;
  isVip?: boolean | null;
  is_vip?: boolean | null;
};

export const PREMIUM_NAME_STYLE_ROLES = new Set(['admin', 'moderator']);

export const FREE_NAME_COLORS = new Set([
  '',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#94a3b8',
]);

export const PREMIUM_NAME_COLORS = new Set([
  '#e62e2e',
  '#dc2626',
  '#f87171',
  '#e11d48',
  '#fb923c',
  '#facc15',
  '#eab308',
  '#fbbf24',
  '#4ade80',
  '#84cc16',
  '#22c55e',
  '#16a34a',
  '#0ea5e9',
  '#06b6d4',
  '#14b8a6',
  '#2563eb',
  '#60a5fa',
  '#a855f7',
  '#7c3aed',
  '#c084fc',
  '#d946ef',
  '#f472b6',
  '#ffffff',
  '#1e293b',
  '#78716c',
  '#b45309',
]);

export const FREE_NAME_FONTS = new Set([
  'default',
  'serif',
  'mono',
  'cursive',
  'rounded',
  'bold',
  'uppercase',
  'lowercase',
  'capitalize',
]);

export const ALL_NAME_FONTS = new Set(Object.keys(FONT_CLASS_MAP));
export const PREMIUM_NAME_FONTS = new Set(
  Object.keys(FONT_CLASS_MAP).filter((fontId) => !FREE_NAME_FONTS.has(fontId)),
);

const ALL_NAME_EFFECT_IDS = [
  'none',
  'glow',
  'shadow',
  'gradient',
  'underline',
  'italic',
  'retro',
  'outline',
  'double-shadow',
  'emboss',
  'wave-underline',
  'strikethrough',
  'frost',
  'metallic',
  'blood',
  'gold',
  'silver',
  'copper',
  'electric',
  'sunset',
  'ocean',
  'toxic',
  'hologram',
  'galaxy',
  'cherry',
  'matrix',
  'prism',
  'rose-gold',
  'midnight',
  'mint-glow',
  'comic-shadow',
  'crystal',
  'ember',
  'starlight',
  'neon-glow',
  'fire-text',
  'rainbow',
  'glitch',
  'blur-glow',
  'color-cycle',
  'flicker',
  'glow-pulse',
  'rainbow-shift',
  'aurora',
  'lava',
  'ice-shimmer',
  'neon-pulse',
  'galaxy-shift',
  'prism-flow',
  'cyber-scan',
  'comet-trail',
  'storm-flicker',
  'blossom-breeze',
];

export const ALL_NAME_EFFECTS = new Set(ALL_NAME_EFFECT_IDS);
export const PREMIUM_NAME_EFFECTS = new Set(
  ALL_NAME_EFFECT_IDS.filter((effectId) => effectId !== 'none'),
);

export const NAME_VIP_BADGE_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/45 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-amber-700 shadow-sm shadow-amber-500/10 dark:bg-amber-950/70 dark:text-amber-200';

export const NAME_VIP_BADGE_ICON_CLASS = 'h-3 w-3 shrink-0 text-amber-500 dark:text-amber-300';

export function hasPremiumNameStyleAccess(user?: NameStyleAccessUser | null): boolean {
  const role = String(user?.role || '').trim().toLowerCase();
  return Boolean(user?.isVip || user?.is_vip || PREMIUM_NAME_STYLE_ROLES.has(role));
}

export function isPremiumNameColor(color?: string): boolean {
  const normalized = String(color || '').trim().toLowerCase();
  return PREMIUM_NAME_COLORS.has(normalized);
}

export function isPremiumNameFont(fontId?: string): boolean {
  const normalized = fontId || 'default';
  return PREMIUM_NAME_FONTS.has(normalized);
}

export function isPremiumNameEffect(effectId?: string): boolean {
  const normalized = effectId || 'none';
  return PREMIUM_NAME_EFFECTS.has(normalized);
}

export function normalizeNameColorForAccess(color: string | undefined, user?: NameStyleAccessUser | null): string {
  const normalized = String(color || '').trim().toLowerCase();
  if (!normalized) return '';
  if (isPremiumNameColor(normalized) && !hasPremiumNameStyleAccess(user)) return '';
  return normalized;
}

export function normalizeNameFontForAccess(fontId: string | undefined, user?: NameStyleAccessUser | null): string {
  const normalized = fontId || 'default';
  if (!ALL_NAME_FONTS.has(normalized)) return 'default';
  if (isPremiumNameFont(normalized) && !hasPremiumNameStyleAccess(user)) return 'default';
  return normalized;
}

export function normalizeNameEffectForAccess(effectId: string | undefined, user?: NameStyleAccessUser | null): string {
  const normalized = effectId || 'none';
  if (!ALL_NAME_EFFECTS.has(normalized)) return 'none';
  if (isPremiumNameEffect(normalized) && !hasPremiumNameStyleAccess(user)) return 'none';
  return normalized;
}

export function getNameFontClass(fontId?: string): string {
  return FONT_CLASS_MAP[fontId || 'default'] || '';
}

export function getNameEffectStyle(effectId?: string, color?: string): React.CSSProperties {
  const c = color || 'hsl(var(--primary))';
  switch (effectId) {
    case 'glow': return { textShadow: `0 0 10px ${c}, 0 0 20px ${c}` };
    case 'shadow': return { textShadow: '2px 2px 4px rgba(0,0,0,0.5)' };
    case 'italic': return { fontStyle: 'italic' };
    case 'neon-glow': return { textShadow: `0 0 7px ${c}, 0 0 10px ${c}, 0 0 21px ${c}, 0 0 42px ${c}` };
    case 'fire-text': return { textShadow: '0 -2px 4px #ff3, 0 -4px 10px #f93, 0 -8px 20px #f31' };
    case 'retro': return { textShadow: '3px 3px 0 rgba(0,0,0,0.2)', letterSpacing: '0.05em' };
    case 'outline': return { WebkitTextStroke: '1px currentColor', color: 'transparent' } as React.CSSProperties;
    case 'rainbow': return { backgroundImage: 'linear-gradient(90deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #8b5cf6, #ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundSize: '200% auto' } as React.CSSProperties;
    case 'glitch': return { textShadow: `2px 0 ${c}, -2px 0 #0ff, 0 2px #f0f`, letterSpacing: '0.05em' };
    case 'metallic': return { backgroundImage: 'linear-gradient(180deg, #d4d4d8 0%, #a1a1aa 40%, #e4e4e7 50%, #a1a1aa 60%, #d4d4d8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'frost': return { textShadow: '0 0 5px #bae6fd, 0 0 10px #7dd3fc, 0 0 15px #38bdf8', color: '#0ea5e9' };
    case 'blood': return { textShadow: '0 2px 4px #991b1b, 0 4px 8px #7f1d1d', color: '#dc2626' };
    case 'double-shadow': return { textShadow: '2px 2px 0 rgba(0,0,0,0.3), -2px -2px 0 rgba(255,255,255,0.1)' };
    case 'emboss': return { textShadow: '1px 1px 0 rgba(255,255,255,0.3), -1px -1px 0 rgba(0,0,0,0.3)' };
    case 'blur-glow': return { textShadow: `0 0 15px ${c}, 0 0 30px ${c}, 0 0 45px ${c}`, filter: 'brightness(1.2)' } as React.CSSProperties;
    case 'gold': return { backgroundImage: 'linear-gradient(180deg, #fbbf24 0%, #d97706 40%, #fde68a 50%, #d97706 60%, #fbbf24 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'silver': return { backgroundImage: 'linear-gradient(180deg, #e5e7eb 0%, #9ca3af 40%, #f3f4f6 50%, #9ca3af 60%, #e5e7eb 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'copper': return { backgroundImage: 'linear-gradient(180deg, #f59e0b 0%, #b45309 40%, #fbbf24 50%, #b45309 60%, #f59e0b 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'electric': return { textShadow: '0 0 5px #38bdf8, 0 0 10px #0ea5e9, 0 0 20px #0284c7', color: '#38bdf8' };
    case 'sunset': return { backgroundImage: 'linear-gradient(90deg, #f97316, #ef4444, #ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'ocean': return { backgroundImage: 'linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'toxic': return { textShadow: '0 0 7px #22c55e, 0 0 15px #16a34a, 0 0 25px #15803d', color: '#4ade80' };
    case 'hologram': return { backgroundImage: 'linear-gradient(135deg, #06b6d4, #8b5cf6, #ec4899, #06b6d4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundSize: '200% auto' } as React.CSSProperties;
    case 'galaxy': return { backgroundImage: 'linear-gradient(135deg, #1e1b4b, #7c3aed, #ec4899, #fbbf24)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'cherry': return { textShadow: '0 0 8px #fda4af, 0 0 15px #fb7185', color: '#f43f5e' };
    case 'matrix': return { textShadow: '0 0 5px #22c55e, 0 0 10px #16a34a', color: '#22c55e', fontFamily: 'monospace' };
    case 'prism': return { backgroundImage: 'linear-gradient(120deg, #60a5fa, #a78bfa, #f472b6, #fbbf24, #34d399)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'rose-gold': return { backgroundImage: 'linear-gradient(180deg, #fda4af 0%, #f97316 38%, #fcd34d 52%, #f97316 68%, #fda4af 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'midnight': return { backgroundImage: 'linear-gradient(90deg, #0f172a, #1d4ed8, #312e81, #0f172a)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'mint-glow': return { color: '#34d399', textShadow: '0 0 8px #34d399, 0 0 16px #10b981, 0 0 26px #059669' };
    case 'comic-shadow': return { textShadow: '2px 2px 0 #111827, 4px 4px 0 rgba(17,24,39,0.55)', letterSpacing: '0.02em' };
    case 'crystal': return { backgroundImage: 'linear-gradient(135deg, #e0f2fe, #7dd3fc, #c4b5fd, #f0abfc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as React.CSSProperties;
    case 'ember': return { color: '#fb923c', textShadow: '0 0 8px #fb923c, 0 0 16px #f97316, 0 0 24px #ea580c' };
    case 'starlight': return { color: '#e2e8f0', textShadow: '0 0 6px #93c5fd, 0 0 14px #c4b5fd, 0 0 24px #f0abfc' };
    default: return {};
  }
}

export function getNameEffectClass(effectId?: string): string {
  switch (effectId) {
    case 'underline': return 'underline decoration-2 underline-offset-4';
    case 'gradient': return 'bg-clip-text text-transparent bg-gradient-to-r from-primary via-accent to-primary';
    case 'wave-underline': return 'underline decoration-wavy decoration-2 underline-offset-4';
    case 'strikethrough': return 'line-through decoration-2';
    case 'color-cycle': return 'name-effect-color-cycle';
    case 'flicker': return 'name-effect-flicker';
    case 'glow-pulse': return 'name-effect-glow-pulse';
    case 'rainbow-shift': return 'name-effect-rainbow-shift';
    case 'aurora': return 'name-effect-aurora';
    case 'lava': return 'name-effect-lava';
    case 'ice-shimmer': return 'name-effect-ice-shimmer';
    case 'neon-pulse': return 'name-effect-neon-pulse';
    case 'galaxy-shift': return 'name-effect-galaxy-shift';
    case 'prism-flow': return 'name-effect-prism-flow';
    case 'cyber-scan': return 'name-effect-cyber-scan';
    case 'comet-trail': return 'name-effect-comet-trail';
    case 'storm-flicker': return 'name-effect-storm-flicker';
    case 'blossom-breeze': return 'name-effect-blossom-breeze';
    default: return '';
  }
}
