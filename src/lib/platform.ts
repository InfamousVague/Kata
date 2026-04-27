/// Single source of truth for "where is this code running".
///
/// `isWeb` / `isDesktop` are inlined at build time via Vite's `define`
/// (see vite.config.ts) so dead-code elimination drops the wrong
/// branch from each bundle. Use them everywhere a code path needs to
/// differ between the Tauri shell and the static-hosted build at
/// `mattssoftware.com/play`.
///
/// Phase 1 of the web-build rollout. Later phases consume this module
/// for:
///   - Phase 2: `storage.ts` picks Tauri SQLite vs IndexedDB.
///   - Phase 3: `runtimes/index.ts` short-circuits desktop-only
///     languages to a `desktopOnly` `RunResult`; library hides
///     ingest / Ollama / toolchain probes; vendor URLs route through
///     `vendorUrl()`.
///   - Phase 4: `useAiChat` swaps Tauri streaming for a direct
///     `fetch` against `api.mattssoftware.com`.
///   - Phase 5: `<InstallBanner>` mounts and uses `downloadUrl()` to
///     pick the OS-appropriate primary CTA.

import type { LanguageId } from "../data/types";

/// Build target — either "desktop" (the Tauri shell) or "web" (the
/// static-hosted build on mattssoftware.com/play). Threaded through
/// Vite's `define` from the `FISHBONES_TARGET` env var, so dev /
/// preview / prod all resolve the same way.
export const TARGET: "desktop" | "web" =
  ((import.meta.env.FISHBONES_TARGET as "desktop" | "web" | undefined) ??
    "desktop");

export const isWeb = TARGET === "web";
export const isDesktop = TARGET === "desktop";

/// Languages whose runtime needs local processes / system compilers /
/// macOS-only tooling. On web these short-circuit to a "desktop only"
/// upsell instead of attempting to run.
///
/// Kept in a Set so adding / removing a language is one line. When a
/// new browser-runnable language lands (e.g. someone WASM-compiles a
/// Java VM) just remove it here and the runtime gate stops blocking.
const DESKTOP_ONLY_LANGUAGES = new Set<LanguageId>([
  "c",
  "cpp",
  "java",
  "kotlin",
  "csharp",
  "assembly",
  "swift",
]);

/// Whether a language has a runtime that fits in a browser tab on
/// the current build. Always `"full"` on desktop (every runtime is
/// available); on web returns `"upsell"` for the systems-language
/// pack which would need a cloud compile service we haven't built.
export type LanguageSupport = "full" | "upsell";

export function languageSupport(lang: LanguageId): LanguageSupport {
  if (isDesktop) return "full";
  return DESKTOP_ONLY_LANGUAGES.has(lang) ? "upsell" : "full";
}

/// Convenience predicate for the runtime gate in `runtimes/index.ts`.
/// Phase 3 wires this up; Phase 1 just exports it ready to use.
export function canRun(lang: LanguageId): boolean {
  return languageSupport(lang) === "full";
}

/// SvelteKit isn't a separate `LanguageId` — it's detected from file
/// shape (`+page.svelte`, `svelte.config.js`, etc.) inside
/// `runtimes/index.ts`. On web it requires the bundled Node sidecar
/// we don't ship, so detected SvelteKit lessons should also short-
/// circuit to the desktop upsell.
export function canRunSvelteKitOnThisBuild(): boolean {
  return isDesktop;
}

/// Vendor base URL — where the runtimes' generated HTML should reach
/// for `babel.min.js` / `svelte-compiler.js` / `three.module.js` etc.
///
/// Desktop: the Tauri preview server resolves `/vendor/*` against
/// `src-tauri/resources/vendor/`; the runtimes get the URL from
/// `serve_web_preview`. This helper isn't on their hot path there.
///
/// Web: same files are copied into `public/vendor/` at build time
/// (see `scripts/copy-vendor-to-public.mjs`) and served as static
/// assets from the page's own origin. We return an absolute URL
/// because the preview HTML is loaded into a `blob:` iframe whose
/// relative-URL resolution doesn't reach the parent origin.
export function vendorUrl(filename: string): string {
  if (isWeb && typeof window !== "undefined") {
    return `${window.location.origin}/vendor/${filename}`;
  }
  return `/vendor/${filename}`;
}

/// Detected user OS — drives which download button gets primary
/// styling on the install banner. Falls back to "macos" when nothing
/// matches (the banner shows all platforms either way; this is just
/// which one is the default).
export type DetectedOS = "macos" | "windows" | "linux";

export function detectOS(): DetectedOS {
  if (typeof navigator === "undefined") return "macos";
  // Modern API first; falls back to UA string. `userAgentData` is a
  // typed structural extension we cast to since it's not in lib.dom
  // yet on every TS version we support.
  const data = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform = (
    data?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();
  if (platform.includes("win")) return "windows";
  if (
    platform.includes("linux") ||
    platform.includes("ubuntu") ||
    platform.includes("debian") ||
    platform.includes("fedora")
  ) {
    return "linux";
  }
  return "macos";
}

/// Download targets for the desktop install banner. Phase 5 mounts
/// `<InstallBanner>` that consumes this; the desktop URL is whichever
/// release page the user wants to point at on mattssoftware.com.
///
/// Kept here so the banner copy + button labels live in one place
/// and Phase 5 only has to wire UI, not URL strings.
export interface DownloadTarget {
  os: DetectedOS;
  url: string;
  label: string;
}

const DOWNLOAD_BASE = "https://mattssoftware.com/fishbones/download";

export function downloadUrl(): {
  primary: DownloadTarget;
  all: DownloadTarget[];
} {
  const all: DownloadTarget[] = [
    { os: "macos", url: `${DOWNLOAD_BASE}/macos`, label: "Download for macOS" },
    { os: "windows", url: `${DOWNLOAD_BASE}/windows`, label: "Download for Windows" },
    { os: "linux", url: `${DOWNLOAD_BASE}/linux`, label: "Download for Linux" },
  ];
  const detected = detectOS();
  const primary = all.find((t) => t.os === detected) ?? all[0];
  return { primary, all };
}
