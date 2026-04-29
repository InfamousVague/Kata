/// <reference types="vitest" />
import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const host = process.env.TAURI_DEV_HOST;

// Build-target switch — desktop (Tauri shell, default) vs web
// (static-hosted at mattssoftware.com/play). Set via FISHBONES_TARGET
// env var; threaded into the bundle through `define` so
// `import.meta.env.FISHBONES_TARGET` resolves at compile time and
// Rollup can dead-code-eliminate the wrong branch from each variant.
//
// See `src/lib/platform.ts` for the consumer side, and
// `scripts/copy-vendor-to-public.mjs` for the vendor-asset prep that
// the web build needs.
//
const target: "desktop" | "web" =
  process.env.FISHBONES_TARGET === "web" ? "web" : "desktop";
const isWebBuild = target === "web";

// Public base path for the web build — where the bundle's assets
// expect to be served from. Different consumers want different
// values:
//   /fishbones/learn/  ← mattssoftware.com (legacy embed at that path)
//   /learn/            ← fishbones.academy (the new product domain)
//   /                  ← any other host that mounts the app at root
//
// Override at build time with FISHBONES_BASE; falls back to the
// mattssoftware path for backward compatibility (existing
// build:web invocations don't need to change).
const webBase = (process.env.FISHBONES_BASE || "/fishbones/learn/").replace(
  /\/?$/,
  "/",
);

// On the web build, every @tauri-apps/* import is aliased to a local
// stub so the bundle compiles even though there's no Tauri runtime.
// Each stub preserves the same export shape so type-checking works in
// either mode without needing parallel .d.ts files. Anything that
// throws at runtime (the `invoke` stub) signals a code path that
// hasn't been gated by `isWeb` yet — Phases 2-4 progressively port
// each call site.
const TAURI_STUB_DIR = resolve(__dirname, "src/lib/tauri-stubs");
const tauriAliases = isWebBuild
  ? {
      "@tauri-apps/api/core": resolve(TAURI_STUB_DIR, "core.ts"),
      "@tauri-apps/api/event": resolve(TAURI_STUB_DIR, "event.ts"),
      "@tauri-apps/api/webviewWindow": resolve(
        TAURI_STUB_DIR,
        "webviewWindow.ts",
      ),
      "@tauri-apps/plugin-dialog": resolve(
        TAURI_STUB_DIR,
        "plugin-dialog.ts",
      ),
      "@tauri-apps/plugin-deep-link": resolve(
        TAURI_STUB_DIR,
        "plugin-deep-link.ts",
      ),
      "@tauri-apps/plugin-opener": resolve(
        TAURI_STUB_DIR,
        "plugin-opener.ts",
      ),
    }
  : {};

export default defineConfig(async () => ({
  plugins: [
    react(),
    // Node-built-in shims for libraries that target Node + browser
    // (e.g. @ethereumjs/*, readable-stream). Scoped to the modules
    // those libraries actually reach for: `events.EventEmitter`,
    // `buffer.Buffer`, `stream`, `util`, `crypto`. Anything else
    // stays externalised so we don't accidentally bloat the bundle
    // with the kitchen-sink polyfill set.
    //
    // Tree-shaking keeps the cost low: code paths that never import
    // `events`/`buffer`/etc. compile to nothing here. The cost only
    // shows up in the EVM/Vyper lazy-loaded chunk
    // (`src/runtimes/evm.ts`, `vyper.ts`) where ethereumjs-util
    // imports `from 'events'` for its async EventEmitter.
    //
    // We DON'T expose `globals.Buffer` / `globals.process` because the
    // app itself never reaches for those globals — the polyfill just
    // needs to satisfy the *bare specifier* imports inside ethereumjs.
    nodePolyfills({
      include: ["events", "buffer", "stream", "util", "crypto"],
      globals: { Buffer: false, global: false, process: false },
      protocolImports: false,
    }),
  ],
  // Web build deploys under `mattssoftware.com/fishbones/learn/`, so
  // every emitted asset URL needs that prefix. Desktop ships at the
  // webview's root (`tauri://...`) so an empty base is correct
  // there. Vite's `import.meta.env.BASE_URL` reflects this and is
  // what `webSeedCourses.ts` uses to resolve `/starter-courses/*`.
  base: isWebBuild ? webBase : "/",
  define: {
    // Compile-time platform marker. Read by src/lib/platform.ts.
    "import.meta.env.FISHBONES_TARGET": JSON.stringify(target),
  },
  resolve: {
    alias: {
      "@base": resolve(__dirname, "node_modules/@mattmattmattmatt/base"),
      ...tauriAliases,
    },
  },
  // Pre-bundle Monaco in dev so its many small ESM files are served as a
  // single optimised chunk instead of hundreds of individual requests
  // (which makes hot-reload janky and occasionally drops worker code).
  optimizeDeps: {
    include: ["monaco-editor"],
    // On the web build there's no Tauri runtime, so don't pre-bundle
    // the (now-stubbed) Tauri SDK — it would just inline the throwing
    // shims into Vite's dep-cache for no benefit.
    exclude: isWebBuild
      ? [
          "@tauri-apps/api",
          "@tauri-apps/api/core",
          "@tauri-apps/api/event",
          "@tauri-apps/api/webviewWindow",
          "@tauri-apps/plugin-dialog",
          "@tauri-apps/plugin-deep-link",
          "@tauri-apps/plugin-opener",
        ]
      : [],
  },
  // Split Monaco out into its own bundle chunk in prod so it doesn't
  // bloat the main app bundle (Monaco is ~3 MB minified). Keeps initial
  // app load lean and gives us a clean lever for lazy-loading later.
  build: {
    // Web build lands in `dist-web/` so it doesn't clobber the
    // Tauri-consumed `dist/` directory. The Cloudflare Pages deploy
    // (Phase 5) uploads `dist-web/` directly.
    outDir: isWebBuild ? "dist-web" : "dist",
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ["monaco-editor"],
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Allow Vite to serve files from the base library (linked via file:).
    fs: {
      allow: [
        resolve(__dirname),
        resolve(__dirname, "../../Libs/base"),
      ],
    },
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    mockReset: true,
  },
}));
