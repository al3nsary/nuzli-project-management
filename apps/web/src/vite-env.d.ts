/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** '1' in the GitHub Pages demo build (ADR-020). */
  readonly VITE_DEMO?: string;
  /** Base URL of the REST API, default `/api/v1`. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** apps/web package.json version, injected by vite.config.ts (sent as device info). */
declare const __APP_VERSION__: string;
