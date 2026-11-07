import { Monitor, Moon, Sun } from 'lucide-react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'system' | 'light' | 'dark';

/** Theme choices shared by the header menu, command palette and settings page. */
export const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const satisfies readonly { value: Theme; label: string; icon: typeof Sun }[];

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  setTheme: (theme: Theme) => void;
  setSidebarOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

// Preferences persist; transient panels do not. The key is also read by the inline
// script in index.html so the theme is right before the first paint.
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarOpen: typeof window === 'undefined' || window.innerWidth >= 768,
      paletteOpen: false,
      setTheme: (theme) => set({ theme }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    {
      name: 'stillnote-ui',
      partialize: ({ theme }) => ({ theme }),
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
