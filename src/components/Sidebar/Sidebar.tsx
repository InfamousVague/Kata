import { useState } from "react";
import { Icon } from "@base/primitives/icon";
import { chevronRight } from "@base/primitives/icon/icons/chevron-right";
import { chevronDown } from "@base/primitives/icon/icons/chevron-down";
import "@base/primitives/icon/icon.css";
import type { Course, Chapter, Lesson } from "../../data/types";
import "./Sidebar.css";

interface Props {
  courses: Course[];
  activeCourseId?: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onBrowse: () => void;
  onSettings: () => void;
}

/// Floating left rail. Completion dots fill in as lessons get marked done
/// (unit test passes, mark-read, etc.). The chapter header shows `x / y`
/// lessons complete so users see progress at a glance.
export default function Sidebar({
  courses,
  activeCourseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onBrowse,
  onSettings,
}: Props) {
  return (
    <aside className="kata__sidebar">
      <nav className="kata__nav">
        {courses.map((course) => (
          <CourseGroup
            key={course.id}
            course={course}
            isActiveCourse={course.id === activeCourseId}
            activeLessonId={activeLessonId}
            completed={completed}
            onSelectLesson={onSelectLesson}
          />
        ))}

        <button
          className="kata__nav-item kata__nav-item--browse"
          onClick={onBrowse}
        >
          <span className="kata__nav-icon">+</span>
          <span>import course</span>
        </button>
      </nav>

      <div className="kata__sidebar-footer">
        <button className="kata__nav-item" onClick={onSettings}>
          <span className="kata__nav-icon">⚙</span>
          <span>settings</span>
        </button>
      </div>
    </aside>
  );
}

function CourseGroup({
  course,
  isActiveCourse,
  activeLessonId,
  completed,
  onSelectLesson,
}: {
  course: Course;
  isActiveCourse: boolean;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
}) {
  const [expanded, setExpanded] = useState(isActiveCourse);

  const totalLessons = course.chapters.reduce((n, ch) => n + ch.lessons.length, 0);
  const doneLessons = course.chapters.reduce(
    (n, ch) => n + ch.lessons.filter((l) => completed.has(`${course.id}:${l.id}`)).length,
    0
  );
  const pct = totalLessons > 0 ? doneLessons / totalLessons : 0;

  return (
    <div className="kata__course">
      <button
        className={`kata__nav-item kata__course-title ${isActiveCourse ? "kata__nav-item--active" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="kata__course-caret" aria-hidden>
          <Icon
            icon={expanded ? chevronDown : chevronRight}
            size="xs"
            color="currentColor"
            weight="bold"
          />
        </span>
        <span className="kata__course-name">{course.title}</span>
        <span className="kata__course-progress">
          {doneLessons}/{totalLessons}
        </span>
      </button>

      {expanded && (
        <>
          <div className="kata__course-progress-bar">
            <div
              className="kata__course-progress-fill"
              style={{ width: `${pct * 100}%` }}
            />
          </div>
          {course.chapters.map((chapter) => (
            <ChapterBlock
              key={chapter.id}
              chapter={chapter}
              courseId={course.id}
              activeLessonId={isActiveCourse ? activeLessonId : undefined}
              completed={completed}
              onSelectLesson={onSelectLesson}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ChapterBlock({
  chapter,
  courseId,
  activeLessonId,
  completed,
  onSelectLesson,
}: {
  chapter: Chapter;
  courseId: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
}) {
  const done = chapter.lessons.filter((l) => completed.has(`${courseId}:${l.id}`)).length;
  const total = chapter.lessons.length;

  return (
    <div className="kata__chapter">
      <div className="kata__chapter-title">
        <span>{chapter.title}</span>
        <span className="kata__chapter-progress">
          {done}/{total}
        </span>
      </div>
      {chapter.lessons.map((lesson) => (
        <LessonRow
          key={lesson.id}
          lesson={lesson}
          isCompleted={completed.has(`${courseId}:${lesson.id}`)}
          isActive={lesson.id === activeLessonId}
          onSelect={() => onSelectLesson(courseId, lesson.id)}
        />
      ))}
    </div>
  );
}

function LessonRow({
  lesson,
  isCompleted,
  isActive,
  onSelect,
}: {
  lesson: Lesson;
  isCompleted: boolean;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`kata__nav-item kata__lesson-item ${isActive ? "kata__nav-item--active" : ""}`}
      onClick={onSelect}
    >
      <ProgressDot completed={isCompleted} active={isActive} />
      <span className="kata__lesson-name">{lesson.title}</span>
    </button>
  );
}

/**
 * Codecademy-style completion dot: hollow → ringed (active) → filled (done).
 */
function ProgressDot({ completed, active }: { completed: boolean; active: boolean }) {
  const state = completed ? "done" : active ? "active" : "pending";
  return (
    <span className={`kata__dot kata__dot--${state}`} aria-hidden>
      {completed ? "✓" : ""}
    </span>
  );
}
