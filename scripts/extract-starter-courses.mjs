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

/// Per-language gradient palette for the synthetic-cover fallback.
/// Mirrors `.fishbones-book--lang-*--no-cover` in BookCover.css so a
/// generated JPEG looks visually consistent with the in-app
/// language-tinted tiles. Tuple shape: `[topColor, bottomColor]`.
/// Languages not in this map fall back to a neutral dark gradient.
const LANG_GRADIENTS = {
  javascript: ["#4e432a", "#262013"],
  typescript: ["#3178c6", "#1a3d6e"],
  python: ["#1f3b5a", "#101d2d"],
  rust: ["#6b2f1e", "#2d140c"],
  swift: ["#6b2b2b", "#2d1212"],
  go: ["#204f5e", "#0e2630"],
  bun: ["#3d3520", "#1d180c"],
  svelte: ["#5c2a16", "#2a120a"],
  solid: ["#1c4d6b", "#0e2535"],
  htmx: ["#3a4252", "#1a1f29"],
  astro: ["#3a2a4d", "#1a0f26"],
  solidity: ["#3a3a3a", "#1a1a1a"],
  reactnative: ["#1c4357", "#0e2330"],
  react: ["#1c4357", "#0e2330"],
  threejs: ["#2d2d2d", "#0c0c0c"],
};

const LANG_GLYPHS = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  rust: "RS",
  swift: "SW",
  go: "GO",
  bun: "BN",
  svelte: "SV",
  solid: "SO",
  htmx: "HX",
  astro: "AS",
  solidity: "SL",
  reactnative: "RN",
  react: "RX",
  threejs: "3D",
  c: "C",
  cpp: "C++",
  java: "JV",
  kotlin: "KT",
  csharp: "C#",
  assembly: "ASM",
};

/// Find a usable .ttf font path. ImageMagick on macOS can't load
/// the system .ttc font collections by name; on Ubuntu it relies on
/// fontconfig which may or may not be set up. Plain .ttf files
/// always work, so we probe the standard locations and use the
/// first one that exists. Returns null when nothing's available
/// (caller skips synthesis in that case).
let cachedFontPath = null;
function pickFontPath() {
  if (cachedFontPath !== null) return cachedFontPath || null;
  const candidates = [
    // macOS — SFNS is always present, ships with every install.
    "/System/Library/Fonts/SFNS.ttf",
    // Ubuntu / Debian — DejaVu is the apt-get default; Liberation
    // ships with most server images via `fonts-liberation`.
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    // Fallback: Noto, often pulled in as a dependency.
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      cachedFontPath = path;
      return path;
    }
  }
  cachedFontPath = "";
  return null;
}

/// Synthesise a themed JPEG cover for a pack that doesn't ship its
/// own cover.png. Renders a 320×480 (book-ratio) gradient using the
/// language palette, with the language abbreviation big in the
/// upper third and the course title wrapped below. Visual goal:
/// consistent with the in-app `.fishbones-book--no-cover` fallback
/// so the library shelf reads as one continuous design language —
/// real cover artwork blends with synthetic tiles without an
/// obvious style break.
///
/// Only ImageMagick supports the gradient + caption: composition we
/// need; sips can't do it. So this only fires when magick / convert
/// is available AND we can find a usable .ttf for the text — falls
/// back to no cover otherwise.
function synthesizeCover(language, title, dstJpg) {
  const impl = pickResizeImpl();
  if (impl !== "magick" && impl !== "convert") return false;
  const fontPath = pickFontPath();
  if (!fontPath) return false;
  const [top, bottom] = LANG_GRADIENTS[language] ?? ["#2a2a2a", "#0c0c0c"];
  const glyph = LANG_GLYPHS[language] ?? "·";
  // Trim the title to fit a 2-3 line caption block. ImageMagick's
  // caption: pseudo-image auto-wraps to fit a fixed width, but
  // long titles can overflow vertically; cap at ~60 chars.
  const trimmed = title.length > 60 ? title.slice(0, 57) + "…" : title;
  try {
    execFileSync(impl, [
      "-size", "320x480",
      // Top-bottom gradient with the language palette.
      `gradient:${top}-${bottom}`,
      // Glyph — big, upper third, soft white.
      "-gravity", "north",
      "-fill", "rgba(255,255,255,0.92)",
      "-font", fontPath,
      "-pointsize", "120",
      "-annotate", "+0+90", glyph,
      // Subtitle — language name in the gutter under the glyph.
      "-pointsize", "16",
      "-fill", "rgba(255,255,255,0.6)",
      "-annotate", "+0+230", language.toUpperCase(),
      // Title — wraps inside a 280×140 caption: pseudo-image, then
      // composites onto the gradient at the lower section. Using
      // caption: instead of -annotate gets us word wrapping for free.
      "(", "-size", "280x140",
      "-gravity", "center",
      "-fill", "white",
      "-font", fontPath,
      "-pointsize", "22",
      `caption:${trimmed}`, ")",
      "-gravity", "south",
      "-geometry", "+0+40",
      "-composite",
      // Drop EXIF + interlace + quality to match the resize step.
      "-strip",
      "-interlace", "Plane",
      "-quality", "82",
      dstJpg,
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
/// Manual cover overrides. A PNG at `cover-overrides/<pack-id>.png`
/// wins over both the in-zip `cover.png` AND the language-tinted
/// synthesiser. This is how we ship freshly-generated artwork for
/// packs whose .fishbones zip predates the cover (we don't want to
/// re-zip every time a designer re-runs the cover gen). Drop the
/// PNG in, run `node scripts/extract-starter-courses.mjs`, commit
/// both the override PNG and the resulting JPEG. The override path
/// also lets a stale or off-style in-zip cover be quietly replaced
/// without touching the source pack.
const COVER_OVERRIDES = join(ROOT, "cover-overrides");

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
// IDs match the .fishbones filename without the extension. The
// canonical source for these archives is `X10 Pro/FishbonesCourses/`,
// which uses descriptive slugs (e.g. `bun-the-complete-runtime` rather
// than the older `bun-complete`). Keep this list in sync with the
// promotion script's bundled-packs directory.
const PACK_IDS = [
  // ── Languages-as-a-foundation books ────────────────────────────
  // Long-form books that teach a language end-to-end. Order here is
  // the order the library renders them on first launch.
  "the-rust-programming-language",
  "rust-by-example",
  "the-async-book-rust",
  "the-rustonomicon",
  "eloquent-javascript",
  "the-modern-javascript-tutorial-fundamentals",
  "javascript-the-definitive-guide",
  "you-don-t-know-js-yet",
  "composing-programs",
  "python-crash-course",
  "learning-go",

  // ── Computer-science fundamentals ──────────────────────────────
  "algorithms-erickson",
  "open-data-structures",
  "crafting-interpreters-javascript",
  "pro-git",

  // ── Frameworks + libraries ─────────────────────────────────────
  "learning-svelte",
  "solidjs-fundamentals",
  "htmx-fundamentals",
  "astro-fundamentals",
  "bun-the-complete-runtime",
  "react-native",
  "learning-react-native",
  "fluent-react",
  "tauri-2-fundamentals",
  "interactive-web-development-with-three-js-and-a-frame",

  // ── Smart-contract / web3 / crypto ─────────────────────────────
  "mastering-bitcoin",
  "programming-bitcoin",
  "mastering-ethereum",
  "mastering-lightning-network",
  "solidity-smart-contracts-from-first-principles",
  "vyper-fundamentals-pythonic-smart-contracts",
  "solana-programs-rust-on-the-svm",
  "viem-and-ethers-js-talking-to-ethereum-from-typescript",
  "cryptography-fundamentals-hashes-to-zk",

  // ── Challenge packs ───────────────────────────────────────────
  // One per browser-runnable language. Assembly / C / C++ / C# /
  // Java / Kotlin / Swift live in the desktop bundle but stay out
  // of the web set because their runtimes need a system compiler.
  "javascript-challenges",
  "typescript-challenge-pack",
  "python-challenges",
  "go-challenges",
  "rust-challenges",
  "react-native-challenges",
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

      // Cover art — three-tier lookup, first match wins:
      //   1. cover-overrides/<id>.png — manual designer drop-in.
      //      Lets us replace stale or missing in-zip covers without
      //      re-zipping the .fishbones (which often invalidates the
      //      pack's checksum on disk).
      //   2. cover.png inside the .fishbones zip — the historical
      //      home for course artwork, set when the pack was first
      //      authored.
      //   3. synthesiseCover() — language-tinted gradient + caption.
      //      Last-resort so the library shelf still reads as a
      //      continuous design rather than a mix of real covers +
      //      missing-image squares.
      // All three converge on the same 480px JPEG q78 output so
      // downstream consumers (web manifest, kata library shelf) don't
      // care which path produced it.
      const overridePath = join(COVER_OVERRIDES, `${id}.png`);
      const inZipPath = join(work, "cover.png");
      const candidate = `${id}.jpg`;
      const dst = join(OUT, candidate);
      let coverFile;
      let coverSource;
      if (existsSync(overridePath) && resizeCover(overridePath, dst)) {
        coverFile = candidate;
        coverSource = "override";
      } else if (existsSync(inZipPath) && resizeCover(inZipPath, dst)) {
        coverFile = candidate;
        coverSource = "pack";
      } else if (synthesizeCover(course.language || "javascript", course.title || id, dst)) {
        coverFile = candidate;
        coverSource = "synth";
        console.log(
          `  ↳ synthesised themed cover for ${id} (${course.language})`,
        );
      }

      // Normalise the editorial tier into the manifest so the
      // marketing site (fishbones.academy) can group cards by tier
      // without having to fetch each course's full JSON. Legacy
      // `PRE-RELEASE` collapses to `UNREVIEWED` to match the renamed
      // pipeline. Anything missing or unrecognised falls back to
      // `UNREVIEWED` so books default into the bottom section.
      const rawStatus = course.releaseStatus;
      const releaseStatus =
        rawStatus === "BETA" || rawStatus === "ALPHA"
          ? rawStatus
          : "UNREVIEWED";

      manifest.push({
        id: course.id || id,
        title: course.title || id,
        language: course.language,
        file: `${id}.json`,
        cover: coverFile,
        sizeBytes: info.size,
        packType: course.packType || "course",
        releaseStatus,
      });
      console.log(
        `[starter-courses] staged ${id} (${(info.size / 1024).toFixed(0)} KB)` +
          (coverFile ? ` + cover [${coverSource}]` : ""),
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
