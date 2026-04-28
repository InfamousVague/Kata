/// Mobile library — book-cover tiles + a language filter strip.
/// Two-column grid of 2:3 portrait covers. Loads cover artwork via
/// `useCourseCover` (same hook the desktop shelf uses), with a typed
/// fallback tile for courses without a cover.
///
/// Filter strip is a single horizontal-scroll row of language pills —
/// no difficulty or topic axis on phone, since most learners on mobile
/// drill into one course rather than browsing the catalog.

import { useEffect, useMemo, useState } from "react";
import type { Course, LanguageId } from "../data/types";
import { useCourseCover, prefetchCovers } from "../hooks/useCourseCover";
import { Icon } from "@base/primitives/icon";
import { search as searchIcon } from "@base/primitives/icon/icons/search";
import "./MobileLibrary.css";

interface Props {
  courses: Course[];
  completed: Set<string>;
  onOpenLesson: (course: Course, chapterIndex: number, lessonIndex: number) => void;
  /// Optional — fired by the top-right search button to open the
  /// global mobile search palette. Left optional so callers that
  /// haven't wired the palette in yet still type-check.
  onOpenSearch?: () => void;
}

const LANG_LABELS: Partial<Record<LanguageId, string>> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  c: "C",
  cpp: "C++",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  swift: "Swift",
  assembly: "Assembly",
  reactnative: "React Native",
  threejs: "Three.js",
  bun: "Bun",
  solidity: "Solidity",
};

function labelFor(id: LanguageId): string {
  return LANG_LABELS[id] ?? id;
}

function nextLessonOf(course: Course, completed: Set<string>): {
  ch: number;
  ls: number;
  total: number;
  done: number;
} {
  // useProgress stores keys as `${courseId}:${lessonId}` — match that
  // here or `completed.has(...)` will always return false.
  const key = (lessonId: string) => `${course.id}:${lessonId}`;
  let total = 0;
  let done = 0;
  for (const c of course.chapters) {
    for (const l of c.lessons) {
      total += 1;
      if (completed.has(key(l.id))) done += 1;
    }
  }
  for (let ci = 0; ci < course.chapters.length; ci++) {
    const ch = course.chapters[ci];
    for (let li = 0; li < ch.lessons.length; li++) {
      if (!completed.has(key(ch.lessons[li].id))) {
        return { ch: ci, ls: li, total, done };
      }
    }
  }
  return { ch: 0, ls: 0, total, done };
}

export default function MobileLibrary({
  courses,
  completed,
  onOpenLesson,
  onOpenSearch,
}: Props) {
  const [filter, setFilter] = useState<LanguageId | "all">("all");

  // Prefetch every course's cover on first paint so scrolling doesn't
  // trigger a fetch storm. Same pattern desktop CourseLibrary uses.
  useEffect(() => {
    void prefetchCovers(
      courses.map((c) => ({
        courseId: c.id,
        cacheBust: c.coverFetchedAt,
      })),
    );
  }, [courses]);

  // Languages that actually have at least one course. Drives the pill
  // row — no point showing "Rust" if the user has no Rust courses.
  const availableLangs = useMemo(() => {
    const seen = new Set<LanguageId>();
    for (const c of courses) seen.add(c.language);
    return Array.from(seen);
  }, [courses]);

  const filtered = useMemo(() => {
    if (filter === "all") return courses;
    return courses.filter((c) => c.language === filter);
  }, [courses, filter]);

  return (
    <div className="m-lib">
      <header className="m-lib__head">
        <div className="m-lib__head-text">
          <h1 className="m-lib__title">Library</h1>
          <p className="m-lib__subtitle">
            {courses.length} course{courses.length === 1 ? "" : "s"}
          </p>
        </div>
        {onOpenSearch && (
          <button
            type="button"
            className="m-lib__search"
            onClick={onOpenSearch}
            aria-label="Search"
          >
            <Icon icon={searchIcon} size="md" color="currentColor" />
          </button>
        )}
      </header>

      {availableLangs.length > 1 && (
        <nav
          className="m-lib__filter"
          role="tablist"
          aria-label="Filter by language"
        >
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={`m-lib__pill${filter === "all" ? " m-lib__pill--active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
            <span className="m-lib__pill-count">{courses.length}</span>
          </button>
          {availableLangs.map((lang) => {
            const count = courses.filter((c) => c.language === lang).length;
            return (
              <button
                key={lang}
                type="button"
                role="tab"
                aria-selected={filter === lang}
                className={`m-lib__pill${filter === lang ? " m-lib__pill--active" : ""}`}
                onClick={() => setFilter(lang)}
              >
                {labelFor(lang)}
                <span className="m-lib__pill-count">{count}</span>
              </button>
            );
          })}
        </nav>
      )}

      <ul className="m-lib__grid" role="list">
        {filtered.map((c) => {
          const { ch, ls, total, done } = nextLessonOf(c, completed);
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          return (
            <li key={c.id} className="m-lib__cell">
              <button
                type="button"
                className="m-lib__tile"
                onClick={() => onOpenLesson(c, ch, ls)}
                aria-label={`${c.title}, ${pct}% complete`}
              >
                <CoverArt course={c} />
                <span className="m-lib__tile-info">
                  <span className="m-lib__tile-title">{c.title}</span>
                  <span className="m-lib__tile-meta">
                    {labelFor(c.language)} · {pct}%
                  </span>
                </span>
                <span
                  className="m-lib__tile-bar"
                  aria-hidden
                  style={{ "--m-lib-pct": `${pct}%` } as React.CSSProperties}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface CoverProps {
  course: Course;
}

function CoverArt({ course }: CoverProps) {
  const url = useCourseCover(course.id, course.coverFetchedAt);
  if (url) {
    return (
      <span
        className="m-lib__cover"
        style={{ backgroundImage: `url(${JSON.stringify(url)})` }}
        aria-hidden
      />
    );
  }
  // Fallback: a typed cover with the course's first letter on the
  // language's accent shade. Cheap to render and informative without a
  // network round-trip.
  const initial = (course.title || "?").charAt(0).toUpperCase();
  return (
    <span
      className="m-lib__cover m-lib__cover--fallback"
      data-lang={course.language}
      aria-hidden
    >
      {initial}
    </span>
  );
}
