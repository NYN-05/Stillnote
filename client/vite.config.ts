import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Stillnote',
        short_name: 'Stillnote',
        description: 'A quiet, Markdown-first place to write.',
        theme_color: '#7c5cf0',
        background_color: '#0b0b0e',
        display: 'standalone',
        start_url: '/notes',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell is cached. Notes live in IndexedDB; API calls carry cookies and are never cached.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: Number(process.env.DEV_PORT || 5173),
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    port: Number(process.env.PREVIEW_PORT || 4173),
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  build: {
    sourcemap: false,
    // Never inline assets as data: URLs; the Content-Security-Policy (font-src 'self') forbids them.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)) return 'react';
          if (/node_modules\/(@radix-ui|cmdk|sonner|lucide-react|class-variance-authority)\//.test(id)) return 'ui';
          return undefined; // CodeMirror and the Markdown renderer stay in their lazy chunks
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
