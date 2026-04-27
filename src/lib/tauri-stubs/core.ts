/// Web-build stub for `@tauri-apps/api/core`.
///
/// Vite's resolve.alias swaps `@tauri-apps/api/core` for this module
/// when `FISHBONES_TARGET=web`. Calls throw a recognisable error so
/// any code path that hasn't been gated by `isWeb` fails loudly
/// rather than silently no-op'ing — easier to spot during the rollout.
///
/// Phases 2-4 progressively replace the still-thrown sites with real
/// web implementations:
///   - Phase 2: storage commands → IndexedDB.
///   - Phase 3: runtime gate (`runtimes/index.ts`) short-circuits
///     before invoke fires, so the stub is never reached for native
///     toolchain languages.
///   - Phase 4: AI / cloud commands → direct HTTPS calls.
///
/// Until then, any thrown `TAURI_UNAVAILABLE` indicates a feature
/// that still needs porting (or a place where `isWeb` should gate
/// the call).
export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  throw new Error(
    `TAURI_UNAVAILABLE: invoke("${cmd}") was called on the web build. ` +
      `Either gate this call site with platform.ts isWeb, or replace ` +
      `it with a web-compatible implementation.`,
  );
}

/// Some callers also pull `Channel` / `convertFileSrc` from the same
/// module. Re-export minimal stubs for those that compile but throw
/// on use.
export class Channel<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onmessage: (response: T) => void = () => {};
  constructor() {
    // No-op. The real Channel pipes Tauri IPC messages; on web we
    // never wire one up, so nothing comes through.
  }
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // On desktop this rewrites a fs path to an asset:// URL the
  // webview can fetch. There's no equivalent on web — the caller
  // should already be using a public URL.
  return filePath;
}
