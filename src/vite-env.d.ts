/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in a build that shows the cloud AI settings and the send step (#72). Off by default. */
  readonly VITE_CLOUD_AI?: string;
}
