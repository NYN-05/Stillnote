import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'system' | 'light' | 'dark';
export type ViewMode = 'write' | 'split' | 'preview';

interface UiState {
  theme: Theme;
  monospace: boolean;
  viewMode: ViewMode;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  setTheme: (theme: Theme) => void;
  setMonospace: (monospace: boolean) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setSidebarOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

// Preferences persist; transient panels do not. The key is also read by the inline
// script in index.html so the theme is right before the first paint.
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      monospace: false,
      viewMode: 'write',
      sidebarOpen: typeof window === 'undefined' || window.innerWidth >= 768,
      paletteOpen: false,
      setTheme: (theme) => set({ theme }),
      setMonospace: (monospace) => set({ monospace }),
      setViewMode: (viewMode) => set({ viewMode }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    {
      name: 'stillnote-ui',
      partialize: ({ theme, monospace, viewMode }) => ({ theme, monospace, viewMode }),
    },
  ),
);

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#09090b' : '#fafafa');
}
