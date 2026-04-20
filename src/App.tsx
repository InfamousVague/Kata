import { useEffect, useState } from "react";
import { Course, Lesson, isExerciseKind } from "./data/types";
import Sidebar from "./components/Sidebar/Sidebar";
import TopBar from "./components/TopBar/TopBar";
import LessonReader from "./components/Lesson/LessonReader";
import EditorPane from "./components/Editor/EditorPane";
import OutputPane from "./components/Output/OutputPane";
import ImportDialog from "./components/ImportDialog/ImportDialog";
import SettingsDialog from "./components/SettingsDialog/SettingsDialog";
import { runCode, isPassing, type RunResult } from "./runtimes";
import { useProgress } from "./hooks/useProgress";
import { useCourses } from "./hooks/useCourses";
import "./App.css";

interface OpenCourse {
  courseId: string;
  lessonId: string;
}

export default function App() {
  const { courses, loaded: coursesLoaded, refresh: refreshCourses } = useCourses();

  const [openTabs, setOpenTabs] = useState<OpenCourse[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /// Completion state lives in SQLite; the hook loads on mount and writes
  /// through on markCompleted. Keys are `${courseId}:${lessonId}`.
  const { completed, markCompleted } = useProgress();

  // Once courses are loaded, open the first lesson of the first course.
  useEffect(() => {
    if (coursesLoaded && courses.length > 0 && openTabs.length === 0) {
      const first = courses[0];
      setOpenTabs([
        { courseId: first.id, lessonId: first.chapters[0].lessons[0].id },
      ]);
    }
  }, [coursesLoaded, courses, openTabs.length]);

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
        onBrowse={() => setImportOpen(true)}
      />

      <div className="kata__body">
        <Sidebar
          courses={courses}
          activeCourseId={activeCourse?.id}
          activeLessonId={activeLesson?.id}
          completed={completed}
          onSelectLesson={selectLesson}
          onBrowse={() => setImportOpen(true)}
          onSettings={() => setSettingsOpen(true)}
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

      {settingsOpen && <SettingsDialog onDismiss={() => setSettingsOpen(false)} />}

      {importOpen && (
        <ImportDialog
          onDismiss={() => setImportOpen(false)}
          onImported={async (courseId) => {
            setImportOpen(false);
            const fresh = await refreshCourses();
            const imported = fresh.find((c) => c.id === courseId);
            if (!imported || imported.chapters.length === 0) return;
            const firstLessonId = imported.chapters[0].lessons[0]?.id;
            if (!firstLessonId) return;
            setOpenTabs((prev) => {
              const without = prev.filter((t) => t.courseId !== courseId);
              const next = [...without, { courseId, lessonId: firstLessonId }];
              setActiveTabIndex(next.length - 1);
              return next;
            });
          }}
        />
      )}
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
