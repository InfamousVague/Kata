import { useState } from "react";
import { seedCourses } from "./data/seedCourses";
import { Course, Lesson, isExerciseKind } from "./data/types";
import Sidebar from "./components/Sidebar/Sidebar";
import TopBar from "./components/TopBar/TopBar";
import LessonReader from "./components/Lesson/LessonReader";
import EditorPane from "./components/Editor/EditorPane";
import OutputPane from "./components/Output/OutputPane";
import { runCode, isPassing, type RunResult } from "./runtimes";
import "./App.css";

interface OpenCourse {
  courseId: string;
  lessonId: string;
}

export default function App() {
  const courses = seedCourses;

  const [openTabs, setOpenTabs] = useState<OpenCourse[]>([
    { courseId: courses[0].id, lessonId: courses[0].chapters[0].lessons[0].id },
  ]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  /// Keys are `${courseId}:${lessonId}`. When a lesson's tests pass (later) or
  /// it's a reading lesson the user scrolls through, it lands here and the
  /// sidebar dot fills in.
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  function markCompleted(courseId: string, lessonId: string) {
    const key = `${courseId}:${lessonId}`;
    setCompleted((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  const activeTab = openTabs[activeTabIndex];
  const activeCourse = courses.find((c) => c.id === activeTab?.courseId) ?? null;
  const activeLesson = findLesson(activeCourse, activeTab?.lessonId);

  function selectLesson(courseId: string, lessonId: string) {
    const existing = openTabs.findIndex((t) => t.courseId === courseId);
    if (existing >= 0) {
      const updated = [...openTabs];
      updated[existing] = { courseId, lessonId };
      setOpenTabs(updated);
      setActiveTabIndex(existing);
    } else {
      setOpenTabs([...openTabs, { courseId, lessonId }]);
      setActiveTabIndex(openTabs.length);
    }
  }

  function closeTab(index: number) {
    const next = openTabs.filter((_, i) => i !== index);
    setOpenTabs(next);
    if (activeTabIndex >= next.length) {
      setActiveTabIndex(Math.max(0, next.length - 1));
    } else if (activeTabIndex > index) {
      setActiveTabIndex(activeTabIndex - 1);
    }
  }

  const tabs = openTabs.map((t) => {
    const c = courses.find((x) => x.id === t.courseId);
    return {
      id: t.courseId,
      label: c?.title ?? t.courseId,
      language: c?.language ?? "javascript",
    };
  });

  return (
    <div className="kata">
      <TopBar
        tabs={tabs}
        activeIndex={activeTabIndex}
        onActivate={setActiveTabIndex}
        onClose={closeTab}
        onBrowse={() => {
          console.info("TODO: open library/browse view");
        }}
      />

      <div className="kata__body">
        <Sidebar
          courses={courses}
          activeCourseId={activeCourse?.id}
          activeLessonId={activeLesson?.id}
          completed={completed}
          onSelectLesson={selectLesson}
        />

        <main className="kata__main">
          {activeLesson && activeCourse ? (
            <LessonView
              lesson={activeLesson}
              onComplete={() => markCompleted(activeCourse.id, activeLesson.id)}
            />
          ) : (
            <div className="kata__empty">
              <p>Pick a lesson from the sidebar to get started.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function LessonView({
  lesson,
  onComplete,
}: {
  lesson: Lesson;
  onComplete: () => void;
}) {
  const hasExercise = isExerciseKind(lesson);
  const [code, setCode] = useState(hasExercise ? lesson.starter : "");
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);

  async function handleRun() {
    if (!hasExercise) return;
    setRunning(true);
    setResult(null);
    try {
      // Lesson has tests when it's an exercise/mixed kind — pass them so the
      // runtime evaluates them against the user's module.exports.
      const tests = "tests" in lesson ? lesson.tests : undefined;
      const r = await runCode(lesson.language, code, tests);
      setResult(r);
      if (isPassing(r)) onComplete();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="kata__lesson">
      <LessonReader lesson={lesson} />
      {hasExercise && (
        <div className="kata__workbench">
          <EditorPane
            language={lesson.language}
            value={code}
            onChange={setCode}
            onRun={handleRun}
          />
          <OutputPane result={result} running={running} />
        </div>
      )}
    </div>
  );
}

function findLesson(course: Course | null, lessonId: string | undefined): Lesson | null {
  if (!course || !lessonId) return null;
  for (const ch of course.chapters) {
    const found = ch.lessons.find((l) => l.id === lessonId);
    if (found) return found;
  }
  return null;
}
