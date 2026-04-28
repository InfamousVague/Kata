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
const MANIFEST_PATH = "/starter-courses/manifest.json";

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
const SEED_VERSION = 4;

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

  // Mark as seeded at the current SEED_VERSION even on partial
  // failure — we don't want to re-fetch the same broken pack on
  // every boot. The user can wipe their IndexedDB to retry from a
  // clean slate if needed. Storing the version (instead of just
  // `true`) lets us re-seed when the pack list / cover treatment
  // changes in a future build.
  await metaSet(SEEDED_KEY, SEED_VERSION);

  // eslint-disable-next-line no-console
  console.log(
    `[seedWebStarterCourses] saved ${written}/${manifest.courses.length} starter courses`,
  );
  return written;
}

