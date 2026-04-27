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

/// Run the web seed if it hasn't run yet. Idempotent + safe to call
/// during the bootloader race; only the first caller does work, the
/// rest see `starterCoursesSeeded === true` and short-circuit.
///
/// Returns the number of courses written so callers can log it.
export async function seedWebStarterCourses(): Promise<number> {
  if (!isWeb) return 0;

  const seeded = await metaGet<boolean>(SEEDED_KEY);
  if (seeded === true) return 0;

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
      await storage.saveCourse(entry.id, { ...course, id: entry.id });
      written += 1;
    } catch (err) {
      console.warn(
        `[seedWebStarterCourses] failed for ${entry.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Mark as seeded even on partial failure — we don't want to
  // re-fetch the same broken pack on every boot. The user can wipe
  // their IndexedDB to retry from a clean slate if needed.
  await metaSet(SEEDED_KEY, true);

  // eslint-disable-next-line no-console
  console.log(
    `[seedWebStarterCourses] saved ${written}/${manifest.courses.length} starter courses`,
  );
  return written;
}

