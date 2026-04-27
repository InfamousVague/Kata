#!/usr/bin/env node
/// Extract a curated subset of the bundled .fishbones packs into
/// `public/starter-courses/` so the web build can fetch them at
/// first-launch and seed IndexedDB.
///
/// We only ship packs whose primary language has a browser-native
/// runtime — anything that needs a system compiler (C / C++ / Java /
/// Kotlin / C# / Assembly / Swift) gets skipped because the web
/// build can't run those lessons anyway. SvelteKit is also skipped
/// (Node sidecar required); plain Svelte 5 CSR works in-browser via
/// the vendored compiler.
///
/// Output:
///   public/starter-courses/manifest.json   — list of {id,title,language,file,size}
///   public/starter-courses/<id>.json       — the full course JSON
///
/// Idempotent: deletes + recreates the directory each run so a pack
/// removed from PACK_IDS doesn't ghost in production. Run once before
/// `vite build` for the web variant; chained automatically by
/// `npm run vendor:web`.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

/// Cover-resize helper. The bundled covers are ~3-4MB unoptimised
/// PNGs (extracted as cover images by the desktop app's
/// `load_course_cover` Tauri command). Shipping 24 of those on a
/// static deploy = ~85MB blob just for thumbnails — wasteful.
///
/// We resize each cover to 480px wide JPEG, quality 78. Result:
/// ~30-70KB per cover, total ~1-1.5MB for the 24-course starter
/// set. Quality is more than enough for the BookCover component
/// which renders at ~150-200px in the library grid.
///
/// Cross-platform tool detection: macOS has `sips` built in,
/// Ubuntu CI runners have `magick` (ImageMagick 7) and/or
/// `convert` (ImageMagick legacy). We try in that order and
/// skip cover output if none are available.
let cachedResizeImpl = null;
function pickResizeImpl() {
  if (cachedResizeImpl !== null) return cachedResizeImpl;
  for (const probe of [
    { cmd: "magick", args: ["-version"] },
    { cmd: "convert", args: ["-version"] },
    { cmd: "sips", args: ["--help"] },
  ]) {
    try {
      execFileSync(probe.cmd, probe.args, { stdio: "ignore" });
      cachedResizeImpl = probe.cmd;
      return probe.cmd;
    } catch {
      // Not installed — try next.
    }
  }
  cachedResizeImpl = "";
  return "";
}

function resizeCover(srcPng, dstJpg) {
  const impl = pickResizeImpl();
  if (!impl) return false;
  try {
    if (impl === "magick" || impl === "convert") {
      // ImageMagick — same args for both the `magick` (v7) and
      // `convert` (legacy) commands. `-resize 480x>` only shrinks
      // (the `>` qualifier means "resize only if larger");
      // `-strip` drops EXIF; `-interlace Plane` produces a
      // progressive JPEG so the cover paints faster on slow
      // connections.
      execFileSync(impl, [
        srcPng,
        "-resize", "480x>",
        "-strip",
        "-interlace", "Plane",
        "-quality", "78",
        dstJpg,
      ], { stdio: "ignore" });
    } else if (impl === "sips") {
      // macOS sips: -Z is "resize-only-if-larger".
      execFileSync(impl, [
        "-Z", "480",
        "-s", "format", "jpeg",
        "-s", "formatOptions", "78",
        srcPng,
        "--out", dstJpg,
      ], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

let warnedNoResizer = false;
function warnIfNoResizer() {
  if (warnedNoResizer) return;
  if (pickResizeImpl()) return;
  warnedNoResizer = true;
  console.warn(
    "[starter-courses] no image resizer found (tried `magick`, " +
      "`convert`, `sips`). Cover art will be SKIPPED on this run — " +
      "install imagemagick for production builds.",
  );
}
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PACKS_DIR = join(ROOT, "src-tauri", "resources", "bundled-packs");
const OUT = join(ROOT, "public", "starter-courses");

/// Curated browser-compatible starter set. IDs match the .fishbones
/// filenames (without the extension). Order here is the order the
/// library renders them in on first launch.
///
/// Curation rules for what makes the cut:
///   - Primary language is browser-runnable (per platform.ts canRun)
///     — JS, TS, Python, web, three.js, React, RN, Svelte, Solid,
///     HTMX, Astro, Bun, Tauri-as-Rust, Solidity. Rust + Go are
///     also OK because their runtimes proxy to the public playgrounds
///     over HTTP.
///   - Excluded: anything needing a system compiler (C, C++, Java,
///     Kotlin, C#, Assembly, Swift, SvelteKit's Node sidecar). Those
///     stay desktop-only.
const PACK_IDS = [
  // Languages-as-a-foundation books
  "javascript-crash-course",
  "python-crash-course",
  "javascript-the-definitive-guide",

  // Frameworks + libraries
  "svelte-5-complete",
  "solidjs-fundamentals",
  "fluent-react",
  "htmx-fundamentals",
  "astro-fundamentals",
  "bun-fundamentals",
  "bun-complete",
  "learning-react-native",
  "react-native",
  "interactive-web-development-with-three-js-and-a-frame",

  // Smart-contract / web3
  "solidity-complete",
  "solana-programs",
  "viem-ethers",

  // Languages-via-playground (no local toolchain needed)
  "learning-go",

  // Challenge packs — one per browser-runnable language
  "challenges-javascript-handwritten",
  "challenges-typescript-mo9c9k2o",
  "challenges-python-handwritten",
  "challenges-go-handwritten",
  "challenges-rust-handwritten",
  "challenges-reactnative-handwritten",
  "challenges-reactnative-visual",
];

async function main() {
  if (!existsSync(PACKS_DIR)) {
    console.error(
      `[starter-courses] expected packs dir at ${PACKS_DIR} — is the kata repo intact?`,
    );
    process.exit(1);
  }

  // Fresh slate each run.
  if (existsSync(OUT)) {
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(OUT, { recursive: true });

  // Surface the missing-resizer warning ONCE up-front rather than
  // burying it in `+ cover.png` absences across 22 lines.
  warnIfNoResizer();

  const manifest = [];
  for (const id of PACK_IDS) {
    const packPath = join(PACKS_DIR, `${id}.fishbones`);
    if (!existsSync(packPath)) {
      console.warn(`[starter-courses] missing pack: ${packPath}, skipping`);
      continue;
    }

    // .fishbones is a zip — use the system `unzip` (BSD on macOS,
    // InfoZIP on Linux; both ship by default on the GitHub Actions
    // ubuntu image). Avoids pulling in a JS zip library just for
    // five files at build time.
    const work = await mkdtemp(join(tmpdir(), "fb-starter-"));
    try {
      execFileSync("unzip", ["-q", packPath, "-d", work], { stdio: "pipe" });
      const courseJsonPath = join(work, "course.json");
      if (!existsSync(courseJsonPath)) {
        console.warn(
          `[starter-courses] no course.json inside ${id}.fishbones, skipping`,
        );
        continue;
      }
      const courseJson = await readFile(courseJsonPath, "utf-8");
      const course = JSON.parse(courseJson);

      const outFile = join(OUT, `${id}.json`);
      await writeFile(outFile, courseJson, "utf-8");
      const info = await stat(outFile);

      // Cover art — resize to 480px JPEG q78 (~30-70KB) before
      // shipping. The bundled originals are ~3-4MB each; without
      // resize, 24 covers = ~85MB on the deploy. With resize:
      // ~1MB total. See `resizeCover` for the cross-platform
      // tooling fallbacks.
      const coverPath = join(work, "cover.png");
      let coverFile;
      if (existsSync(coverPath)) {
        const candidate = `${id}.jpg`;
        const dst = join(OUT, candidate);
        if (resizeCover(coverPath, dst)) {
          coverFile = candidate;
        } else {
          // No resizer available — skip the cover rather than
          // ship the 4MB original. The library falls back to a
          // language-tinted glyph when `cover` is absent.
        }
      }

      manifest.push({
        id: course.id || id,
        title: course.title || id,
        language: course.language,
        file: `${id}.json`,
        cover: coverFile,
        sizeBytes: info.size,
        packType: course.packType || "course",
      });
      console.log(
        `[starter-courses] staged ${id} (${(info.size / 1024).toFixed(0)} KB)` +
          (coverFile ? " + cover.png" : ""),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  await writeFile(
    join(OUT, "manifest.json"),
    JSON.stringify({ version: 1, courses: manifest }, null, 2),
    "utf-8",
  );
  console.log(
    `[starter-courses] wrote manifest with ${manifest.length} courses`,
  );
}

main().catch((err) => {
  console.error("[starter-courses] failed:", err);
  process.exit(1);
});
