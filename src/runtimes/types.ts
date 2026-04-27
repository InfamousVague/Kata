/// Shared return type for all language runtimes.
///
/// `logs` is the captured console.{log,info,warn,error} output, each entry one
/// call. `error` is set when the code threw. `durationMs` helps surface
/// suspiciously slow runs.
export interface RunResult {
  logs: LogLine[];
  error?: string;
  tests?: TestResult[];
  durationMs: number;
  /// For web-runtime results: URL where the assembled document is
  /// served from the local Tauri-hosted preview server. OutputPane
  /// surfaces this as a clickable link + "Open in browser" button so
  /// the user picks up DevTools + real-origin semantics instead of
  /// the sandboxed iframe we used to ship.
  previewUrl?: string;
  /// Discriminates the runtime behind `previewUrl`. `"web"` is the
  /// plain HTML path; `"reactnative"` unlocks the RN-specific dev
  /// tools row in OutputPane (Open in iOS Simulator, QR code, Expo
  /// instructions). Missing = plain web.
  previewKind?: "web" | "reactnative";
  /// Set by the runtime when `testCode` was supplied. Lets
  /// `isPassing` distinguish between "run-only challenge with no
  /// tests" (pass if no error) and "tests were expected but the
  /// harness returned nothing" (always a fail — caught a real bug in
  /// the JS async test harness once). Runtimes that always produce
  /// test rows when tests are asked for can leave this unset.
  testsExpected?: boolean;
  /// When a native runner (Java, Kotlin, C, C++, C#, Assembly) detected
  /// that the toolchain isn't installed — either because the binary
  /// wasn't on PATH (`ErrorKind::NotFound`) or because macOS shipped a
  /// stub that printed "please install" and bailed — this carries the
  /// canonical `LanguageId` so OutputPane can render the install banner
  /// instead of a wall of red stderr. Unset for browser-hosted runtimes
  /// (JS/TS/Python) where there's no toolchain to miss.
  missingToolchainLanguage?: string;
  /// Set by `runCode` / `runFiles` on the WEB build when the user
  /// tried to run a language whose runtime needs the desktop app
  /// (system compiler for C/C++/Java/Kotlin/C#/Asm/Swift, or the
  /// bundled Node sidecar for SvelteKit). Carries the language id +
  /// a one-line reason; OutputPane renders the desktop upsell instead
  /// of running the code. Always unset on the desktop build.
  desktopOnly?: {
    language: string;
    reason: string;
  };
}

export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  /** Populated when `passed` is false — message + truncated stack. */
  error?: string;
}

/**
 * Whether a RunResult represents an overall pass. An exercise passes when:
 *   1. The user code didn't throw
 *   2. If tests were expected, at least one test row came back AND all
 *      rows passed. "Tests expected but zero rows" is treated as a
 *      fail — it means the harness silently swallowed the tests
 *      (regressed once when async `test()` bodies with awaits landed
 *      in the microtask queue after the worker had already posted).
 *   3. If no tests were expected (run-only challenge), just "didn't
 *      throw" is enough.
 */
export function isPassing(r: RunResult): boolean {
  if (r.error) return false;
  if (r.testsExpected) {
    if (!r.tests || r.tests.length === 0) return false;
    if (r.tests.some((t) => !t.passed)) return false;
    return true;
  }
  if (r.tests && r.tests.some((t) => !t.passed)) return false;
  return true;
}
