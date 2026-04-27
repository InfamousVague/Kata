/// Mobile root. Renders a totally separate tree from the desktop App
/// — no TopBar, no Sidebar, no editor, no Playground, no AI orb.
/// Four bottom tabs: Library / Lesson / Profile / Settings.
///
/// The desktop App.tsx short-circuits to <MobileApp /> when the
/// `isMobile` predicate fires, so we don't pay for any of the
/// desktop chrome on phone-sized devices. Reuses the same hooks
/// (`useCourses`, `useProgress`, `useFishbonesCloud`, `useStreakAndXp`)
/// so progress, streak/XP, and account state flow through the existing
/// storage and relay backends without per-platform branches.

import { useMemo, useState } from "react";
import { useCourses } from "../hooks/useCourses";
import { useProgress } from "../hooks/useProgress";
import { useFishbonesCloud } from "../hooks/useFishbonesCloud";
import { useStreakAndXp } from "../hooks/useStreakAndXp";
import type { Course, Lesson } from "../data/types";
import MobileLibrary from "./MobileLibrary";
import MobileLesson from "./MobileLesson";
import MobileProfile from "./MobileProfile";
import MobileSettings from "./MobileSettings";
import SignInDialog from "../components/SignInDialog/SignInDialog";
import MobileTabBar, { type MobileTab } from "../components/MobileTabBar/MobileTabBar";
import FishbonesLoader from "../components/Shared/FishbonesLoader";
import "./MobileApp.css";

type View = "library" | "lesson" | "profile" | "settings";

interface ActiveLesson {
  course: Course;
  chapterIndex: number;
  lessonIndex: number;
}

export default function MobileApp() {
  const { courses, loaded, hydrateCourse } = useCourses();
  const { completed, history, markCompleted, resetProgress } = useProgress();
  const cloud = useFishbonesCloud();
  const stats = useStreakAndXp(history, courses);
  const [view, setView] = useState<View>("library");
  const [active, setActive] = useState<ActiveLesson | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  const lesson: Lesson | null = useMemo(() => {
    if (!active) return null;
    const ch = active.course.chapters[active.chapterIndex];
    if (!ch) return null;
    return ch.lessons[active.lessonIndex] ?? null;
  }, [active]);

  const openLesson = async (course: Course, chapterIndex: number, lessonIndex: number) => {
    const hydrated = await hydrateCourse(course.id);
    setActive({ course: hydrated ?? course, chapterIndex, lessonIndex });
    setView("lesson");
  };

  const goNext = () => {
    if (!active) return;
    const ch = active.course.chapters[active.chapterIndex];
    if (!ch) return;
    if (active.lessonIndex + 1 < ch.lessons.length) {
      setActive({ ...active, lessonIndex: active.lessonIndex + 1 });
      return;
    }
    if (active.chapterIndex + 1 < active.course.chapters.length) {
      setActive({
        ...active,
        chapterIndex: active.chapterIndex + 1,
        lessonIndex: 0,
      });
    }
  };

  const goPrev = () => {
    if (!active) return;
    if (active.lessonIndex > 0) {
      setActive({ ...active, lessonIndex: active.lessonIndex - 1 });
      return;
    }
    if (active.chapterIndex > 0) {
      const prevCh = active.course.chapters[active.chapterIndex - 1];
      setActive({
        ...active,
        chapterIndex: active.chapterIndex - 1,
        lessonIndex: Math.max(0, prevCh.lessons.length - 1),
      });
    }
  };

  const hasPrev = active
    ? active.chapterIndex > 0 || active.lessonIndex > 0
    : false;
  const hasNext = active
    ? active.chapterIndex + 1 < active.course.chapters.length ||
      active.lessonIndex + 1 < active.course.chapters[active.chapterIndex].lessons.length
    : false;

  const onComplete = () => {
    if (!active || !lesson) return;
    void markCompleted(active.course.id, lesson.id);
    goNext();
  };

  // Used by the Settings "Reset local progress" button. We reset the
  // hook's in-memory + storage state in one shot.
  const resetLocalProgress = async () => {
    await resetProgress();
  };

  // Map app view → tab id. The tab bar's "courses" segment is for the
  // active lesson; everything else is a 1:1 view-to-tab mapping.
  const activeTab: MobileTab =
    view === "lesson"
      ? "courses"
      : view === "profile"
        ? "profile"
        : view === "settings"
          ? "settings"
          : "library";

  return (
    <div className="m-app">
      {!loaded && (
        <div className="m-app__boot">
          <FishbonesLoader label="loading" />
        </div>
      )}

      <main className="m-app__main">
        {view === "library" && (
          <MobileLibrary
            courses={courses}
            completed={completed}
            onOpenLesson={openLesson}
          />
        )}
        {view === "lesson" && active && lesson && (
          <MobileLesson
            course={active.course}
            chapterIndex={active.chapterIndex}
            lessonIndex={active.lessonIndex}
            lesson={lesson}
            completed={completed}
            onBack={() => setView("library")}
            onComplete={onComplete}
            onPrev={hasPrev ? goPrev : undefined}
            onNext={hasNext ? goNext : undefined}
            onJump={(ci, li) =>
              setActive({ course: active.course, chapterIndex: ci, lessonIndex: li })
            }
            isCompleted={completed.has(`${active.course.id}:${lesson.id}`)}
          />
        )}
        {view === "profile" && (
          <MobileProfile
            courses={courses}
            history={history}
            stats={stats}
            completed={completed}
            onOpenLesson={openLesson}
          />
        )}
        {view === "settings" && (
          <MobileSettings
            cloud={cloud}
            onRequestSignIn={() => setSignInOpen(true)}
            onResetProgress={resetLocalProgress}
          />
        )}
      </main>

      <MobileTabBar
        active={activeTab}
        hasActiveLesson={active !== null}
        onLibrary={() => setView("library")}
        onLesson={() => {
          if (active) setView("lesson");
        }}
        onProfile={() => setView("profile")}
        onSettings={() => setView("settings")}
      />

      {signInOpen && (
        <SignInDialog
          cloud={cloud}
          onClose={() => setSignInOpen(false)}
        />
      )}
    </div>
  );
}
