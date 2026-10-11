/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `vite` / `vite build`          → real API at VITE_API_BASE (proxied in dev).
 * `vite build --mode demo`       → GitHub Pages demo (ADR-020): base path of the repo,
 *                                  VITE_DEMO=1 selects the in-browser DemoApi.
 *
 * HTTPS in dev: the brief requires a secure context (camera, geolocation, service worker).
 * Behind the Docker proxy the app is already served over TLS. To run Vite itself on HTTPS,
 * create a certificate with mkcert (see infra/) and set `server.https` to its key/cert files.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDemo = mode === 'demo' || env.VITE_DEMO === '1';
  return {
    base: mode === 'demo' ? '/nuzli-project-management/' : '/',
    plugins: [react()],
    define: isDemo ? { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {},
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
