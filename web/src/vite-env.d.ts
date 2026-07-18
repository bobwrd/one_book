/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the OneBook Worker API. Empty means run standalone. */
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
