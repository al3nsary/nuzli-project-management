/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * `vite` / `vite build`          → real API at VITE_API_BASE (proxied in dev).
 * `vite build --mode demo`       → GitHub Pages demo (ADR-020): base path of the repo,
 *                                  VITE_DEMO=1 selects the in-browser DemoApi.
 *
 * HTTPS in dev: the brief requires a secure context (camera, geolocation, service worker).
 * Behind the Docker proxy the app is already served over TLS. To run Vite itself on HTTPS,
 * create a certificate with mkcert (see infra/) and set `server.https` to its key/cert files.
 *
 * PWA (ADR-071): vite-plugin-pwa in injectManifest mode with our own service worker
 * (src/sw/sw.ts): precache of the app shell, self-hosted fonts and icons; no API caching.
 * Works under `/` and under the demo base path, since the manifest scope and start URL follow
 * `base`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDemo = mode === 'demo' || env.VITE_DEMO === '1';
  const isTest = Boolean(process.env.VITEST);
  const plugins: PluginOption[] = [react()];
  if (!isTest) {
    plugins.push(
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src/sw',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'نزلي — إدارة المشاريع والفرق الميدانية',
          short_name: 'نزلي',
          description: 'نظام المشاريع والفرق الميدانية والمخالفات وكروت العمل.',
          lang: 'ar',
          dir: 'rtl',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#14232B',
          background_color: '#EEF1F1',
          categories: ['business', 'productivity'],
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2}'],
          // Only the Arabic and basic Latin font subsets are needed offline.
          globIgnores: ['**/*cyrillic*', '**/*greek*', '**/*vietnamese*', '**/*-ext-*'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    );
  }
  return {
    base: mode === 'demo' ? '/nuzli-project-management/' : '/',
    plugins,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      ...(isDemo ? { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {}),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: true },
      },
    },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      testTimeout: 15000,
    },
  };
});
