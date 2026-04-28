#!/usr/bin/env node
/// Sync drilled course JSON back into:
///   1. `src-tauri/resources/bundled-packs/<id>.fishbones` — the
///      .fishbones zip archives that ship inside the app bundle.
///      Repacked with the updated course.json so a fresh install
///      seeds with drills included.
///   2. `~/Library/Application Support/com.mattssoftware.kata/courses/<id>/course.json`
///      — the desktop's already-seeded courses dir, so THIS user
///      (who has launched the desktop app before) sees the drills
///      on their next desktop launch without resetting state.
///
/// Source of truth: `public/starter-courses/<id>.json` (post-merge,
/// post-Shiki-prerender). That's where the authoring agents +
/// merge-micropuzzle-sidecars.mjs land their work, so we mirror
/// from there outward.
///
/// Run AFTER:
///   - authoring agents have written sidecars to `.cache/micropuzzles/`
///   - `node scripts/merge-micropuzzle-sidecars.mjs` has merged + pre-rendered
///
/// Run BEFORE:
///   - The next desktop launch (so `ensure_seed` doesn't overwrite —
///     actually `ensure_seed` skips already-extracted courses, so
///     the order doesn't matter for desktop, but the .fishbones
///     repack matters for fresh installs going forward).
///   - The next iOS sim build, if you want the iPhone build to ship
///     with the new drills.

import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  copyFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STAGED = join(ROOT, "public", "starter-courses");
const PACKS_DIR = join(ROOT, "src-tauri", "resources", "bundled-packs");
const COVER_OVERRIDES = join(ROOT, "cover-overrides");
/// macOS path. The desktop bundle id stayed `com.mattssoftware.kata`
/// even after the rename for back-compat with existing installs.
const DESKTOP_COURSES_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "com.mattssoftware.kata",
  "courses",
);

const args = parseArgs(process.argv.slice(2));

async function main() {
  if (!existsSync(STAGED)) {
    console.error(
      `[sync-drills-to-local] no staged courses at ${STAGED} — run the merge step first.`,
    );
    process.exit(1);
  }
  const stagedFiles = (await readdir(STAGED)).filter(
    (f) => f.endsWith(".json") && f !== "manifest.json",
  );

  // Filter to one course if --course was passed.
  const targets = args.course
    ? stagedFiles.filter((f) => f === `${args.course}.json`)
    : stagedFiles;

  if (targets.length === 0) {
    console.error(
      `[sync-drills-to-local] no staged courses match`,
      args.course ? `--course=${args.course}` : "",
    );
    process.exit(1);
  }

  const seedingDesktop = existsSync(DESKTOP_COURSES_DIR);
  if (!seedingDesktop) {
    console.warn(
      `[sync-drills-to-local] desktop courses dir missing: ${DESKTOP_COURSES_DIR}`,
    );
    console.warn(
      `[sync-drills-to-local] (skipping desktop seed update — only repacking bundled-packs)`,
    );
  }

  let totalRepacked = 0;
  let totalDesktopUpdated = 0;
  let totalCardsCounted = 0;

  for (const f of targets) {
    const courseId = f.replace(/\.json$/, "");
    const stagedPath = join(STAGED, f);
    const courseJson = await readFile(stagedPath, "utf-8");
    const course = JSON.parse(courseJson);

    // Count drill cards for the report (purely informational).
    let cards = 0;
    for (const ch of course.chapters || []) {
      for (const l of ch.lessons || []) {
        if (l.kind === "micropuzzle") cards += l.challenges?.length || 0;
      }
    }
    totalCardsCounted += cards;

    // ── 1. Repack the .fishbones archive. ─────────────────────
    const packPath = join(PACKS_DIR, `${courseId}.fishbones`);
    if (!existsSync(packPath)) {
      console.warn(
        `  ⚠ ${courseId.padEnd(38)} no bundled-packs entry, skipping repack`,
      );
    } else {
      try {
        await repackFishbones(packPath, course, courseId);
        const size = (await stat(packPath)).size;
        console.log(
          `  ✓ repacked ${courseId.padEnd(34)} ${(size / 1024).toFixed(0)} KB${cards ? ` (${cards} drill cards)` : ""}`,
        );
        totalRepacked += 1;
      } catch (e) {
        console.warn(`  ✗ repack ${courseId} failed: ${e.message?.slice(0, 120)}`);
      }
    }

    // ── 2. Update the desktop's seeded courses dir. ──────────
    if (seedingDesktop) {
      const dst = join(DESKTOP_COURSES_DIR, courseId);
      if (existsSync(dst)) {
        try {
          await writeFile(
            join(dst, "course.json"),
            JSON.stringify(course, null, 2),
            "utf-8",
          );
          totalDesktopUpdated += 1;
        } catch (e) {
          console.warn(
            `  ✗ desktop update ${courseId} failed: ${e.message?.slice(0, 120)}`,
          );
        }
      }
      // If the desktop hasn't seeded this course yet, we don't
      // forcibly create it — `ensure_seed` will pick it up from
      // the freshly-repacked .fishbones on the next launch.
    }
  }

  console.log("");
  console.log(
    `[sync-drills-to-local] repacked ${totalRepacked} archive(s), updated ${totalDesktopUpdated} desktop course(s) — ${totalCardsCounted} drill cards total`,
  );
  if (seedingDesktop && totalDesktopUpdated > 0) {
    console.log(
      `[sync-drills-to-local] restart the desktop Fishbones app to pick up the new drills`,
    );
  }
}

/// Rewrite a .fishbones zip with a new course.json (and optionally
/// re-injecting the cover.png from cover-overrides/<id>.png if
/// present, so we don't lose the cover when re-zipping). All other
/// entries in the original zip are preserved verbatim.
async function repackFishbones(packPath, course, courseId) {
  // Use system unzip + zip — they ship on macOS and Linux. Avoids a
  // JS zip dependency for a one-shot script.
  const work = await mkdtemp(join(tmpdir(), "fb-repack-"));
  try {
    // Extract the existing zip so we can reuse non-course.json entries.
    execFileSync("unzip", ["-q", "-o", packPath, "-d", work], {
      stdio: "pipe",
    });
    // Overwrite course.json with the merged version.
    await writeFile(
      join(work, "course.json"),
      JSON.stringify(course, null, 2),
      "utf-8",
    );
    // Refresh cover.png from cover-overrides/ if present, so we
    // never accidentally drop the artwork on a repack of a pack
    // whose original zip predates the override pipeline.
    const overrideCover = join(COVER_OVERRIDES, `${courseId}.png`);
    if (existsSync(overrideCover)) {
      await copyFile(overrideCover, join(work, "cover.png"));
    }
    // Re-zip. `-X` drops extra metadata for reproducibility; `-q`
    // keeps the output clean. We zip the directory CONTENTS (not
    // the dir itself) so the archive layout matches what
    // ensure_seed expects.
    const tmpOut = `${packPath}.tmp`;
    if (existsSync(tmpOut)) await rm(tmpOut);
    execFileSync(
      "zip",
      ["-X", "-q", "-r", tmpOut, "."],
      { cwd: work, stdio: "pipe" },
    );
    // Atomic move to final location.
    await rm(packPath);
    await cp(tmpOut, packPath);
    await rm(tmpOut);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--course") out.course = argv[++i];
  }
  return out;
}

main().catch((err) => {
  console.error("[sync-drills-to-local] failed:", err);
  process.exit(1);
});
