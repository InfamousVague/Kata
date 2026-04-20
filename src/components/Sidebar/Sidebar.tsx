import { useState } from "react";
import type { Course } from "../../data/types";
import "./Sidebar.css";

interface Props {
  courses: Course[];
  activeCourseId?: string;
  activeLessonId?: string;
  onSelectLesson: (courseId: string, lessonId: string) => void;
}

/// Left rail: list of courses, each expandable to show chapters → lessons.
/// Purely presentational for V1 — no progress or streak yet.
export default function Sidebar({
  courses,
  activeCourseId,
  activeLessonId,
  onSelectLesson,
}: Props) {
  return (
    <aside className="kata-sidebar">
      <div className="kata-sidebar-header">
        <span className="kata-logo">kata</span>
      </div>

      <nav className="kata-sidebar-nav">
        {courses.map((course) => (
          <CourseGroup
            key={course.id}
            course={course}
            isActiveCourse={course.id === activeCourseId}
            activeLessonId={activeLessonId}
            onSelectLesson={onSelectLesson}
          />
        ))}

        <button
          className="kata-sidebar-browse"
          onClick={() => console.info("TODO: open library browse view")}
        >
          + browse courses
        </button>
      </nav>

      <div className="kata-sidebar-footer">
        <button className="kata-sidebar-settings">settings</button>
      </div>
    </aside>
  );
}

function CourseGroup({
  course,
  isActiveCourse,
  activeLessonId,
  onSelectLesson,
}: {
  course: Course;
  isActiveCourse: boolean;
  activeLessonId?: string;
  onSelectLesson: (courseId: string, lessonId: string) => void;
}) {
  const [expanded, setExpanded] = useState(isActiveCourse);

  return (
    <div className="kata-course">
      <button
        className={`kata-course-title ${isActiveCourse ? "active" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="kata-course-caret">{expanded ? "▾" : "▸"}</span>
        <span className="kata-course-name">{course.title}</span>
      </button>

      {expanded &&
        course.chapters.map((chapter) => (
          <div key={chapter.id} className="kata-chapter">
            <div className="kata-chapter-title">{chapter.title}</div>
            {chapter.lessons.map((lesson) => (
              <button
                key={lesson.id}
                className={`kata-lesson-item ${
                  lesson.id === activeLessonId && isActiveCourse ? "active" : ""
                }`}
                onClick={() => onSelectLesson(course.id, lesson.id)}
              >
                <span className="kata-lesson-kind">{lessonGlyph(lesson.kind)}</span>
                <span className="kata-lesson-name">{lesson.title}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

function lessonGlyph(kind: "reading" | "exercise" | "mixed"): string {
  switch (kind) {
    case "reading":
      return "◌";
    case "exercise":
      return "●";
    case "mixed":
      return "◐";
  }
}
