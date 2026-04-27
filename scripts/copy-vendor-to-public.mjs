#!/usr/bin/env node
/// Copy vendored CDN deps into `public/vendor/` for the web build.
///
/// Desktop builds serve `/vendor/*` from a Tauri preview-server route
/// that reads `src-tauri/resources/vendor/`. The web build has no
/// preview server — it's a static site — so we copy the same files
/// into Vite's `public/` directory, where they end up at
/// `https://mattssoftware.com/play/vendor/<file>` after `vite build`.
///
/// Path stays `/vendor/<file>` in both builds. `src/lib/platform.ts`'s
/// `vendorUrl(name)` returns an absolute origin-prefixed URL for the
/// web build (so blob:-iframe previews can reach back to the parent
/// origin) and a relative path for desktop.
///
/// Idempotent: if the source dir is missing, run `npm run vendor`
/// first to populate it. We don't chain to `vendor` automatically
/// because the scripts have different responsibilities — `vendor`
/// produces the assets; this one stages them for the web build.

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src-tauri", "resources", "vendor");
const DEST = join(ROOT, "public", "vendor");

async function main() {
  if (!existsSync(SRC)) {
    console.error(
      `[copy-vendor-to-public] source dir is missing: ${SRC}\n` +
        `Run \`npm run vendor\` first to populate it from node_modules.`,
    );
    process.exit(1);
  }

  // Wipe the destination so a removed-from-source file doesn't ghost
  // around in `public/vendor/` and ship to the web bundle.
  if (existsSync(DEST)) {
    await rm(DEST, { recursive: true, force: true });
  }
  await mkdir(DEST, { recursive: true });

  await cp(SRC, DEST, { recursive: true });

  const info = await stat(DEST);
  console.log(
    `[copy-vendor-to-public] staged ${SRC} → ${DEST}` +
      ` (mtime ${info.mtime.toISOString()})`,
  );
}

main().catch((err) => {
  console.error("[copy-vendor-to-public] failed:", err);
  process.exit(1);
});
