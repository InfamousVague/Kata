#!/usr/bin/env node
/// Vendor every CDN-loaded browser runtime into shipped resources so
/// Fishbones runs fully offline.
///
/// Inputs (npm-installed locally; see package.json):
///   - @babel/standalone  → babel.min.js
///   - react              → react.production.min.js (UMD)
///   - react-dom          → react-dom.production.min.js (UMD)
///   - react-native-web   → bundled to a single ESM via esbuild
///   - svelte             → bundled compiler + runtime ESMs via esbuild
///   - three              → three.module.js
///   - htmx.org           → htmx.min.js
///
/// Outputs (overwrites every run):
///   src-tauri/resources/vendor/<file>.js
///
/// Runtime contract: the iframe-hosted runtimes (RN preview, React /
/// Three.js / HTMX templates, Svelte) reference these files via
/// `<preview-server>/vendor/<filename>` — `preview_server.rs` reads
/// them out of the shipped resources dir. Keep filenames stable;
/// changing them breaks the runtime URL strings.

import { build } from "esbuild";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_MODULES = join(ROOT, "node_modules");
const OUT = join(ROOT, "src-tauri", "resources", "vendor");

async function ensureFresh() {
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
}

/// Plain copy — for files that already ship as a single self-contained
/// browser bundle (Babel standalone, React UMD, Three's ESM, htmx).
/// Keeps filenames consistent so the runtime URLs are stable across
/// rebuilds.
async function copyOne(srcRel, dstName) {
  const src = join(NODE_MODULES, srcRel);
  const dst = join(OUT, dstName);
  await cp(src, dst);
  const sizeKb = (await readFile(dst)).byteLength / 1024;
  console.log(`  copy   ${dstName}  (${sizeKb.toFixed(0)} KB)`);
}

/// esbuild a single-entrypoint package into a self-contained ESM
/// bundle. Used for react-native-web (which ships ESM modules but
/// expects a bundler) and svelte (compiler + runtime).
///
/// `external` deps are inlined — this is a STANDALONE bundle, the
/// browser has nothing else to import. React + react-dom are inlined
/// for react-native-web because the runtime imports them via plain
/// `import "react"` paths.
async function bundle(entry, dstName, opts = {}) {
  const dst = join(OUT, dstName);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    outfile: dst,
    // RN-web has heavy CommonJS deps. Let esbuild rewrite them.
    platform: "browser",
    define: {
      // RN-web has a `process.env.NODE_ENV` check — pin to production
      // so dev-only warnings + invariants get tree-shaken out.
      "process.env.NODE_ENV": '"production"',
      "process.env.JEST_WORKER_ID": "undefined",
      // Some dep imports check for `global` (the Node globals
      // shim). Map to `globalThis` so the bundle runs under a real
      // browser without polyfills.
      global: "globalThis",
    },
    // Strip dev-only dependency. RN-web pulls in @babel/runtime — the
    // bundle is much smaller without re-bundling babel-helpers and
    // it's not needed at runtime since the app's JSX is already
    // transformed by Babel-standalone before reaching RN-web.
    ...opts,
  });
  const sizeKb = (await readFile(dst)).byteLength / 1024;
  console.log(`  bundle ${dstName}  (${sizeKb.toFixed(0)} KB)`);
}

async function main() {
  console.log(`vendor-cdn-deps → ${OUT}`);
  await ensureFresh();

  // ---- Trivial copies (already browser-ready bundles) ----
  await copyOne(
    "@babel/standalone/babel.min.js",
    "babel.min.js",
  );
  // React 19 dropped UMD bundles; bundle the npm entrypoint instead.
  // Output ESM so the iframe can `import` it natively.
  await bundle(
    join(NODE_MODULES, "react/index.js"),
    "react.js",
  );
  await bundle(
    join(NODE_MODULES, "react-dom/client.js"),
    "react-dom-client.js",
  );
  await copyOne("three/build/three.module.js", "three.module.js");
  await copyOne("htmx.org/dist/htmx.min.js", "htmx.min.js");

  // ---- React-Native-Web bundle ----
  // RN-web's npm entrypoint imports React + react-dom via bare
  // specifiers. The CDN (esm.sh) pre-resolves those to peer URLs;
  // for the offline build we inline the whole tree into one ESM.
  // Result: a ~600KB ESM that exports every RN component the
  // runtime references (View, Text, Pressable, AppRegistry, etc).
  await bundle(
    join(NODE_MODULES, "react-native-web/dist/index.js"),
    "react-native-web.js",
  );

  // ---- Svelte bundles ----
  // Compiler is the heavy one (parses .svelte → JS); runtime is
  // the small reactive primitives the compiled output imports.
  // We split them so the playground can lazy-load only the
  // compiler when it needs to recompile + use the cached runtime
  // for re-mounts. Both are produced as ESM so the Svelte
  // playground can `import("/vendor/svelte-compiler.js")`.
  await bundle(
    join(NODE_MODULES, "svelte/compiler/index.js"),
    "svelte-compiler.js",
  );
  await bundle(
    join(NODE_MODULES, "svelte/src/index-client.js"),
    "svelte-runtime.js",
  );
  // Svelte 5 compiled output references a few internal modules by
  // import path — `svelte/internal/disclose-version`,
  // `svelte/internal/client`, `svelte/internal/flags/legacy`,
  // `svelte/legacy`. Bundle each into its own file under vendor/
  // so the runtime URL rewriter can substitute relative paths
  // matching the compiled output's expectations.
  await bundle(
    join(NODE_MODULES, "svelte/src/internal/disclose-version.js"),
    "svelte-internal-disclose-version.js",
  );
  await bundle(
    join(NODE_MODULES, "svelte/src/internal/client/index.js"),
    "svelte-internal-client.js",
  );
  await bundle(
    join(NODE_MODULES, "svelte/src/internal/flags/legacy.js"),
    "svelte-internal-flags-legacy.js",
  );
  await bundle(
    join(NODE_MODULES, "svelte/src/legacy/legacy-client.js"),
    "svelte-legacy.js",
  );

  // ---- Manifest ----
  // Drop a marker file into vendor/ so we can sanity-check at
  // runtime that the resource dir was shipped correctly. Format:
  // one line per file with size in bytes — enough to detect "no
  // vendor dir at all" or "incomplete bundle" without needing a
  // hashing pass.
  const manifest = await Promise.all(
    [
      "babel.min.js",
      "react.js",
      "react-dom-client.js",
      "react-native-web.js",
      "three.module.js",
      "htmx.min.js",
      "svelte-compiler.js",
      "svelte-runtime.js",
      "svelte-internal-disclose-version.js",
      "svelte-internal-client.js",
      "svelte-internal-flags-legacy.js",
      "svelte-legacy.js",
    ].map(async (f) => `${f}\t${(await readFile(join(OUT, f))).byteLength}`),
  );
  await writeFile(join(OUT, "manifest.txt"), manifest.join("\n") + "\n");

  console.log("\nvendor-cdn-deps OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
