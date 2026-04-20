import { useState } from "react";
import type { Course, Lesson } from "../../data/types";
import LessonReader from "../Lesson/LessonReader";
import "./CoursePreview.css";

interface Props {
  course: Course;
  onSave: () => void;
  onDiscard: () => void;
}

/// Full-pane preview of a just-generated course. User picks a lesson from the
/// left tree, content renders on the right. Save commits to disk; Discard
/// drops the in-memory course (cache persists so another run skips the LLM).
export default function CoursePreview({ course, onSave, onDiscard }: Props) {
  const firstLesson = course.chapters[0]?.lessons[0] ?? null;
  const [activeChapter, setActiveChapter] = useState(0);
  const [activeLessonId, setActiveLessonId] = useState(firstLesson?.id ?? "");

  const activeChapterObj = course.chapters[activeChapter];
  const activeLesson =
    activeChapterObj?.lessons.find((l) => l.id === activeLessonId) ??
    activeChapterObj?.lessons[0] ??
    null;

  return (
    <div className="kata-preview">
      <div className="kata-preview-header">
        <div>
          <div className="kata-preview-title">{course.title}</div>
          <div className="kata-preview-subtitle">
            {course.chapters.length} chapter{course.chapters.length === 1 ? "" : "s"} ·{" "}
            {totalLessons(course)} lessons ({countByKind(course)})
          </div>
        </div>
        <div className="kata-preview-actions">
          <button className="kata-preview-secondary" onClick={onDiscard}>
            Discard
          </button>
          <button className="kata-preview-primary" onClick={onSave}>
            Save course
          </button>
        </div>
      </div>

      <div className="kata-preview-body">
        <aside className="kata-preview-tree">
          {course.chapters.map((ch, ci) => (
            <div key={ch.id} className="kata-preview-chapter">
              <button
                className={`kata-preview-chapter-title ${
                  ci === activeChapter ? "is-active" : ""
                }`}
                onClick={() => {
                  setActiveChapter(ci);
                  setActiveLessonId(ch.lessons[0]?.id ?? "");
                }}
              >
                <span className="kata-preview-ch-index">{ci + 1}</span>
                {ch.title}
              </button>
              {ci === activeChapter &&
                ch.lessons.map((l) => (
                  <button
                    key={l.id}
                    className={`kata-preview-lesson ${
                      l.id === activeLessonId ? "is-active" : ""
                    }`}
                    onClick={() => setActiveLessonId(l.id)}
                  >
                    <LessonKindGlyph kind={l.kind} />
                    <span>{l.title}</span>
                  </button>
                ))}
            </div>
          ))}
        </aside>

        <section className="kata-preview-pane">
          {activeLesson ? (
            <LessonPreview lesson={activeLesson} />
          ) : (
            <div className="kata-preview-empty">No lesson selected.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function LessonPreview({ lesson }: { lesson: Lesson }) {
  return (
    <div className="kata-preview-lesson-pane">
      <div className="kata-preview-lesson-header">
        <span className="kata-preview-kind-chip">{lesson.kind}</span>
        <span className="kata-preview-lesson-title">{lesson.title}</span>
      </div>

      <LessonReader lesson={lesson} />

      {lesson.kind === "exercise" && (
        <div className="kata-preview-code">
          <div className="kata-preview-code-section">
            <h4>Starter</h4>
            <pre>{lesson.starter}</pre>
          </div>
          <div className="kata-preview-code-section">
            <h4>Solution</h4>
            <pre>{lesson.solution}</pre>
          </div>
          <div className="kata-preview-code-section">
            <h4>Tests</h4>
            <pre>{lesson.tests}</pre>
          </div>
        </div>
      )}

      {lesson.kind === "quiz" && (
        <div className="kata-preview-quiz">
          {lesson.questions.map((q, i) => (
            <div key={i} className="kata-preview-question">
              <div className="kata-preview-q-num">{i + 1}</div>
              <div>
                <div className="kata-preview-q-prompt">{q.prompt}</div>
                {q.kind === "mcq" ? (
                  <ul className="kata-preview-q-options">
                    {q.options.map((opt, j) => (
                      <li
                        key={j}
                        className={j === q.correctIndex ? "is-correct" : ""}
                      >
                        {String.fromCharCode(65 + j)}. {opt}
                        {j === q.correctIndex && " ✓"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="kata-preview-q-short">
                    Accepts: {q.accept.map((a) => `"${a}"`).join(", ")}
                  </div>
                )}
                {q.explanation && (
                  <div className="kata-preview-q-explanation">{q.explanation}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LessonKindGlyph({ kind }: { kind: Lesson["kind"] }) {
  const chars: Record<Lesson["kind"], string> = {
    reading: "◌",
    exercise: "●",
    mixed: "◐",
    quiz: "?",
  };
  return <span className="kata-preview-lesson-glyph">{chars[kind] ?? "•"}</span>;
}

function totalLessons(c: Course): number {
  return c.chapters.reduce((n, ch) => n + ch.lessons.length, 0);
}

function countByKind(c: Course): string {
  const counts: Record<string, number> = {};
  for (const ch of c.chapters) {
    for (const l of ch.lessons) {
      counts[l.kind] = (counts[l.kind] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}
