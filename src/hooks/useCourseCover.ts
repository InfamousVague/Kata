import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isWeb } from "../lib/platform";

/// Web-build cover URL. Resolves against the page's BASE_URL so the
/// cover loads correctly regardless of whether the app is mounted at
/// the page root (`/`), a subpath (`/fishbones/learn/`), or the
/// fishbones.academy `/learn/` embed. Returns null when courseId is
/// empty so the caller can skip rendering.
function webCoverUrl(courseId: string): string | null {
  if (!courseId) return null;
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}/starter-courses/${courseId}.jpg`;
}

/// Thin hook that resolves a course's cover to a data URL (`data:image/png;base64,...`)
/// via the Rust `load_course_cover` command. Returns `null` when no
/// cover exists OR when loading fails — the caller renders its fallback
/// tile in either case.
///
/// `cacheBust` is threaded through so refetching a cover (e.g. the
/// "Fetch cover artwork…" button) invalidates stale in-memory URLs:
/// the import + course settings flow bumps `course.coverFetchedAt`
/// after the Rust command writes, and this hook keys on that value.

/// Module-level cache keyed on `${courseId}:${cacheBust ?? "0"}`. Shared
/// by every `useCourseCover` call and by `prefetchCovers` so the
/// library can load N covers up front and the per-card hooks hit a
/// warm cache instead of firing a second round of IPCs.
///
/// A `null` value = "resolved to no cover" (fetch succeeded, file
/// missing). An in-flight Promise = "fetch started, waiting on it" so
/// concurrent callers dedupe onto the same IPC.
type Resolved = string | null;
const resolved = new Map<string, Resolved>();
const inflight = new Map<string, Promise<Resolved>>();
/// Subscribers that want to know when the cached value for a key
/// changes. The per-hook mount registers itself; `fetchCover` runs
/// every subscriber for the affected key after the IPC resolves.
const subscribers = new Map<string, Set<() => void>>();

function cacheKey(courseId: string, cacheBust?: number): string {
  return `${courseId}:${cacheBust ?? 0}`;
}

function notify(key: string): void {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn();
}

/// Fire a `load_course_cover` IPC (or return an in-flight one) and
/// cache the result. Safe to call concurrently for the same key —
/// the second call hits the `inflight` map and rides the same promise.
function fetchCover(courseId: string, cacheBust?: number): Promise<Resolved> {
  const key = cacheKey(courseId, cacheBust);
  if (resolved.has(key)) {
    return Promise.resolve(resolved.get(key) ?? null);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = invoke<string | null>("load_course_cover", { courseId })
    .then((url) => {
      resolved.set(key, url ?? null);
      inflight.delete(key);
      notify(key);
      return url ?? null;
    })
    .catch(() => {
      resolved.set(key, null);
      inflight.delete(key);
      notify(key);
      return null;
    });
  inflight.set(key, p);
  return p;
}

/// Prime the cache for a batch of courses. Resolves when every IPC
/// has settled (success OR failure — failures cache as `null` so the
/// caller's fallback tile renders). Returns the number of covers
/// actually fetched (cache hits are excluded from the count so the
/// library's "loading N covers" label stays honest on re-opens).
export async function prefetchCovers(
  entries: Array<{ courseId: string; cacheBust?: number }>,
): Promise<number> {
  // Web build: covers are static files synthesized into a URL by
  // useCourseCover's web branch — no IPC, no fetch, no caching
  // here. Returning 0 keeps the library's "loading N covers"
  // label honest (no covers were fetched, because none needed to
  // be). Skipping this stops the kata invoke stub from throwing
  // "TAURI_UNAVAILABLE: load_course_cover" once per course on
  // page boot, which (caught or not) bloats the Safari console.
  if (isWeb) return 0;

  let fetched = 0;
  await Promise.all(
    entries.map(async (e) => {
      const key = cacheKey(e.courseId, e.cacheBust);
      if (!resolved.has(key) && !inflight.has(key)) fetched += 1;
      await fetchCover(e.courseId, e.cacheBust);
    }),
  );
  return fetched;
}

export function useCourseCover(
  courseId: string,
  cacheBust?: number,
): string | null {
  const key = cacheKey(courseId, cacheBust);
  // Seed from cache so the first render already has the URL when the
  // library's prefetch populated it before we mounted.
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => resolved.get(key) ?? null,
  );

  useEffect(() => {
    // Web-build path: covers are static files under
    // /<base>/starter-courses/<id>.jpg (staged by
    // scripts/extract-starter-courses.mjs). Skip the Tauri IPC
    // entirely. webSeedCourses sets `course.coverFetchedAt` to a
    // non-zero value at seed time on courses whose manifest entry
    // has a `cover` field, so a truthy cacheBust here = "we know
    // this course has a cover". Skipping the synthesis when
    // cacheBust is undefined avoids the broken-image flash on
    // courses without one.
    if (isWeb) return;

    let cancelled = false;
    const k = cacheKey(courseId, cacheBust);

    // Subscribe for future cache updates (e.g. the prefetch is still
    // in flight when we mount — the notify() call will wake us up).
    const onChange = () => {
      if (cancelled) return;
      setDataUrl(resolved.get(k) ?? null);
    };
    let set = subscribers.get(k);
    if (!set) {
      set = new Set();
      subscribers.set(k, set);
    }
    set.add(onChange);

    // Trigger a fetch if the cache is empty. `fetchCover` dedupes
    // concurrent requests for the same key so we don't N+1 when
    // prefetch + hook both fire at app start.
    void fetchCover(courseId, cacheBust).then((url) => {
      if (cancelled) return;
      setDataUrl(url);
    });

    return () => {
      cancelled = true;
      set?.delete(onChange);
      if (set && set.size === 0) subscribers.delete(k);
    };
  }, [courseId, cacheBust]);

  // Web build short-circuits to the static /starter-courses/<id>.jpg
  // URL when we know the cover exists (via webSeedCourses setting
  // coverFetchedAt) — no Tauri IPC needed. Desktop falls through
  // to the cached IPC result.
  if (isWeb) {
    return cacheBust ? webCoverUrl(courseId) : null;
  }
  return dataUrl;
}
