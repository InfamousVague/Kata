import type { LanguageId, WorkbenchAsset, WorkbenchFile } from "../data/types";
import { assembleRunnable } from "../lib/workbenchFiles";
import { canRun, isWeb } from "../lib/platform";
import { runJavaScript, runTypeScript } from "./javascript";
import { runPython } from "./python";
import { runRust } from "./rust";
import { runGo } from "./go";
import { runWeb, isWebLesson } from "./web";
import { runReact } from "./react";
import { runReactNative } from "./reactnative";
import { runSvelte } from "./svelte";
import { runSolidity } from "./solidity";
import { runLua } from "./lua";
import { runSql } from "./sql";
import { runComingSoon } from "./desktopComingSoon";
import type { RunResult } from "./types";

/// Build a `desktopOnly` RunResult for languages that don't fit in a
/// browser tab. The returned shape carries the language + a short
/// reason so OutputPane's `<DesktopUpsellBanner>` can tailor the
/// copy. Used by both `runCode` and `runFiles` so the gate logic
/// stays in one place.
function desktopOnlyResult(language: string, reason: string): RunResult {
  return {
    logs: [],
    durationMs: 0,
    desktopOnly: { language, reason },
  };
}

/// Reasons keyed by language. Kept short — the upsell banner adds
/// the install CTA + platform-specific download buttons on top.
const DESKTOP_ONLY_REASONS: Record<string, string> = {
  c: "Needs a real C compiler (clang / gcc) which the desktop app shells out to.",
  cpp: "Needs a real C++ compiler (clang / g++) which the desktop app shells out to.",
  java: "Needs javac + a JVM. Get the desktop app to run Java lessons.",
  kotlin: "Needs the Kotlin compiler. Get the desktop app to run Kotlin lessons.",
  csharp: "Needs the .NET CLI / mono. Get the desktop app to run C# lessons.",
  assembly: "Needs nasm + a system linker. Get the desktop app to run assembly lessons.",
  swift: "Needs Swift toolchain — macOS only. Get the desktop app to run Swift lessons.",
  sveltekit:
    "SvelteKit lessons run via a real Node.js dev server bundled with the desktop app.",
};

/// Desktop-only runtimes (Swift, the native-toolchain pack, SvelteKit's
/// Node sidecar) are loaded via dynamic import so Vite chunk-splits
/// them into their own lazy bundles. Two benefits:
///   1. The web build (FISHBONES_TARGET=web) doesn't pull these into
///      the main chunk; once Phase 3 lands the runtime gate, the
///      lazy chunks are also never fetched on web. Even before the
///      gate, the chunks just sit unused unless the learner clicks
///      Run on a C/C++/Java/Kotlin/C#/Assembly/Swift lesson.
///   2. The desktop main chunk gets smaller too — the native runners
///      collectively pull a fair amount of `invoke` plumbing that
///      most learners never touch.
///
/// Call sites are tiny — `(await import("./swift")).runSwift(...)`.
/// Each switch case's `return` becomes a `return await ...` to keep
/// the Promise<RunResult> contract intact.

export type { RunResult, LogLine, TestResult } from "./types";
export { isPassing } from "./types";

/// Dispatch to the right in-browser runtime for a language.
/// `testCode` is optional; when provided, the runtime runs it against the
/// user's module.exports and reports per-test pass/fail results.
export async function runCode(
  language: LanguageId,
  code: string,
  testCode?: string,
): Promise<RunResult> {
  // Web build: short-circuit languages whose runtime can't fit in a
  // browser tab (system compilers + macOS-only Swift). Render an
  // upsell instead of throwing TAURI_UNAVAILABLE inside the
  // dynamically-imported runner.
  if (isWeb && !canRun(language)) {
    return desktopOnlyResult(
      language,
      DESKTOP_ONLY_REASONS[language] ??
        "This language needs the desktop app's local toolchain.",
    );
  }
  switch (language) {
    case "javascript":
      return runJavaScript(code, testCode);
    case "typescript":
      return runTypeScript(code, testCode);
    case "python":
      return runPython(code, testCode);
    case "rust":
      return runRust(code, testCode);
    case "swift":
      return (await import("./swift")).runSwift(code, testCode);
    case "go":
      return runGo(code, testCode);
    case "c":
      return (await import("./nativeRunners")).runC(code, testCode);
    case "cpp":
      return (await import("./nativeRunners")).runCpp(code, testCode);
    case "java":
      return (await import("./nativeRunners")).runJava(code, testCode);
    case "kotlin":
      return (await import("./nativeRunners")).runKotlin(code, testCode);
    case "csharp":
      return (await import("./nativeRunners")).runCSharp(code, testCode);
    case "assembly":
      return (await import("./nativeRunners")).runAssembly(code, testCode);
    case "web":
    case "threejs":
    case "react":
    case "reactnative":
    case "svelte":
    case "solid":
    case "htmx":
    case "astro":
      // These are multi-file meta-languages — a single concatenated
      // string can't meaningfully run them. Callers must reach us via
      // `runFiles`, which preserves file structure. Returning an
      // explanatory error keeps the RunResult contract intact instead
      // of throwing.
      return {
        logs: [],
        error:
          `Language "${language}" is multi-file only — call runFiles(files, assets) instead of runCode.`,
        durationMs: 0,
      };
    case "bun":
      // Bun source is JavaScript/TypeScript at the syntax level. The
      // playground / course infra runs it through the JS sandbox; a
      // real Bun process isn't bundled.
      return runJavaScript(code, testCode);
    case "tauri":
      // Tauri lessons live in Rust. The runtime delegates to the
      // existing Rust playground proxy — most lessons run plain Rust
      // logic so the Tauri-specific bits (#[tauri::command] attrs)
      // get stripped or stubbed in the lesson source.
      return runRust(code, testCode);
    case "solidity":
      // Wrap the single-string source in a synthesized one-file
      // workbench so the multi-file solidity runtime sees its expected
      // shape. (`runCode` is the legacy entry point — most callers
      // hit `runFiles` directly.)
      return runSolidity(
        [{ name: "Contract.sol", language: "solidity", content: code }],
        testCode,
      );
    // ── 2026 expansion ─────────────────────────────────────
    case "lua":
      // Browser-native via Fengari — pure-JS Lua VM, no toolchain.
      return runLua(code, testCode);
    case "sql":
      // Browser-native via sql.js (SQLite compiled to WASM). Each
      // Run gets a fresh in-memory database; tests use leading
      // `-- expect:` comments to assert row count + first-row shape.
      return runSql(code, testCode);
    // ── Simple-CLI subprocess languages (desktop-only) ──
    // Each writes the user code to a temp file and invokes the
    // host's installed binary. Web build short-circuits these via
    // the `isWeb && !canRun(language)` gate above before reaching
    // here, so the lazy-import never tries to fire a Tauri IPC
    // from the browser.
    case "ruby":
      return (await import("./nativeRunners")).runRuby(code, testCode);
    case "elixir":
      return (await import("./nativeRunners")).runElixir(code, testCode);
    case "haskell":
      return (await import("./nativeRunners")).runHaskell(code, testCode);
    case "scala":
      return (await import("./nativeRunners")).runScala(code, testCode);
    case "dart":
      return (await import("./nativeRunners")).runDart(code, testCode);
    // Move / Cairo / Sway need project scaffolding (manifest +
    // package layout) before their toolchains will run. Stubbed
    // until we add a per-Run scaffolding step in the Rust backend.
    case "move":
    case "cairo":
    case "sway":
      return runComingSoon(language);
    default:
      // Exhaustiveness guard. If a new LanguageId slips in without
      // wiring a runtime (or a lesson's serialized JSON contains a
      // non-LanguageId string like a FileLanguage value leaking
      // through), return an explanatory RunResult rather than an
      // implicit `undefined` that crashes `isPassing` downstream.
      return {
        logs: [],
        error: `No runtime registered for language "${language as string}".`,
        durationMs: 0,
      };
  }
}

/// Multi-file variant used by the workbench UI. Picks the web runtime when
/// the file set includes HTML or CSS (regardless of primary language),
/// otherwise falls through to the single-language runner after assembling
/// the runnable files into one source string. `assets` are injected into
/// the iframe only on the web runtime path — other runtimes ignore them.
export async function runFiles(
  language: LanguageId,
  files: WorkbenchFile[],
  testCode?: string,
  assets?: WorkbenchAsset[],
  /// Identity of the lesson currently in the workbench. Threaded
  /// through to runtimes that need a stable per-lesson handle —
  /// SvelteKit specifically, which keeps a long-lived `vite dev`
  /// process per lesson under `<app-data>/sveltekit-runs/<lessonId>`.
  /// Optional because most runtimes are stateless across lessons.
  lessonId?: string,
  /// Opts in to a richer test harness for chain-aware lessons.
  /// "evm" routes Solidity / Vyper through @ethereumjs/vm so tests
  /// can deploy + call contracts; "solana" (planned) routes Rust
  /// through LiteSVM. Undefined keeps the legacy compile-and-check
  /// behavior so existing exercises don't regress.
  harness?: "evm" | "solana",
): Promise<RunResult> {
  // Web build gate — same logic as runCode, applied here too because
  // runFiles can be entered directly from the workbench (which
  // bypasses runCode's switch).
  if (isWeb && !canRun(language)) {
    return desktopOnlyResult(
      language,
      DESKTOP_ONLY_REASONS[language] ??
        "This language needs the desktop app's local toolchain.",
    );
  }
  // React Native always takes its own preview path — the `isWebLesson`
  // heuristic below (.html/.css file check) would otherwise steal it.
  if (language === "reactnative") {
    return runReactNative(files, currentThemeColors());
  }
  // Plain React (web) is also a dedicated runtime: we ship our own
  // HTML host with React + ReactDOM bundled, so isWebLesson would
  // otherwise hijack it on the basis of a sibling .css file in the
  // file set.
  if (language === "react") {
    return runReact(files);
  }
  // Svelte 5 — compiles `.svelte` source in-browser via the official
  // compiler ESM bundle, mounts via Svelte 5's `mount()` API.
  // Exception: when the file set carries SvelteKit shape
  // (+page.svelte / +server.js / svelte.config.js / ...) we route
  // to the Node-backed runner that scaffolds a real SvelteKit
  // project + runs `vite dev` in the background. The CSR-only
  // in-browser compiler can't host server endpoints, layouts, or
  // routing — only the Node path makes those lessons actually run.
  if (language === "svelte") {
    // SvelteKit detection lives in the same lazy chunk as the
    // SvelteKit runner — we only need it when the user clicks Run
    // on a Svelte lesson, and dynamic-importing it keeps the
    // Node-sidecar code out of the web build's main chunk.
    const sveltekit = await import("./sveltekit");
    if (sveltekit.looksLikeSvelteKit(files)) {
      if (isWeb) {
        // SvelteKit isn't a `LanguageId` so the early gate above
        // didn't catch it. Detect-and-upsell here instead.
        return desktopOnlyResult("sveltekit", DESKTOP_ONLY_REASONS.sveltekit);
      }
      // Fall back to "playground" when the caller didn't pass an
      // id (e.g. the playground sandbox). All SvelteKit lessons
      // share that one project dir; switching languages or files
      // tears it down via `stopSvelteKit`.
      return sveltekit.runSvelteKit(files, lessonId ?? "playground");
    }
    return runSvelte(files);
  }
  // SolidJS — JSX-based; we currently route it through React's runtime
  // for raw JSX evaluation. Lessons that depend on Solid-specific
  // primitives (createSignal, createEffect) provide an inline shim
  // imported from "solid-js" via esm.sh inside the lesson template.
  if (language === "solid") {
    return runReact(files);
  }
  // HTMX + Astro — both render as plain HTML for the playground. The
  // user's hx-* attributes / Astro frontmatter syntax don't need a
  // build step at the lesson level; we just serve the HTML.
  if (language === "htmx" || language === "astro") {
    return runWeb(files, testCode, assets);
  }
  // Solidity — compile via solc-js, run optional JS tests against the
  // compilation output. Headless (no preview iframe). When the lesson
  // sets `harness: "evm"`, route to the chain-aware runtime that
  // actually deploys + invokes the bytecode in @ethereumjs/vm.
  if (language === "solidity") {
    if (harness === "evm") {
      return (await import("./evm")).runEvm(files, testCode);
    }
    return runSolidity(files, testCode);
  }
  // Vyper — same dual mode. No legacy "compile-only" runtime exists
  // today (vyper used to fall through to the exhaustiveness guard);
  // both branches go through the new runtime, which compiles via
  // Pyodide + micropip and either reports compile output or hands
  // the artifacts to the EVM harness.
  if (language === "vyper") {
    return (await import("./vyper")).runVyper(files, testCode, { harness });
  }
  // Auto-route: the LLM sometimes tags a React Native lesson's
  // `language` as "javascript" / "typescript" because JSX transpiles
  // to JS. When that happens, sending the code to `runJavaScript`
  // ends with a `new AsyncFunction(...)` parse failure in the worker
  // ("AsyncFunction@[native code]") — useless error from the
  // learner's POV. Detect RN-looking source up front and flip the
  // dispatch so the runtime actually matches the content.
  if (
    (language === "javascript" || language === "typescript") &&
    looksLikeReactNative(files)
  ) {
    return runReactNative(files, currentThemeColors());
  }
  if (
    isWebLesson(files) ||
    language === "web" ||
    language === "threejs"
  ) {
    return runWeb(files, testCode, assets);
  }
  const code = assembleRunnable(files, language);
  return runCode(language, code, testCode);
}

/// Heuristic for "this file set is actually React Native, not plain JS".
/// Returns true when any file either imports from `react-native` /
/// `react-native-web` or contains what looks like a native JSX tag
/// (`<View`, `<Text`, `<Pressable`, etc.). Intentionally false-negative
/// friendly (a plain-JS file with the substring "react-native" in a
/// string literal won't trip it — we require the `from 'react-native'`
/// shape).
function looksLikeReactNative(files: WorkbenchFile[]): boolean {
  const RN_IMPORT = /\bfrom\s+["']react-native(?:-web)?["']/;
  const RN_TAGS =
    /<\s*(View|Text|Pressable|TouchableOpacity|ScrollView|FlatList|SectionList|SafeAreaView|TextInput|Image|ImageBackground|Button|Modal|ActivityIndicator)\b/;
  for (const f of files) {
    if (!f.content) continue;
    if (RN_IMPORT.test(f.content) || RN_TAGS.test(f.content)) return true;
  }
  return false;
}

/// Resolve the active app theme's colour tokens at run time so the
/// React Native preview can mirror them inside the iframe.
/// `getComputedStyle(document.documentElement)` returns the live values
/// from whichever theme the user has applied — when they switch themes
/// in Settings, the next Run picks up the new palette automatically.
function currentThemeColors(): import("./reactnative").ReactNativePreviewTheme | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    const cs = getComputedStyle(document.documentElement);
    const get = (name: string): string => cs.getPropertyValue(name).trim();
    return {
      bgPrimary: get("--color-bg-primary") || "#0b0b10",
      bgSecondary: get("--color-bg-secondary") || "#15151c",
      bgTertiary: get("--color-bg-tertiary") || "#1f1f28",
      textPrimary: get("--color-text-primary") || "#f5f5f7",
      textSecondary: get("--color-text-secondary") || "#a4a4ad",
      textTertiary: get("--color-text-tertiary") || "#71717a",
      borderDefault:
        get("--color-border-default") || "rgba(255, 255, 255, 0.08)",
    };
  } catch {
    return undefined;
  }
}
