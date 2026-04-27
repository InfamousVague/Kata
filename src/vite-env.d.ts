/// <reference types="vite/client" />

/// Build-target env var injected via vite.config.ts `define`. Read by
/// `src/lib/platform.ts` to expose `isWeb` / `isDesktop` everywhere.
/// Values: "desktop" (Tauri shell, default) | "web" (mattssoftware.com/play).
interface ImportMetaEnv {
  readonly FISHBONES_TARGET?: "desktop" | "web";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
