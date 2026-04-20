import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { seedCourses } from "../data/seedCourses";
import type { Course } from "../data/types";

interface CourseEntry {
  id: string;
  path: string;
  title: string;
  language: string;
}

/// Load the user's courses from the app data dir.
///
/// First-launch seeding: if the app data dir has no courses, we serialize the
/// built-in `seedCourses` to disk via `save_course` so the same storage path
/// works whether the course came from the bundled seed, an ingested book, or
/// an imported `.kata` file.
///
/// Outside Tauri (plain `vite dev` or unit tests) we fall back to the seed
/// set so components render.
export function useCourses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<Course[]> {
    try {
      // Always (re)write seed courses to disk on launch. The repo's
      // courses/*/course.json files are the source of truth; shipping an
      // updated seed (bug fix, new lesson, re-run of the ingest) reaches the
      // user the next time they open the app without them having to reset.
      //
      // Imported/user-added courses live under different ids so they survive.
      await Promise.all(
        seedCourses.map((c) =>
          invoke("save_course", { courseId: c.id, body: c }),
        ),
      );

      const entries = await invoke<CourseEntry[]>("list_courses");
      const full = await Promise.all(
        entries.map((e) => invoke<Course>("load_course", { courseId: e.id })),
      );
      setCourses(full);
      setError(null);
      return full;
    } catch (e) {
      // Not in Tauri, or backend failed. Use the bundled seed so the UI at
      // least renders something.
      setCourses(seedCourses);
      setError(e instanceof Error ? e.message : String(e));
      return seedCourses;
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return { courses, loaded, error, refresh };
}
