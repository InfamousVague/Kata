/// Course outline — a bottom-sheet listing every chapter + lesson in
/// the active course with completion state. Triggered from the lesson
/// header. Tap any lesson row to jump to it; the active lesson is
/// pinned with a left bar so the user sees where they are in the
/// arc.
///
/// Sheet pattern matches the SignInDialog mobile variant: full-width
/// at the bottom, slide-up animation, tap-backdrop-to-dismiss.

import { useEffect, useRef } from "react";
import type { Course, Lesson } from "../data/types";
import { Icon } from "@base/primitives/icon";
import { bookOpen } from "@base/primitives/icon/icons/book-open";
import { code as codeIcon } from "@base/primitives/icon/icons/code";
import { helpCircle } from "@base/primitives/icon/icons/help-circle";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import "./MobileOutline.css";

/// Pick the per-kind glyph that lives inside the lesson bullet. Mirrors
/// the desktop Sidebar `iconForKind` so done-state mobile rows show the
/// same icon-in-a-circle the sidebar shows. Mobile has a `puzzle` kind
/// the desktop helper doesn't enumerate — we route it through the code
/// icon since puzzles are arrange-the-blocks variants of an exercise.
function iconForKind(kind: Lesson["kind"]) {
  switch (kind) {
    case "reading":
      return bookOpen;
    case "quiz":
      return helpCircle;
    case "exercise":
    case "mixed":
    case "puzzle":
    default:
      return codeIcon;
  }
}

interface Props {
  course: Course;
  activeChapter: number;
  activeLesson: number;
  completed: Set<string>;
  onJump: (chapterIndex: number, lessonIndex: number) => void;
  onClose: () => void;
}

export default function MobileOutline({
  course,
  activeChapter,
  activeLesson,
  completed,
  onJump,
  onClose,
}: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the sheet to the active lesson on open so a 200-lesson
  // course doesn't make the user hunt for "where am I."
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const active = sheet.querySelector<HTMLElement>("[data-active='true']");
    if (active) {
      // `block: "center"` so the active row sits in the middle of the
      // sheet rather than scrolled all the way to the top.
      active.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    }
  }, []);

  // Aggregate stats for the header strip. useProgress keys completion
  // entries as `${courseId}:${lessonId}` — match that exactly here.
  const completionKey = (lessonId: string) => `${course.id}:${lessonId}`;
  let total = 0;
  let done = 0;
  for (const ch of course.chapters) {
    for (const l of ch.lessons) {
      total += 1;
      if (completed.has(completionKey(l.id))) done += 1;
    }
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="m-outline-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="m-outline"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Course outline"
      >
        <div className="m-outline__grip" aria-hidden />
        <header className="m-outline__head">
          <div className="m-outline__head-text">
            <span className="m-outline__head-title">{course.title}</span>
            <span className="m-outline__head-meta">
              {done}/{total} lessons · {pct}%
            </span>
          </div>
          <button
            type="button"
            className="m-outline__close"
            onClick={onClose}
            aria-label="Close outline"
          >
            <Icon icon={xIcon} size="lg" />
          </button>
        </header>

        <div
          className="m-outline__progress"
          aria-hidden
          style={{ "--m-outline-pct": `${pct}%` } as React.CSSProperties}
        />

        <ol className="m-outline__chapters">
          {course.chapters.map((ch, ci) => (
            <li key={ch.id} className="m-outline__chapter">
              <h3 className="m-outline__chapter-title">{ch.title}</h3>
              <ul className="m-outline__lessons">
                {ch.lessons.map((l, li) => {
                  const isActive = ci === activeChapter && li === activeLesson;
                  const isDone = completed.has(completionKey(l.id));
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        className={`m-outline__row${isActive ? " m-outline__row--active" : ""}`}
                        data-active={isActive ? "true" : undefined}
                        onClick={() => {
                          onJump(ci, li);
                          onClose();
                        }}
                      >
                        <span
                          className={`m-outline__bullet${
                            isDone
                              ? " m-outline__bullet--done"
                              : isActive
                                ? " m-outline__bullet--active"
                                : ""
                          }`}
                          aria-hidden
                        >
                          <Icon
                            icon={iconForKind(l.kind)}
                            size="xs"
                            color="currentColor"
                          />
                        </span>
                        <span className="m-outline__row-text">
                          <span className="m-outline__row-title">{l.title}</span>
                          <span className="m-outline__row-kind">
                            {l.kind === "reading"
                              ? "Reading"
                              : l.kind === "quiz"
                                ? "Quiz"
                                : l.kind === "puzzle"
                                  ? "Puzzle"
                                  : "Exercise"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
