import type { WorkbenchFile } from "../data/types";
import type { RunResult } from "./types";
import { presentPreview } from "../lib/preview";

/// React runtime — assembles an HTML shell that pulls in React +
/// ReactDOM from esm.sh, transpiles the learner's JSX in-browser via
/// @babel/standalone, and mounts the user's `App` component into the
/// page. Sibling of `reactnative.ts`: same shape (Tauri preview server,
/// CDN bundles, base64-encoded user source) but targets web React, not
/// react-native-web. The preview opens in the user's real browser so
/// they get DevTools + extensions.
///
/// Multi-file support: the user can drop multiple .jsx / .js / .tsx /
/// .ts files into the workbench; we concatenate them in the order they
/// appear. A separate `style.css` (or any .css file) is inlined into a
/// single <style> tag in <head>. If there's no `App` component
/// declared anywhere, the runtime renders a "No App component found"
/// hint instead of leaving a blank page.
export async function runReact(files: WorkbenchFile[]): Promise<RunResult> {
  const started = Date.now();

  // Concat every JS-ish file in order. Most playground users will
  // edit a single App.jsx, but allowing extras (utils.js etc.) costs
  // nothing here and matches the multi-file affordance the request
  // explicitly asked for.
  const source = files
    .filter((f) => /\.(jsx?|tsx?)$/i.test(f.name))
    .map((f) => f.content)
    .join("\n\n");

  // Inline every CSS file into a single <style> block. We don't try to
  // honour scoped imports — plain global CSS is the playground's
  // simplest mental model, same as the `web` runtime.
  const css = files
    .filter((f) => f.language === "css")
    .map((f) => f.content)
    .join("\n\n");

  const html = buildPreviewHtml(source, css);

  const previewUrl = await presentPreview(html);

  return {
    logs: [],
    previewUrl,
    previewKind: "web",
    durationMs: Date.now() - started,
  };
}

/// Build the host HTML. Mirrors the layout of the reactnative runtime —
/// CDN-pinned React + Babel + a base64-stuffed user source — but mounts
/// via `createRoot` instead of `AppRegistry.runApplication`. Errors at
/// each phase (parse → factory build → render) are caught separately
/// so the iframe shows "phase: message" instead of a single opaque
/// SyntaxError.
function buildPreviewHtml(userSource: string, userCss: string): string {
  const sourceB64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(userSource)))
      : Buffer.from(userSource, "utf-8").toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fishbones — React preview</title>
  <style>
    html, body, #root { margin: 0; padding: 0; min-height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
      background: #0b0b10;
      color: #f5f5f7;
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
${userCss}
  </style>
  <!-- Vendored bundles served from the local Tauri preview server's
       /vendor route. See scripts/vendor-cdn-deps.mjs for the build
       step that produces them out of node_modules. -->
  <script src="/vendor/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import * as ReactMod from "/vendor/react.js";
    import { createRoot } from "/vendor/react-dom-client.js";
    const React = ReactMod.default || ReactMod;

    // Module top level can't \`return\` — wrap the whole runtime in an
    // IIFE so the early-exit-on-error pattern below works syntactically.
    // \`import\` statements have to stay at module top level (above
    // the IIFE) per the ES spec, but everything else slides in here.
    (() => {
    ${CONSOLE_SHIM}

    const source = atob("${sourceB64}");

    // Strip ES-module \`import\` / \`export\` statements: React + hooks
    // are bound into the factory's scope directly below, and leaving
    // \`import { useState } from 'react'\` would parse as a require()
    // after Babel transforms it, blowing up the new-Function eval.
    const cleaned = source
      .replace(/^\\s*import\\s[\\s\\S]+?;\\s*$/gm, "")
      .replace(/^\\s*export\\s+default\\s+function/m, "function")
      .replace(/^\\s*export\\s+default\\s+class/m, "class")
      .replace(/^\\s*export\\s+default\\s+/m, "const __appExport = ")
      .replace(/^\\s*export\\s+/gm, "");

    function showPhaseError(phase, err, _body) {
      const node = document.getElementById("__fishbones_error") || (() => {
        const n = document.createElement("pre");
        n.id = "__fishbones_error";
        document.body.appendChild(n);
        return n;
      })();
      const msg = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? err.stack : "";
      node.textContent = "[" + phase + "] " + msg + "\\n\\n" + stack;
    }

    // Phase 1: Babel parse + JSX transform.
    let transpiled;
    try {
      const out = Babel.transform(cleaned, {
        presets: [
          ["react", { runtime: "classic" }],
          ["typescript", { allExtensions: true, isTSX: true }],
        ],
        filename: "App.tsx",
        sourceType: "script",
      });
      transpiled = out.code;
    } catch (err) {
      showPhaseError("parse", err, cleaned);
      console.error("[babel parse]", err);
      return;
    }

    // Phase 2: build the factory wrapper. \`new Function\` rejects code
    // with brace mismatches before we ever try to render, which lets
    // the error pane show a real syntax message.
    let factory;
    try {
      factory = new Function(
        "React",
        [
          "const { Component, Fragment, StrictMode, useState, useEffect, useMemo, useCallback, useRef, useReducer, useContext, createContext, useLayoutEffect, useTransition, useDeferredValue, useId, useSyncExternalStore } = React;",
          "return (function __fishbonesUserModule() {",
          transpiled,
          "  return typeof App !== 'undefined' ? App : typeof __appExport !== 'undefined' ? __appExport : null;",
          "})();",
        ].join("\\n"),
      );
    } catch (err) {
      showPhaseError("build", err, transpiled);
      console.error("[factory build]", err);
      return;
    }

    // Phase 3: actually invoke the factory + render.
    let App;
    try {
      App = factory(React);
    } catch (err) {
      showPhaseError("evaluate", err, transpiled);
      console.error("[factory evaluate]", err);
      return;
    }

    if (!App) {
      showPhaseError(
        "missing-app",
        new Error("No \`App\` component declared. Define \`function App() { ... }\` or \`export default function ...\`."),
        cleaned,
      );
      return;
    }

    try {
      const root = createRoot(document.getElementById("root"));
      root.render(React.createElement(App));
    } catch (err) {
      showPhaseError("render", err, transpiled);
      console.error("[render]", err);
    }
    })();
  </script>
</body>
</html>`;
}

/// Console interceptor — same trick as the web runtime: forward log
/// calls from the iframe back to the parent window via postMessage so
/// the OutputPane can show them alongside the rendered DOM.
const CONSOLE_SHIM = `
(function(){
  const parentWin = window.parent;
  const post = (level, args) => {
    try {
      parentWin.postMessage({
        __fishbones: true,
        level,
        text: args.map(a => {
          if (a == null) return String(a);
          if (typeof a === "object") {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        }).join(" "),
      }, "*");
    } catch(e) { /* detached parent during reload */ }
  };
  for (const level of ["log","info","warn","error"]) {
    const orig = console[level];
    console[level] = function() {
      post(level, Array.from(arguments));
      orig.apply(console, arguments);
    };
  }
  window.addEventListener("error", (e) => {
    post("error", [e.message + " (" + (e.filename||"?") + ":" + (e.lineno||"?") + ")"]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    post("error", ["Unhandled promise rejection: " + (e.reason && e.reason.message || String(e.reason))]);
  });
})();
`;
