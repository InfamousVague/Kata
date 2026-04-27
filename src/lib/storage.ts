/// Storage abstraction so the same hooks work on desktop (Tauri/SQLite)
/// and web (IndexedDB). Picked at module-load via `isWeb` from
/// platform.ts and exposed as a singleton — call sites just use the
/// returned interface and don't care about the backend.
///
/// Phase 2 of the web rollout. Hooks (useProgress, useCourses,
/// useRecentCourses) move from raw `invoke(...)` calls to the methods
/// here; recents stays in localStorage either way (no backend needed).
///
/// Schema for the web variant (IndexedDB DB `fishbones-v1`):
///   completions  — keyPath "courseId|lessonId", value Completion
///   courses      — keyPath "id", value Course (full body)
///   meta         — keyPath "key", value { key, value }
///
/// Web storage stays purely local for now. Phase 4 layers cloud sync
/// on top — the existing useFishbonesCloud hook already pushes a
/// completions delta to api.mattssoftware.com over HTTP, so once we
/// hook it up to webStorage's writes we get cross-device sync for
/// free.

import { isWeb } from "./platform";
import type { Course } from "../data/types";

export interface Completion {
  course_id: string;
  lesson_id: string;
  /// Unix timestamp (seconds) when the lesson was completed.
  completed_at: number;
}

export interface FishbonesStorage {
  /// All completions, used to seed the in-memory Set on app boot.
  listCompletions(): Promise<Completion[]>;
  markCompletion(courseId: string, lessonId: string): Promise<void>;
  clearLessonCompletion(courseId: string, lessonId: string): Promise<void>;
  clearChapterCompletions(
    courseId: string,
    lessonIds: string[],
  ): Promise<void>;
  clearCourseCompletions(courseId: string): Promise<void>;

  /// Course summaries — same shape as full courses but with the
  /// heavy per-lesson fields (starter / solution / tests / files /
  /// solutionFiles / prose) stripped. Used by the library + sidebar
  /// for fast first paint.
  listCoursesSummary(): Promise<Course[]>;
  loadCourse(courseId: string): Promise<Course>;
  saveCourse(courseId: string, body: Course): Promise<void>;
  deleteCourse(courseId: string): Promise<void>;
}

// ─── Tauri backend ─────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";

const tauriStorage: FishbonesStorage = {
  async listCompletions() {
    return invoke<Completion[]>("list_completions");
  },
  async markCompletion(courseId, lessonId) {
    await invoke("mark_completion", { courseId, lessonId });
  },
  async clearLessonCompletion(courseId, lessonId) {
    await invoke("clear_lesson_completion", { courseId, lessonId });
  },
  async clearChapterCompletions(courseId, lessonIds) {
    await Promise.all(
      lessonIds.map((lessonId) =>
        invoke("clear_lesson_completion", { courseId, lessonId }),
      ),
    );
  },
  async clearCourseCompletions(courseId) {
    await invoke("clear_course_completions", { courseId });
  },
  async listCoursesSummary() {
    return invoke<Course[]>("list_courses_summary");
  },
  async loadCourse(courseId) {
    return invoke<Course>("load_course", { courseId });
  },
  async saveCourse(courseId, body) {
    await invoke("save_course", { courseId, body });
  },
  async deleteCourse(courseId) {
    await invoke("delete_course", { courseId });
  },
};

// ─── IndexedDB (web) backend ───────────────────────────────────────────

const DB_NAME = "fishbones-v1";
const DB_VERSION = 1;
const STORE_COMPLETIONS = "completions";
const STORE_COURSES = "courses";
const STORE_META = "meta";

/// Promise wrapper around `IDBOpenDBRequest`. Cached so concurrent
/// callers all wait on the same open() rather than racing.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // First-version schema. If we ever bump DB_VERSION, branch on
      // event.oldVersion to migrate cleanly without dropping data.
      if (!db.objectStoreNames.contains(STORE_COMPLETIONS)) {
        const store = db.createObjectStore(STORE_COMPLETIONS, {
          keyPath: "id",
        });
        // Index by course id so clearCourseCompletions can scan
        // efficiently without iterating every record.
        store.createIndex("byCourse", "course_id");
      }
      if (!db.objectStoreNames.contains(STORE_COURSES)) {
        db.createObjectStore(STORE_COURSES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

interface CompletionRecord extends Completion {
  /// Composite key — `courseId|lessonId`. Mirrors the Set keying
  /// used in `useProgress` so a marshal in/out is just a split.
  id: string;
}

/// Strip the heavy per-lesson fields from a Course to produce the
/// "summary" shape the library + sidebar render. Mirrors what the
/// Tauri `list_courses_summary` command does server-side.
function summarise(course: Course): Course {
  return {
    ...course,
    chapters: course.chapters.map((ch) => ({
      ...ch,
      lessons: ch.lessons.map((l) => {
        // Strip lesson body + workbench files. Keep id, title, kind,
        // and the lightweight metadata so progress rings + the lesson
        // list still render.
        const stripped: Record<string, unknown> = {
          id: l.id,
          title: l.title,
          kind: l.kind,
          body: "",
        };
        if ("language" in l) stripped.language = l.language;
        if ("difficulty" in l) stripped.difficulty = l.difficulty;
        if ("topic" in l) stripped.topic = l.topic;
        // Cast through `unknown` because the summary shape is a
        // strict subset of every lesson kind — TS can't narrow that
        // automatically since the discriminator is the `kind` field.
        return stripped as unknown as typeof l;
      }),
    })),
  };
}

const webStorage: FishbonesStorage = {
  async listCompletions() {
    const db = await openDb();
    const tx = db.transaction(STORE_COMPLETIONS, "readonly");
    const rows = await reqToPromise(
      tx.objectStore(STORE_COMPLETIONS).getAll() as IDBRequest<
        CompletionRecord[]
      >,
    );
    return rows.map(({ id: _id, ...rest }) => rest);
  },

  async markCompletion(courseId, lessonId) {
    const db = await openDb();
    const tx = db.transaction(STORE_COMPLETIONS, "readwrite");
    const rec: CompletionRecord = {
      id: `${courseId}|${lessonId}`,
      course_id: courseId,
      lesson_id: lessonId,
      completed_at: Math.floor(Date.now() / 1000),
    };
    tx.objectStore(STORE_COMPLETIONS).put(rec);
    await txDone(tx);
  },

  async clearLessonCompletion(courseId, lessonId) {
    const db = await openDb();
    const tx = db.transaction(STORE_COMPLETIONS, "readwrite");
    tx.objectStore(STORE_COMPLETIONS).delete(`${courseId}|${lessonId}`);
    await txDone(tx);
  },

  async clearChapterCompletions(courseId, lessonIds) {
    if (lessonIds.length === 0) return;
    const db = await openDb();
    const tx = db.transaction(STORE_COMPLETIONS, "readwrite");
    const store = tx.objectStore(STORE_COMPLETIONS);
    for (const lessonId of lessonIds) {
      store.delete(`${courseId}|${lessonId}`);
    }
    await txDone(tx);
  },

  async clearCourseCompletions(courseId) {
    const db = await openDb();
    const tx = db.transaction(STORE_COMPLETIONS, "readwrite");
    const idx = tx.objectStore(STORE_COMPLETIONS).index("byCourse");
    // Cursor over the byCourse index so we don't load every other
    // course's completions into memory just to find the ones we
    // want to nuke.
    await new Promise<void>((resolve, reject) => {
      const cursorReq = idx.openCursor(IDBKeyRange.only(courseId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    await txDone(tx);
  },

  async listCoursesSummary() {
    const db = await openDb();
    const tx = db.transaction(STORE_COURSES, "readonly");
    const courses = await reqToPromise(
      tx.objectStore(STORE_COURSES).getAll() as IDBRequest<Course[]>,
    );
    return courses.map(summarise);
  },

  async loadCourse(courseId) {
    const db = await openDb();
    const tx = db.transaction(STORE_COURSES, "readonly");
    const course = await reqToPromise(
      tx.objectStore(STORE_COURSES).get(courseId) as IDBRequest<
        Course | undefined
      >,
    );
    if (!course) {
      throw new Error(
        `Course "${courseId}" not found in IndexedDB. ` +
          `Run the starter-course seed or open the desktop app to ingest one.`,
      );
    }
    return course;
  },

  async saveCourse(courseId, body) {
    const db = await openDb();
    const tx = db.transaction(STORE_COURSES, "readwrite");
    // The Course's id is the keyPath, but we accept courseId as a
    // separate arg for parity with the Tauri command. They should
    // match; if not, the courseId arg wins so callers can rename.
    const stored = courseId === body.id ? body : { ...body, id: courseId };
    tx.objectStore(STORE_COURSES).put(stored);
    await txDone(tx);
  },

  async deleteCourse(courseId) {
    const db = await openDb();
    const tx = db.transaction(STORE_COURSES, "readwrite");
    tx.objectStore(STORE_COURSES).delete(courseId);
    await txDone(tx);
  },
};

// ─── Public singleton ──────────────────────────────────────────────────

/// The active backend for this build. Picked once at module load —
/// callers don't have to plumb `isWeb` through every site.
export const storage: FishbonesStorage = isWeb ? webStorage : tauriStorage;

/// Web-only helper: read / write the meta store. Used for things like
/// "have we seeded the starter courses yet?" so we don't reseed on
/// every boot. No-op equivalents on desktop (Tauri commands handle
/// their own first-launch seeding via Rust).
export async function metaGet<T = unknown>(key: string): Promise<T | undefined> {
  if (!isWeb) return undefined;
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  const row = await reqToPromise(
    tx.objectStore(STORE_META).get(key) as IDBRequest<
      { key: string; value: T } | undefined
    >,
  );
  return row?.value;
}

export async function metaSet<T = unknown>(
  key: string,
  value: T,
): Promise<void> {
  if (!isWeb) return;
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}
