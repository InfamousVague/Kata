import type { WorkbenchFile } from "../data/types";
import type { RunResult } from "./types";
import { presentPreview } from "../lib/preview";

/// Svelte 5 runtime — assembles an HTML shell that pulls in the Svelte
/// compiler + runtime from esm.sh, compiles the learner's `App.svelte`
/// in the browser, and mounts the result via the Svelte 5 `mount()`
/// API. Output is served from the local Tauri preview server, same
/// path the React Native runtime uses, so the playground's iframe +
/// the QR / external-browser flow both work without any extra
/// plumbing.
///
/// The compile-in-browser approach is identical to the official
/// Svelte REPL — Svelte ships its compiler as a small ESM module
/// that converts `.svelte` source into a JS class+CSS pair we can
/// `import()` via a Blob URL.

export async function runSvelte(files: WorkbenchFile[]): Promise<RunResult> {
  const started = Date.now();

  // Pick the primary `.svelte` file. Conventionally `App.svelte` but
  // we accept any `.svelte` source so the learner can rename freely.
  // Falls back to the first file if there's nothing svelte-flavored
  // (rare; the playground keeps at least one file present).
  const source =
    files.find((f) => /\.svelte$/i.test(f.name))?.content ??
    files[0]?.content ??
    "";

  const html = buildPreviewHtml(source);

  const previewUrl = await presentPreview(html);

  return {
    logs: [],
    previewUrl,
    // Reuse the reactnative previewKind so OutputPane + FloatingPhone
    // already-wired iframe path renders this without further plumbing.
    // Svelte 5 isn't a "phone" runtime per se but the same iframe-
    // sandbox + URL-server approach applies, and the previewKind only
    // controls which dev-tools panel attaches alongside (we'd add a
    // svelte-specific one later if needed).
    previewKind: "reactnative",
    durationMs: Date.now() - started,
  };
}

function buildPreviewHtml(svelteSource: string): string {
  const sourceB64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(svelteSource)))
      : Buffer.from(svelteSource, "utf-8").toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>Fishbones — Svelte 5 preview</title>
  <style>
    html, body, #app { margin: 0; padding: 0; height: 100%; width: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
      background: #15151c;
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
    #__fishbones_boot {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      color: #6a6a78;
      font: 12px/1.5 "SF Mono", ui-monospace, Menlo, monospace;
      text-align: center;
      pointer-events: none;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div id="__fishbones_boot">booting svelte preview…</div>
  <div id="app"></div>
  <script type="module">
    function showError(label, err) {
      var name = err && err.name ? err.name : "Error";
      var msg = err && err.message ? err.message : String(err);
      var stack = err && err.stack ? err.stack : "(no stack)";
      var pre = document.getElementById("__fishbones_error");
      if (!pre) {
        pre = document.createElement("pre");
        pre.id = "__fishbones_error";
        document.body.appendChild(pre);
      }
      pre.textContent = "[" + label + "] " + name + ": " + msg + "\\n\\n" + stack;
    }
    function bootStage(text) {
      var el = document.getElementById("__fishbones_boot");
      if (el) el.textContent = text;
    }
    window.addEventListener("error", (e) => {
      showError("uncaught", e.error || new Error(e.message || "Script error"));
    });
    window.addEventListener("unhandledrejection", (e) => {
      showError("unhandled-rejection", e.reason || new Error(String(e.reason)));
    });

    bootStage("loading svelte compiler + runtime…");

    (async function bootPreview() {
      let compile, mount, unmount;
      try {
        // Vendored Svelte bundles served from the local Tauri preview
        // server's /vendor route. See scripts/vendor-cdn-deps.mjs.
        //
        // Svelte's compiler is CJS — esbuild's ESM bundler emits the
        // entire module as a single \`default\` export rather than
        // re-exporting every named function. Read through default
        // when present (production case) and fall back to the
        // namespace itself for the rare legitimate-ESM-source path.
        const compilerMod = await import("/vendor/svelte-compiler.js");
        const compiler = compilerMod.default ?? compilerMod;
        compile = compiler.compile;
        if (typeof compile !== "function") {
          throw new Error(
            "vendored svelte-compiler.js is missing a 'compile' export — re-run scripts/vendor-cdn-deps.mjs"
          );
        }
        const runtimeMod = await import("/vendor/svelte-runtime.js");
        const runtime = runtimeMod.default ?? runtimeMod;
        mount = runtime.mount;
        unmount = runtime.unmount;
        if (typeof mount !== "function") {
          throw new Error(
            "vendored svelte-runtime.js is missing a 'mount' export — re-run scripts/vendor-cdn-deps.mjs"
          );
        }
      } catch (err) {
        showError("imports", err);
        return;
      }

      bootStage("compiling component…");

      const source = atob("${sourceB64}");

      let compiled;
      try {
        compiled = compile(source, {
          name: "App",
          generate: "client",
          dev: false,
          // CSS gets injected as a string; we splice it into a <style>
          // tag below. The default "external" mode would expect us to
          // load a separate file which doesn't fit our single-document
          // preview shape.
          css: "injected",
        });
      } catch (err) {
        showError("compile", err);
        return;
      }

      bootStage("evaluating compiled module…");

      // The compiled JS imports from "svelte" / "svelte/internal/client"
      // / "svelte/internal/disclose-version" / "svelte/internal/flags/legacy"
      // / "svelte/legacy". Rewrite those bare-spec imports to vendored
      // /vendor/*.js URLs so the dynamic-import below can fetch them at
      // run time.
      //
      // CRITICAL: Svelte 5 emits TWO shapes of import for these paths
      //   1. side-effect:  import 'svelte/internal/disclose-version';
      //   2. named:        import * as $ from 'svelte/internal/client';
      // Earlier we only matched the "from" form (#2), so the disclose-
      // version import leaked through and the browser tried to resolve
      // it as a URL — failing with
      //   TypeError: Module name, 'svelte/internal/disclose-version'
      //              does not resolve to a valid URL.
      // We now match both \`(import|from) "X"\` and \`(import|from) 'X'\`.
      //
      // Order matters — match the most specific paths first so the bare
      // "svelte" rule doesn't hijack "svelte/internal/client".
      const rewriteImport = (code, spec, vendorPath) => {
        const escaped = spec.replace(/[/.]/g, "\\\\$&");
        const re = new RegExp(
          "(\\\\bimport|\\\\bfrom)(\\\\s+)([\\"'])" + escaped + "\\\\3",
          "g"
        );
        return code.replace(re, '$1$2$3' + vendorPath + '$3');
      };
      let rewritten = compiled.js.code;
      rewritten = rewriteImport(rewritten,
        "svelte/internal/disclose-version",
        "/vendor/svelte-internal-disclose-version.js");
      rewritten = rewriteImport(rewritten,
        "svelte/internal/flags/legacy",
        "/vendor/svelte-internal-flags-legacy.js");
      rewritten = rewriteImport(rewritten,
        "svelte/internal/client",
        "/vendor/svelte-internal-client.js");
      rewritten = rewriteImport(rewritten,
        "svelte/legacy",
        "/vendor/svelte-legacy.js");
      rewritten = rewriteImport(rewritten,
        "svelte",
        "/vendor/svelte-runtime.js");

      // Build a Blob-URL module out of the rewritten compiled code
      // and dynamic-import it. The default export is the component
      // class (or factory in Svelte 5) we hand to mount().
      const blob = new Blob([rewritten], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);

      let App;
      try {
        const mod = await import(/* @vite-ignore */ url);
        App = mod.default;
      } catch (err) {
        URL.revokeObjectURL(url);
        showError("module-load", err);
        return;
      }

      // Inject the component's CSS (if any) into the document head so
      // <style> blocks in the .svelte source actually take effect.
      if (compiled.css && compiled.css.code) {
        const style = document.createElement("style");
        style.textContent = compiled.css.code;
        document.head.appendChild(style);
      }

      try {
        mount(App, { target: document.getElementById("app") });
        const boot = document.getElementById("__fishbones_boot");
        if (boot) boot.remove();
      } catch (err) {
        showError("mount", err);
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((err) => {
      showError("boot", err);
    });
  </script>
</body>
</html>`;
}
