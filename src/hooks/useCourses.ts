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

  async function refresh() {
    try {
      let entries = await invoke<CourseEntry[]>("list_courses");
      if (entries.length === 0) {
        // First launch — write the seed to disk, then re-list.
        await Promise.all(
          seedCourses.map((c) =>
            invoke("save_course", { courseId: c.id, body: c }),
          ),
        );
        entries = await invoke<CourseEntry[]>("list_courses");
      }
      const full = await Promise.all(
        entries.map((e) => invoke<Course>("load_course", { courseId: e.id })),
      );
      setCourses(full);
      setError(null);
    } catch (e) {
      // Not in Tauri, or backend failed. Use the bundled seed so the UI at
      // least renders something.
      setCourses(seedCourses);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return { courses, loaded, error, refresh };
}
