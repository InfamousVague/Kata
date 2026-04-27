import { useMemo } from "react";
import { Icon } from "@base/primitives/icon";
import { flame } from "@base/primitives/icon/icons/flame";
import { check } from "@base/primitives/icon/icons/check";
import { sparkles } from "@base/primitives/icon/icons/sparkles";
import { trophy } from "@base/primitives/icon/icons/trophy";
import "@base/primitives/icon/icon.css";
import type { Course, LanguageId } from "../../data/types";
import { isExerciseKind } from "../../data/types";
import type { Completion } from "../../hooks/useProgress";
import type { StreakAndXp } from "../../hooks/useStreakAndXp";
import { ProgressRing } from "../Shared/ProgressRing";
import LanguageChip from "../LanguageChip/LanguageChip";
import "./ProfileView.css";

/// Per-lesson XP — MUST stay in sync with useStreakAndXp. Kept duplicated
/// (not imported) because that hook exports the computed totals, not the
/// per-kind map. If we ever add a kind, update both in the same commit.
const XP_PER_KIND = { reading: 5, quiz: 10, exercise: 20, mixed: 20 } as const;

const STAT_COLORS = {
  streak: "#ff9b5e",
  lessons: "#7cd97c",
  xp: "#e8c46b",
  longest: "#c79bff",
} as const;

interface Props {
  courses: Course[];
  completed: Set<string>;
  history: Completion[];
  stats: StreakAndXp;
  /// Called when the learner clicks a recent-activity row — jumps back to
  /// that lesson in courses view.
  onOpenLesson: (courseId: string, lessonId: string) => void;
}

/// Profile / stats page. Reads directly from the same sources the top-bar
/// chip uses, but lays everything out as a dedicated surface instead of
/// a dropdown — hero ring, per-language breakdown, topic buckets,
/// recent-activity timeline.
export default function ProfileView({
  courses,
  completed,
  history,
  stats,
  onOpenLesson,
}: Props) {
  /// Build a lookup of `{courseId: course}` and flatten all lessons once
  /// so downstream math can resolve completions without nested scans.
  const { courseById, lessonById } = useMemo(() => {
    const byCourse = new Map<string, Course>();
    const byLesson = new Map<string, {
      course: Course;
      lesson: Course["chapters"][number]["lessons"][number];
    }>();
    for (const c of courses) {
      byCourse.set(c.id, c);
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          byLesson.set(`${c.id}:${l.id}`, { course: c, lesson: l });
        }
      }
    }
    return { courseById: byCourse, lessonById: byLesson };
  }, [courses]);

  /// Per-language breakdown. We walk completions, find the course each
  /// one belongs to, and bucket by the course's language. XP per kind
  /// mirrors the global XP curve.
  const languageStats = useMemo(() => {
    type LangRow = {
      language: LanguageId;
      lessonsDone: number;
      lessonsTotal: number;
      xp: number;
      latest: number;
    };
    const bucket = new Map<LanguageId, LangRow>();

    // Seed totals from every course's known lesson count — gives the UI
    // a "done/total" fraction per language even before the learner starts.
    for (const c of courses) {
      const lang = c.language;
      const lessonsInCourse = c.chapters.reduce(
        (n, ch) => n + ch.lessons.length,
        0,
      );
      const row = bucket.get(lang) ?? {
        language: lang,
        lessonsDone: 0,
        lessonsTotal: 0,
        xp: 0,
        latest: 0,
      };
      row.lessonsTotal += lessonsInCourse;
      bucket.set(lang, row);
    }

    for (const h of history) {
      const key = `${h.course_id}:${h.lesson_id}`;
      const resolved = lessonById.get(key);
      if (!resolved) continue; // orphaned completion (course deleted)
      const row = bucket.get(resolved.course.language);
      if (!row) continue;
      row.lessonsDone += 1;
      row.xp += XP_PER_KIND[resolved.lesson.kind] ?? 0;
      if (h.completed_at > row.latest) row.latest = h.completed_at;
    }

    // Only surface languages the learner has actually touched. If nothing
    // was completed, show the whole roster with zero counts so the page
    // looks intentional rather than empty.
    const hasAnyCompletion = history.length > 0;
    return Array.from(bucket.values())
      .filter((r) => !hasAnyCompletion || r.lessonsDone > 0)
      .sort((a, b) => b.xp - a.xp || b.lessonsDone - a.lessonsDone);
  }, [courses, history, lessonById]);

  /// Per-topic breakdown (challenge packs only). Exercise kinds that
  /// carry a `topic` string get bucketed here so the learner sees which
  /// skills they've drilled vs. which are still fresh. Courses without
  /// topics (all book-imported content) don't contribute.
  const topicStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of history) {
      const resolved = lessonById.get(`${h.course_id}:${h.lesson_id}`);
      if (!resolved) continue;
      if (!isExerciseKind(resolved.lesson)) continue;
      const topic = resolved.lesson.topic;
      if (!topic) continue;
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count);
  }, [history, lessonById]);

  /// Newest-first slice of completions resolved to course + lesson titles,
  /// capped at 20 so long histories don't blow up the timeline. Orphaned
  /// completions (course deleted) are dropped rather than shown as "?".
  const recentActivity = useMemo(() => {
    const sorted = history
      .slice()
      .sort((a, b) => b.completed_at - a.completed_at);
    const out: Array<{
      courseId: string;
      lessonId: string;
      courseTitle: string;
      lessonTitle: string;
      kind: string;
      completedAt: number;
    }> = [];
    for (const h of sorted) {
      if (out.length >= 20) break;
      const resolved = lessonById.get(`${h.course_id}:${h.lesson_id}`);
      if (!resolved) continue;
      out.push({
        courseId: h.course_id,
        lessonId: h.lesson_id,
        courseTitle: resolved.course.title,
        lessonTitle: resolved.lesson.title,
        kind: resolved.lesson.kind,
        completedAt: h.completed_at,
      });
    }
    return out;
  }, [history, lessonById]);

  const levelProgress =
    stats.xpForLevel > 0 ? stats.xpIntoLevel / stats.xpForLevel : 0;
  const xpToNext = Math.max(0, stats.xpForLevel - stats.xpIntoLevel);

  // Unused but kept for future "drill into a language" CTAs.
  void courseById;
  void completed;

  return (
    <div className="fishbones-profile">
      <div className="fishbones-profile-scroll">
        <div className="fishbones-profile-inner">
          {/* Hero: big level ring on the left, headline stats on the right. */}
          <section className="fishbones-profile-hero">
            <ProgressRing
              progress={levelProgress}
              size={120}
              stroke={8}
              label={String(stats.level)}
              sublabel="level"
              labelScale={2.2}
            />
            <div className="fishbones-profile-hero-body">
              <h1 className="fishbones-profile-hero-title">Level {stats.level}</h1>
              <div className="fishbones-profile-hero-sub">
                {stats.xpIntoLevel} / {stats.xpForLevel} XP
                {" · "}
                {xpToNext === 0
                  ? "ready to level up!"
                  : `${xpToNext} XP to level ${stats.level + 1}`}
              </div>
              <div className="fishbones-profile-hero-chips">
                <HeroChip
                  icon={flame}
                  color={STAT_COLORS.streak}
                  label="Current streak"
                  value={`${stats.streakDays} ${stats.streakDays === 1 ? "day" : "days"}`}
                />
                <HeroChip
                  icon={check}
                  color={STAT_COLORS.lessons}
                  label="Lessons done"
                  value={String(stats.lessonsCompleted)}
                />
                <HeroChip
                  icon={sparkles}
                  color={STAT_COLORS.xp}
                  label="Total XP"
                  value={String(stats.xp)}
                />
                <HeroChip
                  icon={trophy}
                  color={STAT_COLORS.longest}
                  label="Longest streak"
                  value={`${stats.longestStreakDays} ${stats.longestStreakDays === 1 ? "day" : "days"}`}
                />
              </div>
            </div>
          </section>

          {/* Per-language progress. One card per language the learner has
              touched; hidden entirely if they haven't completed anything. */}
          {languageStats.length > 0 && (
            <section className="fishbones-profile-section">
              <h2 className="fishbones-profile-section-title">Languages practised</h2>
              <div className="fishbones-profile-lang-grid">
                {languageStats.map((row) => {
                  const pct =
                    row.lessonsTotal > 0
                      ? Math.min(1, row.lessonsDone / row.lessonsTotal)
                      : 0;
                  return (
                    <div key={row.language} className="fishbones-profile-lang-card">
                      <div className="fishbones-profile-lang-head">
                        <LanguageChip language={row.language} size="md" />
                      </div>
                      <div className="fishbones-profile-lang-stats">
                        <div>
                          <div className="fishbones-profile-lang-value">
                            {row.lessonsDone}
                            <span className="fishbones-profile-lang-subvalue">
                              {" "}/ {row.lessonsTotal}
                            </span>
                          </div>
                          <div className="fishbones-profile-lang-label">lessons</div>
                        </div>
                        <div>
                          <div className="fishbones-profile-lang-value">{row.xp}</div>
                          <div className="fishbones-profile-lang-label">XP</div>
                        </div>
                      </div>
                      <div className="fishbones-profile-lang-bar" aria-hidden>
                        <div
                          className="fishbones-profile-lang-bar-fill"
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Topics — pulled only from challenge-pack lessons (they carry
              the `topic` tag). Empty until the user has worked through
              some challenges. */}
          <section className="fishbones-profile-section">
            <div className="fishbones-profile-section-head">
              <h2 className="fishbones-profile-section-title">Topics practised</h2>
            </div>
            {topicStats.length > 0 ? (
              <div className="fishbones-profile-topic-grid">
                {topicStats.map((t) => (
                  <div key={t.topic} className="fishbones-profile-topic-chip">
                    <span className="fishbones-profile-topic-name">{t.topic}</span>
                    <span className="fishbones-profile-topic-count">{t.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="fishbones-profile-empty">
                No topics yet — generate a challenge pack and the skills you
                drill will show up here.
              </p>
            )}
          </section>

          {/* Recent activity timeline. Clicks jump back to the lesson. */}
          <section className="fishbones-profile-section">
            <h2 className="fishbones-profile-section-title">Recent activity</h2>
            {recentActivity.length > 0 ? (
              <ul className="fishbones-profile-activity">
                {recentActivity.map((r, i) => (
                  <li key={`${r.courseId}:${r.lessonId}:${i}`}>
                    <button
                      className="fishbones-profile-activity-row"
                      onClick={() => onOpenLesson(r.courseId, r.lessonId)}
                    >
                      <span
                        className={`fishbones-profile-activity-kind fishbones-profile-activity-kind--${r.kind}`}
                        aria-hidden
                      />
                      <span className="fishbones-profile-activity-body">
                        <span className="fishbones-profile-activity-lesson">
                          {r.lessonTitle}
                        </span>
                        <span className="fishbones-profile-activity-course">
                          {r.courseTitle}
                        </span>
                      </span>
                      <span className="fishbones-profile-activity-time">
                        {formatRelative(r.completedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fishbones-profile-empty">
                No completed lessons yet. Pick a course in the sidebar to start
                building your profile.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/// Small coloured-icon + label + value chip for the hero row. Visually
/// matches the stats-dropdown chips so the Profile page feels like the
/// expanded version of that same widget.
function HeroChip({
  icon,
  color,
  label,
  value,
}: {
  icon: string;
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="fishbones-profile-hero-chip">
      <div className="fishbones-profile-hero-chip-label" style={{ color }}>
        <span className="fishbones-profile-hero-chip-icon" aria-hidden>
          <Icon icon={icon} size="xs" color="currentColor" weight="bold" />
        </span>
        {label}
      </div>
      <div className="fishbones-profile-hero-chip-value">{value}</div>
    </div>
  );
}

/// Unix-seconds → "3m ago" / "2h ago" / "yesterday" / "Apr 12" style label.
/// Keeps the timeline skimmable — the exact wall-clock time is rarely
/// useful here; relative time tells the story.
function formatRelative(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 2) return "yesterday";
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
