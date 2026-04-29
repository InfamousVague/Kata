/// First-launch seeder for the web build. Fetches the curated starter
/// courses staged at `/starter-courses/manifest.json` (created by
/// `scripts/extract-starter-courses.mjs`) and saves them into IndexedDB
/// via the storage abstraction.
///
/// Runs at most once per device (gated by a `meta.starterCoursesSeeded`
/// flag) so subsequent visits skip the network round-trip and the
/// learner's progress isn't clobbered if they delete a course.
///
/// Desktop-side seeding still goes through `seedCourses` (the static
/// constant in seedCourses.ts, currently empty) — desktop ships its
/// content via `bundled-packs` extracted by Rust on first launch, so
/// this module isn't called in that path.

import { metaGet, metaSet, storage } from "../lib/storage";
import { isWeb } from "../lib/platform";
import type { Course } from "./types";

interface ManifestEntry {
  id: string;
  title: string;
  language: string;
  file: string;
  cover?: string;
  sizeBytes: number;
  packType?: "course" | "challenges";
}

interface Manifest {
  version: number;
  courses: ManifestEntry[];
}

const SEEDED_KEY = "starterCoursesSeeded";
/// Tracks the set of course ids the seeder wrote on its last successful
/// run. On the next seed we diff against the current manifest and
/// delete any ids that were ours-then but aren't ours-now — that's how
/// books removed from PACK_IDS (svelte-5-complete, bun-complete,
/// javascript-crash-course, …) actually disappear from returning
/// visitors' libraries instead of lingering in IndexedDB forever.
/// Stored as a JSON-serialised string[] under this meta key.
const SEEDED_IDS_KEY = "starterCoursesSeededIds";
const MANIFEST_PATH = "/starter-courses/manifest.json";

/// Migration fallback. Versions ≤V5 of this seeder didn't track which
/// ids it wrote, so on the first V6 run we don't know what to prune —
/// `previousIds` reads empty even though IndexedDB likely has stale
/// records. This is the union of every course id the web seed has
/// ever shipped (current PACK_IDS + retired ones), used as a fallback
/// `previousIds` for visitors mid-migration. Custom user-imported
/// packs are never in this list, so the prune step still leaves
/// them alone.
const LEGACY_STARTER_IDS: ReadonlyArray<string> = [
  "the-rust-programming-language",
  "rust-by-example",
  "rust-async-book",
  "rustonomicon",
  "eloquent-javascript",
  "javascript-info",
  "javascript-the-definitive-guide",
  "you-dont-know-js-yet",
  "composing-programs",
  "python-crash-course",
  "learning-go",
  "algorithms-erickson",
  "open-data-structures",
  "crafting-interpreters-js",
  "pro-git",
  "svelte-tutorial",
  "solidjs-fundamentals",
  "htmx-fundamentals",
  "astro-fundamentals",
  "react-native",
  "learning-react-native",
  "fluent-react",
  "tauri-2-fundamentals",
  "interactive-web-development-with-three-js-and-a-frame",
  "mastering-bitcoin",
  "programming-bitcoin",
  "mastering-ethereum",
  "mastering-lightning-network",
  "solidity-complete",
  "vyper-fundamentals",
  "solana-programs",
  "viem-ethers",
  "cryptography-fundamentals",
  "challenges-javascript-handwritten",
  "challenges-typescript-mo9c9k2o",
  "challenges-python-handwritten",
  "challenges-go-handwritten",
  "challenges-rust-handwritten",
  "challenges-reactnative-handwritten",
  // Retired — explicitly listed so they're pruned on migration.
  // Includes anything we shipped in any prior PACK_IDS revision but
  // since dropped. Don't trim this list when adding new retirees;
  // visitors who never made it past V1 are still out there with old
  // ids in their IndexedDB.
  "bun-complete",
  "bun-fundamentals",
  "svelte-5-complete",
  "javascript-crash-course",
  "challenges-reactnative-visual",
];

/// Resolve a starter-courses path relative to the active build's base
/// URL. We don't use `vendorUrl` because that targets `/vendor/*`;
/// here the path is `/starter-courses/*` rooted at the page origin
/// (which on the deployed build is `mattssoftware.com/fishbones/learn/`,
/// not the page origin). Vite's `import.meta.env.BASE_URL` gives us
/// the correct prefix in both dev and prod.
function starterUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}${path}`;
}

/// Bump this whenever the seed format changes meaningfully — adding
/// new courses, swapping cover URLs, expanding metadata fields, etc.
/// `seedWebStarterCourses` re-runs when the persisted version differs
/// from this constant. Without it, returning visitors with a previous
/// seed in IndexedDB would never pick up new books or new covers.
///
/// V2 → V3: cover artwork was promised in V2 but the CI runner that
/// produced the V2 manifest didn't have ImageMagick, so the cover
/// field shipped empty for every course. Visitors who seeded against
/// that broken V2 manifest now have Course records with
/// `coverFetchedAt: undefined`, and the library shows the
/// language-tinted fallback instead of artwork. Bumping to V3 forces
/// those records to refresh against the current (fixed) manifest.
///
/// V4 — adds 147 micropuzzle drills (792 cards) across 11 tutorial
/// courses. Existing IndexedDB seeds get re-fetched so academy
/// visitors see the drills inline without a manual reset.
///
/// V5 — fixes the missing-cover bug for the dozen books whose
/// course.id differed from their .fishbones pack-filename slug.
/// extract-starter-courses now mirrors the JPEG under the in-zip
/// course id, but visitors whose browsers cached the prior broken
/// 200-HTML response still see the language-tinted glyph until the
/// img URL changes. Bumping the seed forces fresh `coverFetchedAt`
/// stamps, and `useCourseCover` now appends them as `?v=<n>` —
/// the new URL bypasses the stale cache on the next visit.
///
/// V6 — drops books that were removed from PACK_IDS in earlier
/// updates but lingered in returning visitors' IndexedDB because
/// the seeder only ever WROTE records, never deleted them
/// (svelte-5-complete, bun-complete, javascript-crash-course,
/// challenges-reactnative-visual, …). The seeder now diffs against
/// `starterCoursesSeededIds` and removes ids it previously wrote
/// that aren't in the current manifest. Custom packs the user
/// imported themselves are unaffected — only ids we know we
/// seeded ourselves get the chop.
///
/// V7 — adds `bun-fundamentals` to the legacy prune list. It was
/// in the very first PACK_IDS revision (alongside bun-complete) and
/// got missed when V6 shipped, so V1-era seeds still showed it.
const SEED_VERSION = 7;

/// Run the web seed if it hasn't run yet OR if the persisted
/// `SEED_VERSION` is older than the current build's. Idempotent +
/// safe to call during the bootloader race; only the first caller
/// does work for a given version.
///
/// Returns the number of courses written so callers can log it.
export async function seedWebStarterCourses(): Promise<number> {
  if (!isWeb) return 0;

  // The flag transitioned from boolean → number with v2 — accept
  // either shape on read so v1 installs roll forward without losing
  // their progress.
  const seeded = await metaGet<boolean | number>(SEEDED_KEY);
  const seededVersion =
    typeof seeded === "number" ? seeded : seeded === true ? 1 : 0;
  if (seededVersion >= SEED_VERSION) return 0;

  let manifest: Manifest;
  try {
    const url = starterUrl(MANIFEST_PATH);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    manifest = (await res.json()) as Manifest;
  } catch (err) {
    // Don't write the seeded flag — next visit retries. Marketing
    // landing page might be reachable without the starter pack
    // staging step, in which case we degrade to "no courses" cleanly
    // and the empty-state CTA invites the learner to install the
    // desktop app.
    console.warn(
      "[seedWebStarterCourses] failed to fetch manifest:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  // Snapshot the ids we previously seeded so we can prune anything
  // that's been removed from the current manifest. Without this
  // step, books we drop from PACK_IDS hang around in IndexedDB
  // forever — the seeder only writes, never deletes. Custom packs
  // the user imported themselves aren't in this list, so they're
  // not at risk of being clobbered.
  //
  // Migration: pre-V6 seeds didn't track this, so the meta key reads
  // empty for returning visitors who'd benefit most from cleanup.
  // Fall back to LEGACY_STARTER_IDS in that case so the first V6
  // run still prunes retired books.
  const previousIdsRaw = await metaGet<string>(SEEDED_IDS_KEY);
  const previousIds: string[] = (() => {
    if (!previousIdsRaw) return [...LEGACY_STARTER_IDS];
    try {
      const parsed = JSON.parse(previousIdsRaw);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
    } catch {
      return [...LEGACY_STARTER_IDS];
    }
  })();
  const currentIds = new Set(manifest.courses.map((e) => e.id));

  let written = 0;
  for (const entry of manifest.courses) {
    try {
      const url = starterUrl(`/starter-courses/${entry.file}`);
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) {
        console.warn(
          `[seedWebStarterCourses] HTTP ${res.status} for ${entry.id}, skipping`,
        );
        continue;
      }
      const course = (await res.json()) as Course;
      // Force the id we got from the manifest in case the JSON's
      // own id field disagrees (would point at a desktop-style
      // path-derived id rather than the slug). Never seen in
      // practice but cheap insurance.
      //
      // Also stamp `coverFetchedAt` ONLY when the manifest entry
      // has a `cover` field — `useCourseCover` keys off that
      // truthy value to decide whether to render the static
      // `/starter-courses/<id>.jpg` URL or fall back to the
      // language-tinted glyph. Setting Date.now() means the cover
      // re-fetches once whenever the manifest is reseeded; it's
      // not a problem because the resized JPEG is small + cached
      // by the browser.
      const record: Course = {
        ...course,
        id: entry.id,
        coverFetchedAt: entry.cover ? Date.now() : undefined,
      };
      await storage.saveCourse(entry.id, record);
      written += 1;
    } catch (err) {
      console.warn(
        `[seedWebStarterCourses] failed for ${entry.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Prune previously-seeded courses that aren't in the current
  // manifest. We only touch ids we know we wrote ourselves — the
  // intersection of `previousIds` (last seed's set) and "not in
  // currentIds". User-imported packs aren't in `previousIds` so
  // they're safe.
  let removed = 0;
  for (const id of previousIds) {
    if (currentIds.has(id)) continue;
    try {
      await storage.deleteCourse(id);
      removed += 1;
    } catch (err) {
      console.warn(
        `[seedWebStarterCourses] failed to prune removed course ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Mark as seeded at the current SEED_VERSION even on partial
  // failure — we don't want to re-fetch the same broken pack on
  // every boot. The user can wipe their IndexedDB to retry from a
  // clean slate if needed. Storing the version (instead of just
  // `true`) lets us re-seed when the pack list / cover treatment
  // changes in a future build.
  await metaSet(SEEDED_KEY, SEED_VERSION);
  await metaSet(SEEDED_IDS_KEY, JSON.stringify(Array.from(currentIds)));

  // eslint-disable-next-line no-console
  console.log(
    `[seedWebStarterCourses] saved ${written}/${manifest.courses.length} starter courses` +
      (removed > 0 ? ` (pruned ${removed} no-longer-shipped)` : ""),
  );
  return written;
}

