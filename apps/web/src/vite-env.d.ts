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
/** A12: the short git commit of the build («abc1234», or «local» outside a git checkout). */
declare const __APP_BUILD__: string;
/** A12: when the build was made (ISO 8601 UTC). */
declare const __APP_BUILT_AT__: string;
