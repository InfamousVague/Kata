/// Monaco bootstrap — bundles Monaco locally via Vite instead of pulling
/// it from cdn.jsdelivr.net at runtime.
///
/// WHY THIS EXISTS
/// ---------------
/// Originally we configured `@monaco-editor/react`'s loader to fetch
/// Monaco's AMD loader + workers from jsdelivr:
///
///   loader.config({ paths: { vs: "https://cdn.jsdelivr.net/.../vs" } });
///
/// That works in `tauri dev` (page served from http://localhost:1420),
/// but in the signed production Tauri webview the page origin is
/// `tauri://localhost`, and:
///
///   1. Cross-origin Web Workers spawned from a CDN URL don't run
///      reliably under Tauri's WebKit — workers need same-origin or a
///      tightly-scoped `worker-src` CSP. The result was a syntax-
///      highlight-less editor that "looked super broken".
///   2. Monaco's AMD loader fetches `vs/loader.js`, then resolves
///      further `vs/...` modules — every additional fetch is another
///      chance to fall foul of the prod CSP.
///
/// The fix is to drop the runtime CDN entirely and let Vite bundle
/// Monaco + its workers as part of our own assets. They ship with the
/// app, load from the `tauri://localhost` origin, and the worker code
/// itself runs from blob: URLs (which we permit via CSP).
///
/// CONTRACT
/// --------
/// This module has top-level side effects:
///   - wires `self.MonacoEnvironment` so Monaco knows where to find
///     each language's worker
///   - calls `loader.config({ monaco })` so `@monaco-editor/react`
///     uses our bundled instance instead of trying to fetch a CDN copy
///
/// IT MUST BE IMPORTED BEFORE ANY MONACO-USING COMPONENT MOUNTS.
/// Putting `import "../../lib/monaco-setup";` at the top of EditorPane
/// and InlineSandbox is enough — those files are evaluated when their
/// module graphs load, which happens before React renders them.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/// Eagerly register every basic-language Monarch tokenizer Fishbones
/// uses. By default `monaco-editor`'s editor.main.js wires these up
/// behind dynamic imports (so a JS-only lesson doesn't pay the bundle
/// cost of Kotlin/Rust/etc), but the Tauri production webview hits a
/// silent failure resolving those lazy chunk URLs — Monaco loads, the
/// editor renders, and the language tokenizer just never fires, so the
/// code shows up as plain unstyled text.
///
/// Importing the contribution barrels eagerly makes the registration
/// happen at boot. Each contribution is a few KB of Monarch grammar +
/// a `monaco.languages.register({ id: ... })` call — well within budget
/// to ship up-front.
///
/// `monaco.contribution` files are side-effect-only modules; we don't
/// need any value from them, just the act of importing.
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";

/// Direct imports of every Monarch tokenizer Fishbones uses. The
/// `<lang>.contribution` imports above only register the LANGUAGE
/// EXISTS — the actual Monarch grammar lives behind `loader: () =>
/// import("./<lang>")` inside Monaco. In Tauri's production webview
/// those lazy `import()`s sometimes resolve to a broken URL and the
/// chunk never loads, so we end up with no tokenizer (= plain white
/// code, exactly the bug you saw in the v0.1.2 build).
///
/// Pulling each `<lang>.ts` file in directly via static import means
/// the grammars ship in the main monaco chunk and we register them
/// ourselves below — Monaco's lazy machinery is bypassed entirely.
import * as bashLang from "monaco-editor/esm/vs/basic-languages/shell/shell";
import * as cppLang from "monaco-editor/esm/vs/basic-languages/cpp/cpp";
import * as csharpLang from "monaco-editor/esm/vs/basic-languages/csharp/csharp";
import * as goLang from "monaco-editor/esm/vs/basic-languages/go/go";
import * as javaLang from "monaco-editor/esm/vs/basic-languages/java/java";
import * as kotlinLang from "monaco-editor/esm/vs/basic-languages/kotlin/kotlin";
import * as mipsLang from "monaco-editor/esm/vs/basic-languages/mips/mips";
import * as pythonLang from "monaco-editor/esm/vs/basic-languages/python/python";
import * as rustLang from "monaco-editor/esm/vs/basic-languages/rust/rust";
import * as swiftLang from "monaco-editor/esm/vs/basic-languages/swift/swift";
import { svelteLang, svelteConf } from "./monaco-svelte";
import { solidityLang, solidityConf } from "./monaco-solidity";

/// Tell Monaco how to spawn a worker for a given language label. The
/// `workerId` argument is unused — Monaco only cares which worker
/// constructor we hand back. Each `new XxxWorker()` is a fresh dedicated
/// worker, which is what Monaco expects.
//
// The `?worker` suffix is a Vite convention: the import resolves to a
// worker constructor at build time. Vite emits each worker as its own
// chunk, with a same-origin URL relative to our bundle.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/// Hand `@monaco-editor/react` our bundled monaco instance. Once this
/// runs, the loader resolves immediately on first use — no network
/// round-trip, no AMD loader fetch. This MUST happen before any
/// `<Editor />` component mounts, which is why this whole module is a
/// side-effect import.
loader.config({ monaco });

/// Manually re-register each language with the eagerly-imported
/// Monarch grammar. `register({ id })` is idempotent (Monaco no-ops
/// duplicate ids), and `setMonarchTokensProvider` overwrites whatever
/// Monaco's internal lazy loader would otherwise provide on first use.
/// Result: tokenizers are in memory the moment this module loads.
const BASIC_LANGUAGES: Array<{
  id: string;
  language: monaco.languages.IMonarchLanguage;
  conf: monaco.languages.LanguageConfiguration;
}> = [
  // Monaco doesn't ship a separate `c` tokenizer — `cpp` covers both.
  { id: "c", language: cppLang.language, conf: cppLang.conf },
  { id: "cpp", language: cppLang.language, conf: cppLang.conf },
  { id: "csharp", language: csharpLang.language, conf: csharpLang.conf },
  { id: "go", language: goLang.language, conf: goLang.conf },
  { id: "java", language: javaLang.language, conf: javaLang.conf },
  { id: "kotlin", language: kotlinLang.language, conf: kotlinLang.conf },
  { id: "mips", language: mipsLang.language, conf: mipsLang.conf },
  { id: "python", language: pythonLang.language, conf: pythonLang.conf },
  { id: "rust", language: rustLang.language, conf: rustLang.conf },
  { id: "shell", language: bashLang.language, conf: bashLang.conf },
  { id: "swift", language: swiftLang.language, conf: swiftLang.conf },
  { id: "svelte", language: svelteLang, conf: svelteConf },
  { id: "solidity", language: solidityLang, conf: solidityConf },
];

for (const { id, language, conf } of BASIC_LANGUAGES) {
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, language);
  monaco.languages.setLanguageConfiguration(id, conf);
}

/// Re-export the monaco namespace so callers that need direct API
/// access (theme registration, ambient `addExtraLib` calls) can import
/// it from a single place.
export { monaco };
