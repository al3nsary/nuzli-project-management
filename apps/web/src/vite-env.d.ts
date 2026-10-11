/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' in the GitHub Pages demo build (ADR-020). */
  readonly VITE_DEMO?: string;
  /** Base URL of the REST API, default `/api/v1`. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
