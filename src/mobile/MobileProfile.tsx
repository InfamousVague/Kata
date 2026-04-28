/// Mobile profile — phone-sized version of the desktop ProfileView.
/// Reads progress data straight off the same hooks the desktop tree
/// uses so streak / XP / completions stay in lockstep across surfaces.
///
/// The screen is a stack of richly-iconed visual modules, each
/// answering a different "how am I doing?" question:
///
///   1. Streak + Level rings — twin circular gauges that show the
///      learner's two most-mentioned numbers (consecutive days, and
///      progress toward the next level) in one glance.
///   2. Stat tiles — four small cards (streak, lessons, XP, level)
///      with kind-specific icons for at-a-glance scanning.
///   3. Activity heatmap — a 12-week 7×N grid of daily completion
///      counts, GitHub-contribution-style. Long-running learners get
///      a satisfying mosaic; absent days don't shame, they just sit
///      muted.
///   4. Per-language XP — a horizontal bar chart broken down by
///      language, sorted descending. Doubles as "languages I've
///      touched" — feeds the Practice tab's "Covered" pill.
///   5. Milestone badges — a row of unlock-able achievement
///      iconography (first lesson, weekly streak, exercise grinder,
///      etc) that fills in as the learner progresses. Locked
///      badges are dimmed instead of hidden so the next goal is
///      visible.
///   6. Continue learning — same in-progress courses rail as before.
///   7. Recent — last few completed lessons.

import { useMemo } from "react";
import type { Course, LanguageId } from "../data/types";
import type { Completion } from "../hooks/useProgress";
import type { StreakAndXp } from "../hooks/useStreakAndXp";
import { Icon } from "@base/primitives/icon";
import { search as searchIcon } from "@base/primitives/icon/icons/search";
import { flame } from "@base/primitives/icon/icons/flame";
import { zap } from "@base/primitives/icon/icons/zap";
import { trophy } from "@base/primitives/icon/icons/trophy";
import { bookOpenCheck } from "@base/primitives/icon/icons/book-open-check";
import { sparkles } from "@base/primitives/icon/icons/sparkles";
import { rocket } from "@base/primitives/icon/icons/rocket";
import { brain } from "@base/primitives/icon/icons/brain";
import { graduationCap } from "@base/primitives/icon/icons/graduation-cap";
import { star } from "@base/primitives/icon/icons/star";
import { award } from "@base/primitives/icon/icons/award";
import { crown } from "@base/primitives/icon/icons/crown";
import { medal } from "@base/primitives/icon/icons/medal";
import { target } from "@base/primitives/icon/icons/target";
import "./MobileProfile.css";

interface Props {
  courses: Course[];
  history: Completion[];
  stats: StreakAndXp;
  completed: Set<string>;
  onOpenLesson: (course: Course, chapterIndex: number, lessonIndex: number) => void;
  /// Optional — fired by the top-right search button. Mirrors the
  /// MobileLibrary signature so MobileApp can wire the same handler
  /// to both screens.
  onOpenSearch?: () => void;
}

interface RecentRow {
  course: Course;
  chapterIndex: number;
  lessonIndex: number;
  lessonTitle: string;
  completedAt: number;
}

const HEATMAP_WEEKS = 12;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

const LANG_LABELS: Partial<Record<LanguageId, string>> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  reactnative: "React Native",
  svelte: "Svelte",
  solid: "Solid",
  htmx: "HTMX",
  astro: "Astro",
  bun: "Bun",
  solidity: "Solidity",
  vyper: "Vyper",
  c: "C",
  cpp: "C++",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  swift: "Swift",
  assembly: "Assembly",
  threejs: "Three.js",
  web: "Web",
  react: "React",
  tauri: "Tauri",
};

/// XP awards mirror `useStreakAndXp`. Re-declared here (rather than
/// imported) because the hook's table is private — when XP rules
/// change, both tables get bumped. Tested informally by checking
/// that the per-language breakdown sums to the headline `stats.xp`.
const XP_PER_KIND: Record<string, number> = {
  reading: 5,
  quiz: 10,
  cloze: 10,
  micropuzzle: 10,
  puzzle: 15,
  exercise: 20,
  mixed: 20,
};

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

function localDayKey(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function langLabel(id: LanguageId): string {
  return LANG_LABELS[id] ?? id;
}

export default function MobileProfile({
  courses,
  history,
  stats,
  completed,
  onOpenLesson,
  onOpenSearch,
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
    out.sort((a, b) => b.pct - a.pct);
    return out.slice(0, 6);
  }, [courses, completed]);

  // Recent completions (last 12), newest first, stitched back to
  // course/chapter/lesson so each row navigates somewhere.
  const recents = useMemo(() => {
    const rows: RecentRow[] = [];
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

  // 12-week activity grid. We stamp each completion to its local
  // day, then walk back HEATMAP_DAYS days from today building a
  // count map. The grid below is rendered column-major (each column
  // is a week, top-to-bottom = Sun-to-Sat).
  const heatmap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of history) {
      const key = localDayKey(c.completed_at);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cells: Array<{ key: string; count: number; label: string }> = [];
    for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const key = `${d.getFullYear()}-${m}-${day}`;
      const count = counts.get(key) ?? 0;
      cells.push({
        key,
        count,
        label: `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${count} lesson${count === 1 ? "" : "s"}`,
      });
    }
    // Find a stable "max" for color binning — anchored to the busy
    // days in the window, not all-time, so a single 50-lesson day
    // months ago doesn't squash the rest of the chart into pale
    // boxes.
    const peak = Math.max(1, ...cells.map((c) => c.count));
    return { cells, peak };
  }, [history]);

  // Per-language XP breakdown. Each completion's lesson kind is
  // looked up in `kindByKey`; the language comes from the course
  // record. Sorted descending; capped to the top 6 so the chart
  // doesn't sprawl.
  const langChart = useMemo(() => {
    const xpByLang = new Map<LanguageId, number>();
    const kindByKey = new Map<string, string>();
    const langByCourse = new Map<string, LanguageId>();
    for (const c of courses) {
      langByCourse.set(c.id, c.language);
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          kindByKey.set(`${c.id}:${l.id}`, l.kind);
        }
      }
    }
    for (const h of history) {
      const lang = langByCourse.get(h.course_id);
      if (!lang) continue;
      const kind = kindByKey.get(`${h.course_id}:${h.lesson_id}`) ?? "reading";
      const xp = XP_PER_KIND[kind] ?? XP_PER_KIND.reading;
      xpByLang.set(lang, (xpByLang.get(lang) ?? 0) + xp);
    }
    const total = Array.from(xpByLang.values()).reduce((a, b) => a + b, 0);
    const rows = Array.from(xpByLang.entries())
      .map(([lang, xp]) => ({ lang, xp, pct: total > 0 ? xp / total : 0 }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 6);
    return { rows, total };
  }, [history, courses]);

  // Milestone unlocks. Each is a small stateful object — the
  // renderer styles earned ones as bright + the rest as muted with
  // a small "x/y" progress hint. Order is roughly easiest → hardest.
  const milestones = useMemo<MilestoneSpec[]>(
    () => [
      {
        id: "first-lesson",
        label: "First lesson",
        icon: bookOpenCheck,
        target: 1,
        actual: stats.lessonsCompleted,
        unit: "lesson",
      },
      {
        id: "ten-lessons",
        label: "Ten lessons",
        icon: graduationCap,
        target: 10,
        actual: stats.lessonsCompleted,
        unit: "lessons",
      },
      {
        id: "hundred-lessons",
        label: "Century",
        icon: trophy,
        target: 100,
        actual: stats.lessonsCompleted,
        unit: "lessons",
      },
      {
        id: "streak-3",
        label: "3-day streak",
        icon: flame,
        target: 3,
        actual: Math.max(stats.streakDays, stats.longestStreakDays),
        unit: "days",
      },
      {
        id: "streak-7",
        label: "Week strong",
        icon: target,
        target: 7,
        actual: Math.max(stats.streakDays, stats.longestStreakDays),
        unit: "days",
      },
      {
        id: "streak-30",
        label: "Iron habit",
        icon: medal,
        target: 30,
        actual: Math.max(stats.streakDays, stats.longestStreakDays),
        unit: "days",
      },
      {
        id: "level-5",
        label: "Apprentice",
        icon: star,
        target: 5,
        actual: stats.level,
        unit: "level",
      },
      {
        id: "level-10",
        label: "Adept",
        icon: award,
        target: 10,
        actual: stats.level,
        unit: "level",
      },
      {
        id: "level-20",
        label: "Mastered",
        icon: crown,
        target: 20,
        actual: stats.level,
        unit: "level",
      },
      {
        id: "languages-3",
        label: "Polyglot",
        icon: brain,
        target: 3,
        actual: langChart.rows.filter((r) => r.xp > 0).length,
        unit: "languages",
      },
      {
        id: "xp-1000",
        label: "1k XP",
        icon: zap,
        target: 1000,
        actual: stats.xp,
        unit: "XP",
      },
      {
        id: "xp-10000",
        label: "10k XP",
        icon: rocket,
        target: 10000,
        actual: stats.xp,
        unit: "XP",
      },
    ],
    [stats, langChart],
  );

  return (
    <div className="m-prof">
      <header className="m-prof__head">
        <h1 className="m-prof__title">Profile</h1>
        {onOpenSearch && (
          <button
            type="button"
            className="m-prof__search"
            onClick={onOpenSearch}
            aria-label="Search"
          >
            <Icon icon={searchIcon} size="sm" color="currentColor" />
          </button>
        )}
      </header>

      {/* Twin gauges: streak ring (consecutive days against current
          milestone target) + level ring (XP into the next level).
          Visual focal point of the profile — "what number am I
          chasing right now?" */}
      <section className="m-prof__rings" aria-label="Streak and level">
        <RingGauge
          value={stats.streakDays}
          target={ringStreakTarget(stats.streakDays)}
          label="Streak"
          sub={
            stats.streakDays > 0
              ? `${stats.streakDays} day${stats.streakDays === 1 ? "" : "s"}`
              : "Not active"
          }
          icon={flame}
          tone="streak"
        />
        <RingGauge
          value={stats.xpIntoLevel}
          target={Math.max(stats.xpForLevel, 1)}
          label={`Level ${stats.level}`}
          sub={`${stats.xpIntoLevel}/${stats.xpForLevel} XP`}
          icon={zap}
          tone="level"
        />
      </section>

      {/* Four stat tiles. Same data the rings cover but flat /
          numeric — the rings are for emotional pull, the tiles
          for at-a-glance scanning. */}
      <div className="m-prof__stats" role="list">
        <StatTile
          icon={flame}
          tone="streak"
          value={stats.streakDays}
          label="Day streak"
        />
        <StatTile
          icon={bookOpenCheck}
          tone="lessons"
          value={stats.lessonsCompleted}
          label="Lessons"
        />
        <StatTile icon={zap} tone="xp" value={stats.xp} label="XP" />
        <StatTile
          icon={sparkles}
          tone="level"
          value={stats.level}
          label="Level"
        />
      </div>

      {/* Activity heatmap — last 12 weeks. Helps a learner SEE
          consistency, not just streak length. */}
      <section className="m-prof__section">
        <h3 className="m-prof__section-title">Activity</h3>
        <Heatmap cells={heatmap.cells} peak={heatmap.peak} />
        <div className="m-prof__heatmap-legend">
          <span>Less</span>
          <span className="m-prof__heatmap-cell m-prof__heatmap-cell--lvl-0" aria-hidden />
          <span className="m-prof__heatmap-cell m-prof__heatmap-cell--lvl-1" aria-hidden />
          <span className="m-prof__heatmap-cell m-prof__heatmap-cell--lvl-2" aria-hidden />
          <span className="m-prof__heatmap-cell m-prof__heatmap-cell--lvl-3" aria-hidden />
          <span className="m-prof__heatmap-cell m-prof__heatmap-cell--lvl-4" aria-hidden />
          <span>More</span>
        </div>
      </section>

      {/* Language XP chart — horizontal bars of XP earned per
          language, top 6 sorted descending. Empty state encourages
          the learner to crack open a course. */}
      {langChart.rows.length > 0 ? (
        <section className="m-prof__section">
          <h3 className="m-prof__section-title">XP by language</h3>
          <ul className="m-prof__lang-chart" role="list">
            {langChart.rows.map((r) => (
              <li key={r.lang} className="m-prof__lang-row">
                <span
                  className="m-prof__lang-name"
                  data-lang={r.lang}
                >
                  {langLabel(r.lang)}
                </span>
                <div
                  className="m-prof__lang-bar"
                  aria-hidden
                  data-lang={r.lang}
                >
                  <div
                    className="m-prof__lang-bar-fill"
                    style={{
                      width: `${Math.max(r.pct * 100, 2)}%`,
                    }}
                  />
                </div>
                <span className="m-prof__lang-xp">{r.xp}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Achievement badges — unlocked ones glow, locked ones dim
          with a "x / target" hint so the next goal is visible. */}
      <section className="m-prof__section">
        <h3 className="m-prof__section-title">Achievements</h3>
        <ul className="m-prof__badges" role="list">
          {milestones.map((m) => {
            const unlocked = m.actual >= m.target;
            return (
              <li
                key={m.id}
                className={
                  "m-prof__badge" + (unlocked ? " m-prof__badge--unlocked" : "")
                }
                title={
                  unlocked
                    ? `${m.label} unlocked`
                    : `${m.actual}/${m.target} ${m.unit}`
                }
              >
                <span className="m-prof__badge-icon" aria-hidden>
                  <Icon icon={m.icon} size="md" color="currentColor" />
                </span>
                <span className="m-prof__badge-label">{m.label}</span>
                <span className="m-prof__badge-meta">
                  {unlocked ? "Unlocked" : `${m.actual}/${m.target}`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

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

/// Pick the next milestone target a streak should chase. We use the
/// classic 3 / 7 / 14 / 30 / 60 / 100 ladder so the ring's "fill" is
/// always relative to the next reachable goal — empty rings on a
/// 200-day streak would feel demotivating.
function ringStreakTarget(streak: number): number {
  for (const t of [3, 7, 14, 30, 60, 100, 365]) {
    if (streak < t) return t;
  }
  return Math.max(streak + 30, 365);
}

interface MilestoneSpec {
  id: string;
  label: string;
  icon: string;
  target: number;
  actual: number;
  unit: string;
}

/// Circular SVG gauge. Size + stroke are CSS variables so the
/// component can be reused at different scales without forking. The
/// fill is animated via stroke-dashoffset, so React re-renders
/// drive the visual change for free.
function RingGauge({
  value,
  target,
  label,
  sub,
  icon,
  tone,
}: {
  value: number;
  target: number;
  label: string;
  sub: string;
  icon: string;
  tone: "streak" | "level";
}) {
  const pct = target > 0 ? Math.min(value / target, 1) : 0;
  // Stroke geometry. r=42 gives a 100x100 viewBox with 4px stroke
  // breathing room; circumference = 2πr ≈ 263.9. We round to keep
  // the dasharray + dashoffset values stable.
  const r = 42;
  const c = Math.round(2 * Math.PI * r * 100) / 100;
  const dash = c;
  const offset = c * (1 - pct);
  return (
    <div className={`m-prof__ring m-prof__ring--${tone}`}>
      <svg
        viewBox="0 0 100 100"
        className="m-prof__ring-svg"
        aria-hidden
      >
        <circle
          className="m-prof__ring-track"
          cx="50"
          cy="50"
          r={r}
          fill="none"
        />
        <circle
          className="m-prof__ring-fill"
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeDasharray={dash}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="m-prof__ring-body">
        <span className="m-prof__ring-icon" aria-hidden>
          <Icon icon={icon} size="md" color="currentColor" />
        </span>
        <span className="m-prof__ring-value">{value}</span>
        <span className="m-prof__ring-label">{label}</span>
        <span className="m-prof__ring-sub">{sub}</span>
      </div>
    </div>
  );
}

/// One stat tile. Icon-tinted by `tone` so the four tiles read as
/// distinct numerics even when the values are similar.
function StatTile({
  icon,
  tone,
  value,
  label,
}: {
  icon: string;
  tone: "streak" | "lessons" | "xp" | "level";
  value: number;
  label: string;
}) {
  return (
    <div className={`m-prof__stat m-prof__stat--${tone}`} role="listitem">
      <span className="m-prof__stat-icon" aria-hidden>
        <Icon icon={icon} size="sm" color="currentColor" />
      </span>
      <div className="m-prof__stat-text">
        <span className="m-prof__stat-value">{value}</span>
        <span className="m-prof__stat-label">{label}</span>
      </div>
    </div>
  );
}

/// 7-row × N-week grid of completion-count cells. Render is
/// flex-column wrap so each week becomes a column without manual
/// math — a simpler layout than CSS grid for this shape.
function Heatmap({
  cells,
  peak,
}: {
  cells: Array<{ key: string; count: number; label: string }>;
  peak: number;
}) {
  // Bin counts to 5 levels (0-4). Level 0 = no activity (muted);
  // levels 1-4 ramp from quiet to bright.
  const level = (count: number) => {
    if (count <= 0) return 0;
    if (count >= peak) return 4;
    const pct = count / peak;
    if (pct >= 0.7) return 4;
    if (pct >= 0.45) return 3;
    if (pct >= 0.2) return 2;
    return 1;
  };
  return (
    <div className="m-prof__heatmap" aria-label="Activity over the last 12 weeks">
      {cells.map((c) => (
        <span
          key={c.key}
          className={`m-prof__heatmap-cell m-prof__heatmap-cell--lvl-${level(c.count)}`}
          title={c.label}
        />
      ))}
    </div>
  );
}
