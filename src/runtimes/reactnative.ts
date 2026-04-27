import type { WorkbenchFile } from "../data/types";
import type { RunResult } from "./types";
import { presentPreview } from "../lib/preview";

/// React Native runtime — assembles an HTML shell that pulls in React,
/// ReactDOM, and react-native-web from esm.sh + @babel/standalone from
/// unpkg, transpiles the learner's JSX in-browser, and mounts the
/// result via `AppRegistry.runApplication`. The rendered page is
/// served from the local Tauri preview server, same as the plain web
/// runtime — the user opens it in a browser and gets DevTools.
///
/// Scope note: this runtime only covers the "render a component in
/// react-native-web" slice of RN. The `open_in_ios_sim` /
/// `probe_expo_server` Tauri commands hanging off OutputPane handle
/// the "see it in a real simulator / Expo Go" story, but those require
/// Xcode + Node tooling on the host.

/// Resolved theme tokens used by the runtime to style the iframe's
/// page chrome AND make CSS custom properties available to user code
/// inside the preview. The keys are deliberately short — they end up
/// in the iframe's `:root { --<key>: ... }` rule and learners can
/// reference them via `'var(--<key>)'` inside `StyleSheet.create`.
export interface ReactNativePreviewTheme {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  borderDefault: string;
}

export async function runReactNative(
  files: WorkbenchFile[],
  theme?: Partial<ReactNativePreviewTheme>,
): Promise<RunResult> {
  const started = Date.now();

  // Pick the primary source. Conventionally the starter template uses
  // `App.js` — but we accept any .js / .jsx file so the learner can
  // rename freely. Falls back to the first file if there's nothing
  // JS-ish (rare; Monaco's save path keeps at least one file present).
  const source =
    files.find((f) => /\.(jsx?|tsx?)$/i.test(f.name))?.content ??
    files[0]?.content ??
    "";

  const html = buildPreviewHtml(source, theme ?? {});

  const previewUrl = await presentPreview(html);

  return {
    logs: [],
    previewUrl,
    previewKind: "reactnative",
    durationMs: Date.now() - started,
  };
}

/// Default fallback colours used when the caller doesn't pass a
/// theme. Picks a neutral dark palette so the preview is legible
/// before we know which app theme is active.
const DEFAULT_PREVIEW_THEME: ReactNativePreviewTheme = {
  bgPrimary: "#0b0b10",
  bgSecondary: "#15151c",
  bgTertiary: "#1f1f28",
  textPrimary: "#f5f5f7",
  textSecondary: "#a4a4ad",
  textTertiary: "#71717a",
  borderDefault: "rgba(255, 255, 255, 0.08)",
};

/// Construct the standalone HTML that hosts the learner's component.
/// Deliberately inlines everything (CDN script tags + user source
/// base64-encoded) so the preview server can serve a single document
/// with no fetches of its own beyond the CDN bundles.
function buildPreviewHtml(
  userSource: string,
  theme: Partial<ReactNativePreviewTheme>,
): string {
  // Fill in any caller-omitted slots with the dark default so the
  // template's `var(--rn-bg)` references always resolve.
  const t: ReactNativePreviewTheme = { ...DEFAULT_PREVIEW_THEME, ...theme };
  // Base64 the user source so we don't fight escape-in-template-in-
  // template edge cases (backticks, `${}`, nested quotes). Eval-time we
  // decode via atob.
  const sourceB64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(userSource)))
      : Buffer.from(userSource, "utf-8").toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>Fishbones — React Native preview</title>
  <style>
    /* Live theme tokens propagated from the parent app. The default
       template references these via 'var(--rn-bg-primary)' etc., and
       react-native-web passes the value through to the rendered
       stylesheet untouched — so the preview adopts whichever Fishbones
       theme is active when Run was clicked. */
    :root {
      --rn-bg-primary: ${t.bgPrimary};
      --rn-bg-secondary: ${t.bgSecondary};
      --rn-bg-tertiary: ${t.bgTertiary};
      --rn-text-primary: ${t.textPrimary};
      --rn-text-secondary: ${t.textSecondary};
      --rn-text-tertiary: ${t.textTertiary};
      --rn-border-default: ${t.borderDefault};
    }
    html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
      background: var(--rn-bg-primary);
      color: var(--rn-text-primary);
      -webkit-font-smoothing: antialiased;
    }
    #__fishbones_error {
      position: fixed; inset: 0;
      padding: 24px;
      background: #1a0b0f;
      color: #f3b0b0;
      font: 12px/1.5 "SF Mono", ui-monospace, Menlo, monospace;
      white-space: pre-wrap;
      overflow: auto;
      z-index: 999;
    }
  </style>
  <!-- Babel standalone, served from the local Tauri preview server's
       /vendor route. Same file the CDN used to ship — but bundled
       once at build time and read from the shipped resources dir, so
       Fishbones works fully offline. -->
  <script src="/vendor/babel.min.js"></script>
</head>
<body>
  <!-- Boot marker — shown immediately as the HTML body parses, hidden
       once the React mount commits its first paint into #root. If this
       is still visible after a Run, we know the runtime got blocked
       BEFORE React rendered (CSP blocking the CDN imports, network
       failure to esm.sh/unpkg, parse error in the user code, etc.).
       If this is gone but the screen is still blank, React mounted but
       produced nothing — usually a styling/layout problem. -->
  <div id="__fishbones_boot"
       style="position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; color: #6a6a78; font: 12px/1.5 'SF Mono', ui-monospace, Menlo, monospace; text-align: center; pointer-events: none; opacity: 0.7;">
    booting react-native-web preview…
  </div>
  <div id="root"></div>
  <script type="module">
    ${CONSOLE_SHIM}

    /// Wrap the whole pipeline (imports + transform + mount) in a
    /// single async function with a top-level try/catch, so that an
    /// import failure (CDN unreachable, parse error in the bundle,
    /// CSP block) surfaces in our error overlay instead of silently
    /// terminating the module. Top-level static \`import\` statements
    /// don't fire any catchable event when they fail — the whole
    /// module just never runs, leaving the boot marker stuck on
    /// screen with no clue why.
    /// Update the boot marker's text so a stuck pipeline tells us
    /// WHICH stage stalled instead of just "booting…" forever.
    function bootStage(text) {
      const el = document.getElementById("__fishbones_boot");
      if (el) el.textContent = text;
    }

    bootStage("module script started — loading vendored bundles…");

    (async function bootPreview() {
    let React, createRoot, ReactNative, AppRegistry;
    try {
      bootStage("loading react…");
      // Vendored bundles served from the local Tauri preview server's
      // /vendor route. No CDN traffic — scripts/vendor-cdn-deps.mjs
      // bakes these out of node_modules at build time.
      const reactMod = await import("/vendor/react.js");
      React = reactMod.default || reactMod;
      bootStage("loading react-dom…");
      const reactDom = await import("/vendor/react-dom-client.js");
      createRoot = reactDom.createRoot;
      bootStage("loading react-native-web…");
      ReactNative = await import("/vendor/react-native-web.js");
      AppRegistry = ReactNative.AppRegistry;
      bootStage("vendored bundles ready, transforming user code…");
    } catch (err) {
      showPhaseError(
        "imports",
        err,
        "Couldn't load the vendored React + react-native-web bundles.\\n" +
          "Check that scripts/vendor-cdn-deps.mjs ran during the build."
      );
      console.error("[imports]", err);
      return;
    }

    const source = atob("${sourceB64}");

    // Strip ES-module \`import\` statements from the user source. The
    // runtime binds React + react-native-web into scope directly, and
    // leaving \`import { View } from 'react-native'\` in would trip a
    // browser parse error once Babel transforms it to a \`require\`.
    const cleaned = source
      .replace(/^\\s*import\\s[\\s\\S]+?;\\s*$/gm, "")
      .replace(/^\\s*export\\s+default\\s+function/m, "function")
      .replace(/^\\s*export\\s+default\\s+class/m, "class")
      .replace(/^\\s*export\\s+default\\s+/m, "const __appExport = ")
      .replace(/^\\s*export\\s+/gm, "");

    // Pull every capitalised top-level function / class / const
    // identifier out of the cleaned source so the factory can fall
    // back to "first capitalised thing in scope" when the learner
    // doesn't name their component App or use a default export. The
    // regex is intentionally loose — false positives are harmless
    // (we typeof-check inside the factory before using a name) and
    // a stricter parse here would drag a real AST library into the
    // iframe just for one fallback heuristic.
    const __candidateNames = [];
    {
      const idRe = /(?:^|\\n)\\s*(?:function|class|const|let|var)\\s+([A-Z][A-Za-z0-9_]*)/g;
      let m;
      const seen = new Set();
      while ((m = idRe.exec(cleaned)) !== null) {
        if (!seen.has(m[1])) { seen.add(m[1]); __candidateNames.push(m[1]); }
      }
    }

    // Three phases, three separate try blocks — so a Babel parse error
    // (user code has bad JS), a new-Function construction error (our
    // injected preamble broke), and a runtime render error (App threw
    // while mounting) each surface with a clear "phase: message"
    // instead of a single try/catch collapsing them into "Unexpected
    // identifier 'code'" with no hint of which layer produced it.
    let transpiled;
    try {
      const out = Babel.transform(cleaned, {
        presets: [["react", { runtime: "classic" }]],
        filename: "App.js",
        // sourceType "script" is deliberate — the transpiled output
        // gets spliced into a \`new Function(body)\` wrapper (script
        // semantics, top-level \`return\` allowed). "module" mode would
        // stamp module semantics onto the output and the appended
        // return below becomes "Return statements are only valid
        // inside functions". Script also skips the automatic
        // "use strict" directive which can clash with the surrounding
        // wrapper.
        sourceType: "script",
      });
      transpiled = out.code;
    } catch (err) {
      showPhaseError("parse", err, cleaned);
      console.error("[babel parse]", err);
      return;
    }

    // Wrap the user's transpiled code in an IIFE. Two reasons:
    //
    // 1. Scope isolation — a stray top-level identifier in user code
    //    stays in the IIFE, doesn't leak.
    //
    // 2. Brace-mismatch containment — if the user / LLM emitted code
    //    with an unbalanced \\\`}\\\` (extra closer, unclosed block), it
    //    would otherwise close our outer \\\`new Function\\\` body early
    //    and our trailing \\\`return\\\` would sit at script top level,
    //    triggering the exact "Return statements are only valid inside
    //    functions" error we kept hitting. The IIFE absorbs those
    //    stray braces so the damage is contained — at worst the IIFE
    //    ends early, the user's App function never gets declared, and
    //    we surface a clean "No component found" from the null return.
    let factory;
    try {
      factory = new Function(
        "React",
        "ReactNative",
        [
          "const { Component, Fragment, StrictMode, useState, useEffect, useMemo, useCallback, useRef, useReducer, useContext, createContext, useLayoutEffect, useTransition, useDeferredValue } = React;",
          "const {",
          "  AppRegistry, View, Text, TextInput, ScrollView, FlatList, SectionList, VirtualizedList,",
          "  Pressable, TouchableOpacity, TouchableWithoutFeedback, TouchableHighlight,",
          "  Button, Switch, Image, ImageBackground, SafeAreaView, ActivityIndicator,",
          "  StyleSheet, Platform, Dimensions, Animated, Easing, Alert, Keyboard, KeyboardAvoidingView, Linking,",
          "  StatusBar, Modal, RefreshControl, PixelRatio, Share, Appearance,",
          "  useColorScheme, useWindowDimensions, processColor,",
          "} = ReactNative;",
          "return (function __fishbonesUserModule() {",
          // CommonJS-shape shim so source that includes a CommonJS
          // export line (module.exports = { Foo }) — e.g. solutions
          // from the logic-test challenge packs that get routed here
          // when the language is reactnative — doesn't crash with
          // "ReferenceError: Can't find variable: module". Whatever
          // gets assigned is ignored; we only look for App or
          // __appExport in the closure scope below.
          "  const module = { exports: {} };",
          "  const exports = module.exports;",
          // Inline the candidate-name list so the fallback resolver
          // below knows which identifiers to typeof-check. Names
          // come from the regex scan against the cleaned source
          // above — they're plain capitalised identifiers, no need
          // to escape them, but we JSON.stringify the array anyway
          // for belt-and-suspenders quoting.
          "  const __candidateNames = " + JSON.stringify(__candidateNames) + ";",
          transpiled,
          // Component resolution, in priority order. We try the
          // explicit signals first (a function literally named App,
          // a default export rewritten to __appExport, a CommonJS
          // exports.default / module.exports.App) before falling
          // back to "find any capitalised function in scope" so a
          // learner who wrote \`function Counter() { ... }\` without
          // an export still sees their component on screen instead
          // of the misleading "No component found" error.
          "  if (typeof App !== 'undefined') return App;",
          "  if (typeof __appExport !== 'undefined') return __appExport;",
          "  if (module.exports && module.exports.default) return module.exports.default;",
          "  if (module.exports && typeof module.exports === 'function') return module.exports;",
          "  if (module.exports && module.exports.App) return module.exports.App;",
          // Last resort — pick the first capitalised top-level
          // function name that's in scope. This relies on
          // Babel-transpiled function declarations being hoisted +
          // visible via \`typeof <name> === 'function'\`. The list
          // gets pulled from the user source via a Babel pass at
          // build time and spliced in below as __candidateNames.
          "  for (const name of __candidateNames) {",
          "    try { if (eval('typeof ' + name) === 'function' && /^[A-Z]/.test(name)) return eval(name); } catch {}",
          "  }",
          "  return null;",
          "})();",
        ].join("\\n"),
      );
    } catch (err) {
      // new Function(...) parse failures look like "SyntaxError:
      // Unexpected identifier 'code'" when Babel emitted something
      // valid-in-module-mode but invalid in Function-body mode (a
      // stray top-level await, a bare import-name, etc.). Surface
      // the transpiled body so we can see what actually shipped.
      showPhaseError("compile", err, transpiled || cleaned);
      // Dump the raw inputs to console so the author can paste them
      // back when opening an issue — easier than retyping the lesson.
      console.group("[factory compile] failure");
      console.error(err);
      console.log("cleaned source:", cleaned);
      console.log("transpiled:", transpiled);
      console.groupEnd();
      return;
    }

    try {
      const App = factory(React, ReactNative);
      if (!App) {
        const namesHint = __candidateNames.length > 0
          ? " Saw these capitalised names but none resolved to a function: " + __candidateNames.join(", ") + "."
          : " Source had no capitalised top-level function or class declarations.";
        throw new Error(
          "No component found." + namesHint +
          " Either rename your component to App, add 'export default', or do 'module.exports = MyComponent'."
        );
      }
      // Mount via ReactDOM.createRoot directly. We previously used
      // \`AppRegistry.runApplication\` which is the canonical RN-web
      // entry, but AppRegistry's plumbing was sometimes leaving the
      // root unmounted in our iframe (no error, just blank screen)
      // depending on react-native-web's internal style-renderer
      // initialization order. Going through createRoot is one fewer
      // moving piece — react-native-web's components handle their own
      // style injection at render time, so we still get correct RN
      // semantics without relying on AppRegistry's mount path.
      AppRegistry.registerComponent("FishbonesApp", () => App);
      const rootEl = document.getElementById("root");
      const root = createRoot(rootEl);
      root.render(React.createElement(App));
      // First commit landed — clear the boot marker so the user
      // sees the rendered UI instead of "booting…" floating over it.
      const bootEl = document.getElementById("__fishbones_boot");
      if (bootEl) bootEl.remove();
    } catch (err) {
      showPhaseError("render", err);
      console.error("[render]", err);
    }

    /// Render an error into a full-screen pre overlay. Combines name +
    /// message + stack so WebKit's stack-only default (which looks
    /// like "anonymous@ ⏎ module code@http://.../:84:26" without any
    /// message — escape sequence avoided here because the outer
    /// template literal would interpret a literal backslash-n as a
    /// real newline and break this comment) stops being a mystery.
    /// Dedupes: calling twice reuses the same element so the second
    /// error doesn't hide the first.
    function showError(err) {
      showPhaseError("", err);
    }

    /// Variant of \`showError\` that labels which pipeline phase failed
    /// (parse / compile / render) and optionally shows a code snippet
    /// near the failure site. \`phase\` can be empty for the post-mount
    /// window.error path.
    function showPhaseError(phase, err, sourceHint) {
      const name = err && err.name ? err.name : "Error";
      const msg = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? err.stack : "(no stack)";
      const label = phase ? "[" + phase + "] " : "";
      let snippet = "";
      if (sourceHint && err && typeof err.loc === "object" && err.loc) {
        // Babel SyntaxErrors carry \`loc: { line, column }\` — show the
        // ±3 line window around that point so the learner can see
        // exactly where the parser choked.
        snippet = buildSnippet(sourceHint, err.loc.line, err.loc.column);
      }
      let pre = document.getElementById("__fishbones_error");
      if (!pre) {
        pre = document.createElement("pre");
        pre.id = "__fishbones_error";
        document.body.appendChild(pre);
      }
      pre.textContent =
        label + name + ": " + msg + "\\n\\n" + stack +
        (snippet ? "\\n\\n---\\n" + snippet : "");
    }

    function buildSnippet(source, line, column) {
      const lines = source.split("\\n");
      const target = Math.max(1, line || 1);
      const start = Math.max(1, target - 3);
      const end = Math.min(lines.length, target + 3);
      const out = [];
      for (let i = start; i <= end; i++) {
        const num = String(i).padStart(4, " ");
        out.push(num + " | " + lines[i - 1]);
        if (i === target && typeof column === "number") {
          out.push("     | " + " ".repeat(Math.max(0, column)) + "^");
        }
      }
      return out.join("\\n");
    }

    })().catch((err) => {
      // Last-resort backstop. \`showPhaseError\` lives inside the async
      // function scope and isn't in scope here, so we reuse the
      // CONSOLE_SHIM's \`__fishbonesShowError\` helper which is defined
      // at module top-level. Either way the user gets a visible
      // overlay instead of a silent rejection.
      console.error("[boot]", err);
      try { __fishbonesShowError(err); } catch (e) { /* shim missing */ }
    });
  </script>
</body>
</html>`;
}

/// Tiny console shim so uncaught errors reach the browser console
/// reliably even when the eval chain swallows them. Mirrors the intent
/// of the web runtime's postMessage shim but skips the cross-origin
/// plumbing — RN previews open in a real browser, so the user reads
/// logs via DevTools rather than the OutputPane.
///
/// ALSO renders the error into the #__fishbones_error overlay (created on
/// demand) so the learner sees WebKit's otherwise-bare stack with an
/// actual name + message attached. Without this, async errors (a
/// useEffect callback throwing, a Promise rejecting) produce only a
/// stack frame like "anonymous@ module code@http://.../:84:26" with
/// no indication of what went wrong.
const CONSOLE_SHIM = `
function __fishbonesShowError(err) {
  var name = err && err.name ? err.name : "Error";
  var msg = err && err.message ? err.message : (typeof err === "string" ? err : String(err));
  var stack = err && err.stack ? err.stack : "(no stack)";
  var pre = document.getElementById("__fishbones_error");
  if (!pre) {
    pre = document.createElement("pre");
    pre.id = "__fishbones_error";
    document.body.appendChild(pre);
  }
  pre.textContent = name + ": " + msg + "\\n\\n" + stack;
}
window.addEventListener("error", (e) => {
  var err = e.error || new Error(e.message || "Script error");
  console.error("[preview error]", e.message, "(" + (e.filename || "?") + ":" + (e.lineno || "?") + ")", err);
  __fishbonesShowError(err);
});
window.addEventListener("unhandledrejection", (e) => {
  var err = e.reason instanceof Error ? e.reason : new Error(e.reason && e.reason.message ? e.reason.message : String(e.reason));
  console.error("[preview rejection]", err);
  __fishbonesShowError(err);
});
`.trim();
