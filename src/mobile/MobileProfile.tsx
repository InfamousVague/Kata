/// Mobile profile — phone-sized version of the desktop ProfileView.
/// Four stat cards at the top (streak, lessons, XP, level), then a
/// recent-activity list of the last few completed lessons.

import { useMemo } from "react";
import type { Course } from "../data/types";
import type { Completion } from "../hooks/useProgress";
import type { StreakAndXp } from "../hooks/useStreakAndXp";
import "./MobileProfile.css";

interface Props {
  courses: Course[];
  history: Completion[];
  stats: StreakAndXp;
  completed: Set<string>;
  onOpenLesson: (course: Course, chapterIndex: number, lessonIndex: number) => void;
}

interface RecentRow {
  course: Course;
  chapterIndex: number;
  lessonIndex: number;
  lessonTitle: string;
  completedAt: number;
}

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

export default function MobileProfile({
  courses,
  history,
  stats,
  completed,
  onOpenLesson,
}: Props) {
  // Per-course aggregates for the "in progress" rail.
  const courseProgress = useMemo(() => {
    const out: Array<{ course: Course; pct: number; done: number; total: number }> = [];
    for (const c of courses) {
      let total = 0;
      let done = 0;
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          total += 1;
          if (completed.has(`${c.id}:${l.id}`)) done += 1;
        }
      }
      if (done > 0 && done < total) {
        out.push({ course: c, pct: Math.round((done / total) * 100), done, total });
      }
    }
    // Most progress first so the rail feels like a "continue here" list.
    out.sort((a, b) => b.pct - a.pct);
    return out.slice(0, 6);
  }, [courses, completed]);

  // Recent completions, newest first, stitched back to course/chapter/lesson
  // so each row navigates somewhere when tapped.
  const recents = useMemo(() => {
    const rows: RecentRow[] = [];
    // Index lessons by `${courseId}:${lessonId}` for quick lookup.
    const idx = new Map<string, { course: Course; ci: number; li: number }>();
    for (const c of courses) {
      for (let ci = 0; ci < c.chapters.length; ci++) {
        const ch = c.chapters[ci];
        for (let li = 0; li < ch.lessons.length; li++) {
          idx.set(`${c.id}:${ch.lessons[li].id}`, { course: c, ci, li });
        }
      }
    }
    for (const h of [...history].sort((a, b) => b.completed_at - a.completed_at)) {
      const found = idx.get(`${h.course_id}:${h.lesson_id}`);
      if (!found) continue;
      const lesson = found.course.chapters[found.ci]?.lessons[found.li];
      if (!lesson) continue;
      rows.push({
        course: found.course,
        chapterIndex: found.ci,
        lessonIndex: found.li,
        lessonTitle: lesson.title,
        completedAt: h.completed_at,
      });
      if (rows.length >= 12) break;
    }
    return rows;
  }, [history, courses]);

  return (
    <div className="m-prof">
      <header className="m-prof__head">
        <h1 className="m-prof__title">Profile</h1>
      </header>

      <div className="m-prof__stats" role="list">
        <div className="m-prof__stat" role="listitem">
          <span className="m-prof__stat-value">{stats.streakDays}</span>
          <span className="m-prof__stat-label">Day streak</span>
        </div>
        <div className="m-prof__stat" role="listitem">
          <span className="m-prof__stat-value">{stats.lessonsCompleted}</span>
          <span className="m-prof__stat-label">Lessons</span>
        </div>
        <div className="m-prof__stat" role="listitem">
          <span className="m-prof__stat-value">{stats.xp}</span>
          <span className="m-prof__stat-label">XP</span>
        </div>
        <div className="m-prof__stat" role="listitem">
          <span className="m-prof__stat-value">{stats.level}</span>
          <span className="m-prof__stat-label">Level</span>
        </div>
      </div>

      {/* Level progress bar — XP into the current level vs total
          required for the next level. */}
      <div className="m-prof__level">
        <div className="m-prof__level-meta">
          <span>Level {stats.level}</span>
          <span>
            {stats.xpIntoLevel}/{stats.xpForLevel} XP
          </span>
        </div>
        <div
          className="m-prof__level-bar"
          aria-hidden
          style={
            {
              "--m-prof-pct": `${stats.xpForLevel > 0 ? Math.round((stats.xpIntoLevel / stats.xpForLevel) * 100) : 0}%`,
            } as React.CSSProperties
          }
        />
      </div>

      {courseProgress.length > 0 && (
        <section className="m-prof__section">
          <h3 className="m-prof__section-title">Continue learning</h3>
          <ul className="m-prof__continue" role="list">
            {courseProgress.map(({ course, pct, done, total }) => (
              <li key={course.id}>
                <button
                  type="button"
                  className="m-prof__continue-row"
                  onClick={() => {
                    // Find first uncompleted lesson; same logic as
                    // MobileLibrary's nextLessonOf.
                    for (let ci = 0; ci < course.chapters.length; ci++) {
                      const ch = course.chapters[ci];
                      for (let li = 0; li < ch.lessons.length; li++) {
                        if (!completed.has(`${course.id}:${ch.lessons[li].id}`)) {
                          onOpenLesson(course, ci, li);
                          return;
                        }
                      }
                    }
                    onOpenLesson(course, 0, 0);
                  }}
                >
                  <div className="m-prof__continue-text">
                    <span className="m-prof__continue-title">{course.title}</span>
                    <span className="m-prof__continue-meta">
                      {done}/{total} · {pct}%
                    </span>
                  </div>
                  <div
                    className="m-prof__continue-bar"
                    aria-hidden
                    style={{ "--m-prof-pct": `${pct}%` } as React.CSSProperties}
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="m-prof__section">
        <h3 className="m-prof__section-title">Recent</h3>
        {recents.length === 0 ? (
          <p className="m-prof__empty">
            No completions yet. Open a course in the Library to get started.
          </p>
        ) : (
          <ul className="m-prof__recents" role="list">
            {recents.map((r) => (
              <li key={`${r.course.id}-${r.chapterIndex}-${r.lessonIndex}`}>
                <button
                  type="button"
                  className="m-prof__recent-row"
                  onClick={() => onOpenLesson(r.course, r.chapterIndex, r.lessonIndex)}
                >
                  <div className="m-prof__recent-text">
                    <span className="m-prof__recent-title">{r.lessonTitle}</span>
                    <span className="m-prof__recent-meta">
                      {r.course.title} · {timeAgo(r.completedAt)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
