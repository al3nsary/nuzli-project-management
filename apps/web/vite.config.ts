/// <reference types="vitest" />
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { copyOcrAssets } from './scripts/copy-ocr-assets.mjs';
import { IOS_SPLASH, splashFile, splashMedia } from './scripts/ios-splash.mjs';

/** A9: self-hosted OCR assets in public/ocr before dev and build (never a CDN, ADR-104). */
function ocrAssets(): PluginOption {
  return {
    name: 'nuzli-ocr-assets',
    buildStart() {
      copyOcrAssets();
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * A12: the build stamp shown in «المزيد» — version (package.json, or NUZLI_APP_VERSION to test an
 * update between two builds), the short git commit and the build time.
 */
function gitSha(): string {
  if (process.env.NUZLI_APP_BUILD) return process.env.NUZLI_APP_BUILD;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'local';
  } catch {
    return 'local';
  }
}
const APP_VERSION = process.env.NUZLI_APP_VERSION || pkg.version;

/**
 * A12: iPhone launch screens and the iOS/Android standalone tags, with the right base path
 * (GitHub Pages serves the demo under /nuzli-project-management/).
 */
function iosTags(base: string): PluginOption {
  return {
    name: 'nuzli-ios-tags',
    transformIndexHtml: () =>
      IOS_SPLASH.map((s) => ({
        tag: 'link',
        attrs: { rel: 'apple-touch-startup-image', media: splashMedia(s), href: base + splashFile(s) },
        injectTo: 'head' as const,
      })),
  };
}

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
  if (!isTest) plugins.push(ocrAssets());
  const base = mode === 'demo' ? '/nuzli-project-management/' : '/';
  if (!isTest) plugins.push(iosTags(base));
  if (!isTest) {
    plugins.push(
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src/sw',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        // The shell's logos are precached so the side, the login and the offline pages keep them.
        includeAssets: [
          'favicon-32.png',
          'favicon-64.png',
          'apple-touch-icon.png',
          'brand/nozoly-light.png',
          'brand/nozoly.png',
        ],
        // A12 (owner: «قابلًا للتحميل على الجوال الآيفون والأندرويد والتثبيت عليهم كتطبيق»): the
        // install sheet of Android/desktop shows the screenshots; the shortcuts open from a long
        // press on the icon. Paths are relative, so they follow `base` (the demo's subpath).
        manifest: {
          id: './',
          name: 'نُزلي',
          short_name: 'نُزلي',
          description: 'نُزلي — إدارة المشاريع والفرق الميدانية والمخالفات وكروت العمل.',
          lang: 'ar',
          dir: 'rtl',
          start_url: './',
          scope: './',
          display: 'standalone',
          display_override: ['standalone', 'minimal-ui'],
          // Phones in portrait, tablets both ways (the Gantt opens best in landscape).
          orientation: 'any',
          theme_color: '#5030e5',
          background_color: '#FFFFFF',
          categories: ['business', 'productivity'],
          prefer_related_applications: false,
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          screenshots: [
            { src: 'screenshots/narrow-home.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'الرئيسية على الجوال: مؤشرات الدور وحالة المشاريع' },
            { src: 'screenshots/narrow-projects.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'المشاريع على الجوال: بطاقات بالغلاف ونسبة الإنجاز' },
            { src: 'screenshots/wide-project.png', sizes: '1440x900', type: 'image/png', form_factor: 'wide', label: 'مخطط جانت للمشروع على الشاشة الواسعة' },
          ],
          shortcuts: [
            { name: 'تسجيل مخالفة', short_name: 'مخالفة', url: './violations/new', icons: [{ src: 'shortcuts/record.png', sizes: '96x96', type: 'image/png' }] },
            { name: 'مهامي', short_name: 'مهامي', url: './my-tasks', icons: [{ src: 'shortcuts/tasks.png', sizes: '96x96', type: 'image/png' }] },
            { name: 'المشاريع', short_name: 'المشاريع', url: './projects', icons: [{ src: 'shortcuts/projects.png', sizes: '96x96', type: 'image/png' }] },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2}'],
          // Only the Arabic and basic Latin font subsets are needed offline.
          // The OCR worker/WASM/language data (~12 MB, demo only) load on demand, never precached.
          globIgnores: ['**/*cyrillic*', '**/*greek*', '**/*vietnamese*', '**/*-ext-*', 'ocr/**'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    );
  }
  return {
    base,
    plugins,
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __APP_BUILD__: JSON.stringify(gitSha()),
      __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
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
