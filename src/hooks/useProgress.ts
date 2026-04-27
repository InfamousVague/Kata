import { useEffect, useState } from "react";
import { storage, type Completion } from "../lib/storage";

export type { Completion };

/// Syncs the "completed lessons" Set to the active storage backend
/// (SQLite via Tauri on desktop, IndexedDB on web). The Set is the
/// source of truth while the app is open; on first mount we
/// rehydrate from storage, and markCompleted writes through.
/// `history` gives the same data as a timestamped array, for
/// streak / XP math.
///
/// Falls back gracefully when storage throws (e.g. older Tauri DB
/// migration mid-flight, IndexedDB unavailable in private mode) so
/// the UI still renders and lets the learner read.
export function useProgress() {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Completion[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await storage.listCompletions();
        if (cancelled) return;
        const s = new Set<string>();
        for (const r of rows) s.add(`${r.course_id}:${r.lesson_id}`);
        setCompleted(s);
        setHistory(rows);
      } catch {
        // Storage unavailable — stay with the empty set so the UI
        // renders. Reads-only behaviour for the session.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function markCompleted(courseId: string, lessonId: string) {
    const key = `${courseId}:${lessonId}`;
    setCompleted((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    // Also append to the local history so streak/XP react instantly without
    // waiting for a re-fetch. Uses client-side now() which may drift from
    // the server-side now() by a second; harmless for stats display.
    setHistory((prev) => {
      if (prev.some((r) => r.course_id === courseId && r.lesson_id === lessonId)) return prev;
      return [
        ...prev,
        {
          course_id: courseId,
          lesson_id: lessonId,
          completed_at: Math.floor(Date.now() / 1000),
        },
      ];
    });
    // Fire-and-forget persistence; the optimistic UI update above already
    // reflects the new state, and storage is best-effort.
    storage.markCompletion(courseId, lessonId).catch(() => {});
  }

  /// Reset a single lesson's completion. Drops the key from the in-memory
  /// Set and history array immediately so progress rings update without
  /// a re-fetch, then fires the matching storage delete.
  function clearLessonCompletion(courseId: string, lessonId: string) {
    const key = `${courseId}:${lessonId}`;
    setCompleted((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setHistory((prev) =>
      prev.filter((r) => !(r.course_id === courseId && r.lesson_id === lessonId)),
    );
    storage.clearLessonCompletion(courseId, lessonId).catch(() => {});
  }

  /// Reset every lesson in a chapter. We don't have a chapter id in the schema
  /// (completions are flat per-lesson) so the caller passes in the list of
  /// lesson_ids that belong to the chapter. Local state updates happen in one
  /// batched setState; the storage deletes are fired in parallel.
  function clearChapterCompletions(courseId: string, lessonIds: string[]) {
    if (lessonIds.length === 0) return;
    const keys = new Set(lessonIds.map((id) => `${courseId}:${id}`));
    const lessonIdSet = new Set(lessonIds);
    setCompleted((prev) => {
      let mutated = false;
      const next = new Set(prev);
      for (const k of keys) {
        if (next.delete(k)) mutated = true;
      }
      return mutated ? next : prev;
    });
    setHistory((prev) =>
      prev.filter(
        (r) => !(r.course_id === courseId && lessonIdSet.has(r.lesson_id)),
      ),
    );
    storage.clearChapterCompletions(courseId, lessonIds).catch(() => {});
  }

  /// Reset every completion for a course. Single command call instead of
  /// per-lesson fan-out — the backend has a course-scoped DELETE.
  function clearCourseCompletions(courseId: string) {
    setCompleted((prev) => {
      let mutated = false;
      const next = new Set(prev);
      for (const k of prev) {
        if (k.startsWith(`${courseId}:`)) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
    setHistory((prev) => prev.filter((r) => r.course_id !== courseId));
    storage.clearCourseCompletions(courseId).catch(() => {});
  }

  return {
    completed,
    history,
    markCompleted,
    clearLessonCompletion,
    clearChapterCompletions,
    clearCourseCompletions,
    loaded,
  };
}
