import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { chevronRight } from "@base/primitives/icon/icons/chevron-right";
import { chevronDown } from "@base/primitives/icon/icons/chevron-down";
import { bookOpen } from "@base/primitives/icon/icons/book-open";
import { code as codeIcon } from "@base/primitives/icon/icons/code";
import { fileText } from "@base/primitives/icon/icons/file-text";
import { helpCircle } from "@base/primitives/icon/icons/help-circle";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import { settings as settingsIcon } from "@base/primitives/icon/icons/settings";
import { download as downloadIcon } from "@base/primitives/icon/icons/download";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { terminal as terminalIcon } from "@base/primitives/icon/icons/terminal";
import { swords } from "@base/primitives/icon/icons/swords";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import { search as searchIcon } from "@base/primitives/icon/icons/search";
import "@base/primitives/icon/icon.css";
import type { Course, Chapter, Lesson, LanguageId } from "../../data/types";
import { isChallengePack } from "../../data/types";
import { useCourseCover } from "../../hooks/useCourseCover";
import LanguageChip from "../LanguageChip/LanguageChip";
import { ProgressRing } from "../Shared/ProgressRing";
import { FISHBONES_DOCS } from "../../docs/pages";
import "./Sidebar.css";

/// Display name for a language id. Used by the "Rust challenges" style
/// section header so the learner sees which subset we're showing, not
/// a bare "Challenge packs" that's ambiguous when filtered.
function languageLabel(lang: LanguageId): string {
  switch (lang) {
    case "javascript":
      return "JavaScript";
    case "typescript":
      return "TypeScript";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "swift":
      return "Swift";
    case "go":
      return "Go";
    case "web":
      return "Web";
    case "threejs":
      return "Three.js";
    case "react":
      return "React";
    case "reactnative":
      return "React Native";
    case "c":
      return "C";
    case "cpp":
      return "C++";
    case "java":
      return "Java";
    case "kotlin":
      return "Kotlin";
    case "csharp":
      return "C#";
    case "assembly":
      return "Assembly";
    case "svelte":
      return "Svelte";
    case "solid":
      return "SolidJS";
    case "htmx":
      return "HTMX";
    case "astro":
      return "Astro";
    case "bun":
      return "Bun";
    case "tauri":
      return "Tauri";
    case "solidity":
      return "Solidity";
  }
}

/// Maps a lesson kind to the glyph shown to the left of its title in the
/// sidebar. Keeping this in one place so adding a new lesson type is a
/// one-line change rather than hunting through LessonRow.
function iconForKind(kind: Lesson["kind"]) {
  switch (kind) {
    case "reading":
      return bookOpen;
    case "exercise":
    case "mixed":
      return codeIcon;
    case "quiz":
      return helpCircle;
  }
}

interface Props {
  courses: Course[];
  activeCourseId?: string;
  activeLessonId?: string;
  completed: Set<string>;
  /// Per-course "last opened" timestamps keyed by course id. Used ONLY
  /// by the sidebar-header carousel to sort recent-first — the course
  /// tree itself doesn't care about timestamps. Empty map is fine
  /// (carousel falls back to course array order).
  recents?: Record<string, number>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  /// Jump to a course via the header carousel — parent resolves the
  /// "resume at" lesson (last-open tab or first lesson) and hands that
  /// through. Separate from onSelectLesson so the carousel's click
  /// behavior is explicit rather than guessing a lesson id here.
  onSelectCourse?: (courseId: string) => void;
  /// Opens the course library modal.
  onLibrary: () => void;
  onSettings: () => void;
  /// Playground route — free-form coding sandbox, jsfiddle-style.
  onPlayground?: () => void;
  /// Docs route — in-app documentation. Optional so embeddings of the
  /// sidebar without a docs pane (e.g. the popped-out workbench window)
  /// don't grow a dead chip.
  onDocs?: () => void;
  /// When `activeView === "docs"`, the sidebar swaps its course tree
  /// for a docs-page nav driven by this id. Lifted from App-level so
  /// the same state drives both the sidebar list and DocsView's main
  /// pane — without it the user would see two separate sidebars.
  /// Undefined means "not in docs mode" and the sidebar renders the
  /// regular course tree.
  docsActiveId?: string;
  /// Called when the user clicks a docs page in the sidebar nav.
  /// App.tsx forwards this to its `setDocsActiveId` so DocsView
  /// re-renders with the new page. Optional so callers without docs
  /// support don't have to wire it up.
  onDocsSelect?: (pageId: string) => void;
  /// Which main-pane destination is currently showing. Used ONLY to draw
  /// an active state on the matching icon chip; clicking a chip calls
  /// its callback and lets the parent manage the state transition.
  /// "profile" stays a valid destination even though it's no longer in
  /// the sidebar — the top-bar streak pill's "View profile" CTA sets it.
  activeView?: "courses" | "profile" | "playground" | "library" | "docs";
  onExportCourse?: (courseId: string, courseTitle: string) => void;
  onDeleteCourse?: (courseId: string, courseTitle: string) => void;
  onCourseSettings?: (courseId: string) => void;
  /// Wipe a single lesson's completion. Surfaced via the lesson row's
  /// right-click menu when the lesson is currently marked complete.
  onResetLesson?: (courseId: string, lessonId: string) => void;
  /// Wipe every completion in a chapter. The sidebar passes the chapter's
  /// lesson_ids since completions are stored flat per-lesson (no chapter id
  /// in the schema).
  onResetChapter?: (courseId: string, lessonIds: string[]) => void;
  /// Wipe every completion in a course. Reachable from the course
  /// right-click menu (sits between Export and Delete).
  onResetCourse?: (courseId: string) => void;
}

/// Floating left rail. Completion dots fill in as lessons get marked done
/// (unit test passes, mark-read, etc.). The chapter header shows `x / y`
/// lessons complete so users see progress at a glance.
export default function Sidebar({
  courses,
  activeCourseId,
  activeLessonId,
  completed,
  recents = {},
  onSelectLesson,
  onSelectCourse,
  onLibrary,
  onSettings,
  onPlayground,
  onDocs,
  docsActiveId,
  onDocsSelect,
  activeView = "courses",
  onExportCourse,
  onDeleteCourse,
  onCourseSettings,
  onResetLesson,
  onResetChapter,
  onResetCourse,
}: Props) {
  /// Open context menu state, positioned at the cursor when a course card
  /// is right-clicked. One menu at a time across the sidebar — opening a
  /// new one closes the previous. Clicking outside, pressing Escape, or
  /// scrolling the sidebar dismisses it.
  const [menu, setMenu] = useState<{
    courseId: string;
    courseTitle: string;
    x: number;
    y: number;
  } | null>(null);

  /// Same shape, separate state slot for the chapter right-click menu —
  /// the data shape differs (chapter title, lesson_ids) so reusing `menu`
  /// would mean a discriminated union. A second slot is simpler.
  const [chapterMenu, setChapterMenu] = useState<{
    courseId: string;
    chapterTitle: string;
    lessonIds: string[];
    x: number;
    y: number;
  } | null>(null);

  /// Lesson right-click menu. Only opened for completed lessons (the only
  /// V1 action is "mark incomplete"); incomplete lessons skip the menu
  /// entirely so the learner doesn't see an empty popover.
  const [lessonMenu, setLessonMenu] = useState<{
    courseId: string;
    lessonId: string;
    lessonTitle: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    // One shared close path so a click anywhere outside (or Escape) drops
    // whichever of the three menus is open. Only attach the listeners
    // when something IS open — saves a no-op listener on every render.
    const anyOpen = menu || chapterMenu || lessonMenu;
    if (!anyOpen) return;
    const close = () => {
      setMenu(null);
      setChapterMenu(null);
      setLessonMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // `click` (not `mousedown`) so the click that opens a menu item still
    // hits the item before the dismiss fires. `contextmenu` dismiss on a
    // different card lets the new card open its own menu immediately.
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, chapterMenu, lessonMenu]);

  return (
    <aside className="fishbones__sidebar">
      {/* Primary nav — vertical list with icon + label. Claude-Code-style:
          full-width rows, clear call-outs, no ambiguity about what each
          chip does. Routes (Profile / Playground) show an active state
          when their view is open; one-shot actions (Library / Import /
          Settings) stay neutral. */}
      {/* Sidebar nav is now a thin trio: Library (which owns all the
          import flows — PDF + bulk PDF + .fishbones archive), the
          Playground route, and Settings. Profile lives on the top-bar
          streak pill alongside level/XP so it's adjacent to the data
          it belongs with, not hiding in the left rail. */}
      {/* Recent-courses carousel lives at the very top of the sidebar —
          it's the first thing the learner's eye hits when switching
          contexts. Horizontally scrollable row of cover thumbnails,
          newest-activity first. Hidden when there's 0 or 1 course
          (nothing to switch between). Clicking a thumbnail jumps to
          the course — the parent resolves which lesson to resume.
          Also hidden when the sidebar is in docs mode — the rail
          becomes the docs nav, so a course-switcher would be noise. */}
      {activeView !== "docs" && onSelectCourse && (
        <CourseCarousel
          courses={courses}
          recents={recents}
          completed={completed}
          onSelectCourse={onSelectCourse}
          onContextMenu={
            onExportCourse || onDeleteCourse || onCourseSettings
              ? (course, e) => {
                  e.preventDefault();
                  setMenu({
                    courseId: course.id,
                    courseTitle: course.title,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }
              : undefined
          }
        />
      )}

      {/* Primary nav sits BELOW the carousel. Rationale: the carousel
          is the frequent-action (switch course); the nav is the
          occasional-action (import, settings, playground). Putting the
          frequent one first matches how the learner actually uses the
          sidebar. */}
      <div className="fishbones__sidebar-nav">
        <SidebarNavItem
          icon={libraryBig}
          label="Library"
          onClick={onLibrary}
          active={activeView === "library"}
        />
        {onPlayground && (
          <SidebarNavItem
            icon={terminalIcon}
            label="Playground"
            onClick={onPlayground}
            active={activeView === "playground"}
          />
        )}
        {onDocs && (
          <SidebarNavItem
            icon={fileText}
            label="Docs"
            onClick={onDocs}
            active={activeView === "docs"}
          />
        )}
        <SidebarNavItem
          icon={settingsIcon}
          label="Settings"
          onClick={onSettings}
        />
      </div>

      {activeView === "docs" ? (
        <DocsSidebarNav
          activeId={docsActiveId}
          onSelect={onDocsSelect}
        />
      ) : (
      <nav className="fishbones__nav">
        {(() => {
          // Partition into books vs challenge packs so they render under
          // distinct section headers. Order within each group is preserved
          // (newest-first comes from the caller). We still render a single
          // list when only one kind is present — no empty headers.
          const books = courses.filter((c) => !isChallengePack(c));
          const packs = courses.filter((c) => isChallengePack(c));

          const renderGroup = (
            course: Course,
          ): React.ReactElement => (
            <CourseGroup
              key={course.id}
              course={course}
              isActiveCourse={course.id === activeCourseId}
              activeLessonId={activeLessonId}
              completed={completed}
              onSelectLesson={onSelectLesson}
              onContextMenu={
                onExportCourse || onDeleteCourse || onCourseSettings || onResetCourse
                  ? (e: React.MouseEvent) => {
                      e.preventDefault();
                      setMenu({
                        courseId: course.id,
                        courseTitle: course.title,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
              onChapterContextMenu={
                onResetChapter
                  ? (chapter, e) => {
                      e.preventDefault();
                      setChapterMenu({
                        courseId: course.id,
                        chapterTitle: chapter.title,
                        lessonIds: chapter.lessons.map((l) => l.id),
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
              onLessonContextMenu={
                onResetLesson
                  ? (lesson, isCompleted, e) => {
                      // Skip the menu entirely for not-yet-completed
                      // lessons — the only V1 action is reset, and
                      // there's nothing to reset.
                      if (!isCompleted) return;
                      e.preventDefault();
                      setLessonMenu({
                        courseId: course.id,
                        lessonId: lesson.id,
                        lessonTitle: lesson.title,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
            />
          );

          // Active course (if any) is lifted to the top of the nav under
          // a "Current" header so the "which course am I in" question is
          // answered before the eye even reaches the list. When you ARE
          // focused on a course, the rest of the sidebar narrows to just
          // that language's challenge packs — other courses would be
          // noise you're not currently using, challenge packs in the
          // same language are the natural practice companion. When no
          // course is active (just launched, or on Profile / Playground),
          // we skip the Current header and show everything under the
          // normal sections so the learner can pick.
          const activeCourse =
            courses.find((c) => c.id === activeCourseId) ?? null;

          // The sidebar is the LEARNER'S BENCH — only show courses the
          // learner has touched (≥1 completed lesson). Untouched courses
          // live on the Library page where the learner goes to *find new
          // things*. Without this filter, a bundled-pack-heavy install
          // dumps 24 sections into the sidebar and turns a working
          // surface into a discovery surface. The active course is an
          // exception — if you JUST opened a course, we want it visible
          // in "Current" even though completion is still 0.
          const isStarted = (c: Course): boolean =>
            c.chapters.some((ch) =>
              ch.lessons.some((l) => completed.has(`${c.id}:${l.id}`)),
            );

          const inactiveBooks = books.filter(
            (c) => c.id !== activeCourseId && isStarted(c),
          );
          const inactivePacks = packs.filter(
            (c) => c.id !== activeCourseId && isStarted(c),
          );

          // Language-filtered packs when focused on a course. We match
          // the pack's primary language to the active course's language.
          const relevantPacks = activeCourse
            ? inactivePacks.filter((p) => p.language === activeCourse.language)
            : inactivePacks;

          // Empty state: no started courses AND no active course means
          // a brand-new install (or the learner reset everything). Send
          // them to the library — that's where new courses come from.
          const hasAnything =
            !!activeCourse || inactiveBooks.length > 0 || relevantPacks.length > 0;

          return (
            <>
              {activeCourse && (
                <>
                  <div className="fishbones__nav-section">Current</div>
                  {renderGroup(activeCourse)}
                </>
              )}
              {!activeCourse && inactiveBooks.length > 0 && (
                <>
                  <div className="fishbones__nav-section">In progress</div>
                  {inactiveBooks.map(renderGroup)}
                </>
              )}
              {relevantPacks.length > 0 && (
                <>
                  <div className="fishbones__nav-section fishbones__nav-section--packs">
                    <span className="fishbones__nav-section-icon" aria-hidden>
                      <Icon icon={swords} size="xs" color="currentColor" />
                    </span>
                    {activeCourse
                      ? `${languageLabel(activeCourse.language)} challenges`
                      : "Challenge packs"}
                  </div>
                  {relevantPacks.map(renderGroup)}
                </>
              )}
              {!hasAnything && (
                <div className="fishbones__nav-empty">
                  <p className="fishbones__nav-empty-headline">
                    Nothing started yet
                  </p>
                  <p className="fishbones__nav-empty-body">
                    Pick something from the library to get going. Courses
                    you start will show up here.
                  </p>
                  <button
                    type="button"
                    className="fishbones__nav-empty-cta"
                    onClick={onLibrary}
                  >
                    <span aria-hidden>
                      <Icon icon={libraryBig} size="xs" color="currentColor" />
                    </span>
                    Open Library
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </nav>
      )}

      {menu && (onExportCourse || onDeleteCourse || onCourseSettings || onResetCourse) && (
        <div
          className="fishbones__context-menu"
          // Position at cursor. Fixed positioning so scroll state doesn't
          // matter — the window-level click listener dismisses us anyway.
          style={{ left: menu.x, top: menu.y }}
          // Stop the click from bubbling to window and dismissing before
          // the item's onClick fires.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="fishbones__context-menu-label">{menu.courseTitle}</div>
          {onCourseSettings && (
            <button
              className="fishbones__context-menu-item"
              onClick={() => {
                onCourseSettings(menu.courseId);
                setMenu(null);
              }}
            >
              <span className="fishbones__context-menu-icon" aria-hidden>
                <Icon icon={settingsIcon} size="xs" color="currentColor" />
              </span>
              Course settings…
            </button>
          )}
          {onExportCourse && (
            <button
              className="fishbones__context-menu-item"
              onClick={() => {
                onExportCourse(menu.courseId, menu.courseTitle);
                setMenu(null);
              }}
            >
              <span className="fishbones__context-menu-icon" aria-hidden>
                <Icon icon={downloadIcon} size="xs" color="currentColor" />
              </span>
              Export course…
            </button>
          )}
          {/* Reset progress sits between the safe actions and Delete:
              destructive in that it wipes completion state, but recoverable
              (the lessons are still there to re-complete). Styled like the
              Settings/Export rows, NOT like the Delete row. */}
          {onResetCourse && (
            <button
              className="fishbones__context-menu-item"
              onClick={() => {
                onResetCourse(menu.courseId);
                setMenu(null);
              }}
            >
              <span className="fishbones__context-menu-icon" aria-hidden>
                <Icon icon={rotateCcw} size="xs" color="currentColor" />
              </span>
              Reset progress
            </button>
          )}
          {onDeleteCourse && (
            <>
              {/* Separator between non-destructive and destructive actions. */}
              <div className="fishbones__context-menu-sep" aria-hidden />
              <button
                className="fishbones__context-menu-item fishbones__context-menu-item--danger"
                onClick={() => {
                  onDeleteCourse(menu.courseId, menu.courseTitle);
                  setMenu(null);
                }}
              >
                <span className="fishbones__context-menu-icon" aria-hidden>
                  <Icon icon={xIcon} size="xs" color="currentColor" />
                </span>
                Delete course…
              </button>
            </>
          )}
        </div>
      )}

      {chapterMenu && onResetChapter && (
        <div
          className="fishbones__context-menu"
          style={{ left: chapterMenu.x, top: chapterMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="fishbones__context-menu-label">{chapterMenu.chapterTitle}</div>
          <button
            className="fishbones__context-menu-item"
            onClick={() => {
              onResetChapter(chapterMenu.courseId, chapterMenu.lessonIds);
              setChapterMenu(null);
            }}
          >
            <span className="fishbones__context-menu-icon" aria-hidden>
              <Icon icon={rotateCcw} size="xs" color="currentColor" />
            </span>
            Reset chapter progress
          </button>
        </div>
      )}

      {lessonMenu && onResetLesson && (
        <div
          className="fishbones__context-menu"
          style={{ left: lessonMenu.x, top: lessonMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="fishbones__context-menu-label">{lessonMenu.lessonTitle}</div>
          <button
            className="fishbones__context-menu-item"
            onClick={() => {
              onResetLesson(lessonMenu.courseId, lessonMenu.lessonId);
              setLessonMenu(null);
            }}
          >
            <span className="fishbones__context-menu-icon" aria-hidden>
              <Icon icon={rotateCcw} size="xs" color="currentColor" />
            </span>
            Mark incomplete
          </button>
        </div>
      )}
    </aside>
  );
}

function CourseGroup({
  course,
  isActiveCourse,
  activeLessonId,
  completed,
  onSelectLesson,
  onContextMenu,
  onChapterContextMenu,
  onLessonContextMenu,
}: {
  course: Course;
  isActiveCourse: boolean;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /// Right-click on a chapter row. CourseGroup just forwards to the
  /// sidebar parent which owns the menu state.
  onChapterContextMenu?: (chapter: Chapter, e: React.MouseEvent) => void;
  /// Right-click on a lesson row. The `isCompleted` flag lets the parent
  /// decide whether to show a menu at all (V1: only for completed lessons).
  onLessonContextMenu?: (
    lesson: Lesson,
    isCompleted: boolean,
    e: React.MouseEvent,
  ) => void;
}) {
  // The active course is always expanded — the learner is working inside
  // it and needs its tree visible. Inactive courses default collapsed;
  // clicking the row expands them inline so the learner can peek
  // without switching focus.
  const [expanded, setExpanded] = useState(isActiveCourse);

  const totalLessons = course.chapters.reduce((n, ch) => n + ch.lessons.length, 0);
  const doneLessons = course.chapters.reduce(
    (n, ch) => n + ch.lessons.filter((l) => completed.has(`${course.id}:${l.id}`)).length,
    0
  );
  const pct = totalLessons > 0 ? doneLessons / totalLessons : 0;

  // Active course: full card with circular progress ring, always
  // expanded. The elevated surface + ring treatment advertises "this is
  // the course you're in" unambiguously. Inside, only the chapter that
  // contains the active lesson is open by default — other chapters are
  // collapsed to their header row so the tree doesn't dominate.
  if (isActiveCourse) {
    return (
      <div className="fishbones__course fishbones__course--active">
        <div
          className="fishbones__course-card fishbones__course-card--expanded fishbones__course-card--active"
          onContextMenu={onContextMenu}
        >
          <div className="fishbones__course-title fishbones__course-title--static">
            <span className="fishbones__course-active-dot" aria-hidden />
            <LanguageChip language={course.language} size="xs" iconOnly />
            <span className="fishbones__course-name">{course.title}</span>
            <span
              className="fishbones__course-ring"
              title={`${doneLessons}/${totalLessons} lessons complete`}
            >
              <ProgressRing
                progress={pct}
                size={28}
                stroke={2.5}
                label={`${Math.round(pct * 100)}%`}
              />
            </span>
          </div>
        </div>

        <div className="fishbones__course-body">
          <ChapterTree
            chapters={course.chapters}
            courseId={course.id}
            activeLessonId={activeLessonId}
            completed={completed}
            onSelectLesson={onSelectLesson}
            onChapterContextMenu={onChapterContextMenu}
            onLessonContextMenu={onLessonContextMenu}
          />
        </div>
      </div>
    );
  }

  // Inactive course: compact single-line row that matches the top nav
  // item pattern (caret + chip + label + tiny ring). Clicking the row
  // expands inline so the learner can peek at the chapter list without
  // changing focus — selecting a lesson inside still promotes it to
  // active via `onSelectLesson`, at which point the next render treats
  // it as active and shows the full card. The ring replaces the bare
  // "x/y" text so progress reads as a glance-able visual.
  return (
    <div className="fishbones__course fishbones__course--compact">
      <button
        className="fishbones__course-row"
        onClick={() => setExpanded(!expanded)}
        onContextMenu={onContextMenu}
      >
        <span className="fishbones__course-row-caret" aria-hidden>
          <Icon
            icon={expanded ? chevronDown : chevronRight}
            size="xs"
            color="currentColor"
            weight="bold"
          />
        </span>
        <LanguageChip language={course.language} size="xs" iconOnly />
        <span className="fishbones__course-name">{course.title}</span>
        <span
          className="fishbones__course-row-ring"
          title={`${doneLessons}/${totalLessons} lessons complete`}
        >
          <ProgressRing progress={pct} size={18} stroke={2} label="" />
        </span>
      </button>

      {expanded && (
        <div className="fishbones__course-body">
          {/* Same disclosure tree as the active branch — section
              grouping needs to behave identically whether the user is
              peeking at an in-progress course or working in the
              current one. ChapterTree degrades to a plain chapter
              list for courses without `X · Y` titles, so this is
              safe for legacy / PDF-imported books too. */}
          <ChapterTree
            chapters={course.chapters}
            courseId={course.id}
            activeLessonId={undefined}
            completed={completed}
            onSelectLesson={onSelectLesson}
            onChapterContextMenu={onChapterContextMenu}
            onLessonContextMenu={onLessonContextMenu}
          />
        </div>
      )}
    </div>
  );
}

/// FLIP animation constants. Must stay in sync with
/// `.fishbones__carousel-item` width (74) and `.fishbones__carousel-scroll`
/// gap (10) in Sidebar.css. We hardcode rather than measuring at runtime
/// because the values are stable and per-render DOM reads are wasted work.
const CAROUSEL_CARD_WIDTH_PX = 74;
const CAROUSEL_CARD_GAP_PX = 10;
const CAROUSEL_CARD_STEP_PX = CAROUSEL_CARD_WIDTH_PX + CAROUSEL_CARD_GAP_PX;
const CAROUSEL_SLIDE_MS = 350;

/// Horizontal-scrolling thumbnail row in the sidebar header. Ordered by
/// last-opened timestamp (see `useRecentCourses`) so the course the
/// learner was just in lands at the left edge — regardless of whether
/// they completed a lesson in it. Courses with no open-timestamp fall
/// to the right in their natural array order. Hidden when there are
/// < 2 courses — switching is pointless.
///
/// Reorder behaviour uses FLIP animation: when a click bumps a book to
/// the front, the user sees the book GLIDE from its old slot to slot 0
/// rather than teleporting. Neighbours also slide down by one to fill
/// the hole. Feels like a real reshuffle instead of a jarring jump.
function CourseCarousel({
  courses,
  recents,
  completed,
  onSelectCourse,
  onContextMenu,
}: {
  courses: Course[];
  recents: Record<string, number>;
  /// Lesson completion set (keys: `${courseId}:${lessonId}`). Used to
  /// draw a per-cover progress strip so the carousel gives at-a-glance
  /// "how far am I in each book" signal.
  completed: Set<string>;
  onSelectCourse: (courseId: string) => void;
  onContextMenu?: (course: Course, e: React.MouseEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /// Each course's index at the END of the previous render. We compare
  /// against the current sort to figure out which cards moved and by
  /// how many slots — that delta drives the invert-translate step of
  /// the FLIP animation.
  const prevIndicesRef = useRef<Map<string, number>>(new Map());

  const sorted = useMemo(() => {
    // Only courses the learner has actually opened (have a recents
    // entry). Discovery happens on the Library page now — the sidebar
    // carousel is "jump back to where you were", not "browse what
    // exists". Without this filter a fresh install would dump all 24
    // bundled courses into the carousel and bury the one or two the
    // learner is actually working on.
    return courses
      .filter((c) => recents[c.id] !== undefined)
      .sort((a, b) => (recents[b.id] ?? 0) - (recents[a.id] ?? 0));
  }, [courses, recents]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    // Build the new index map fresh each render so we can compare to
    // the stashed previous map. Using a Map (not a Record) because
    // forEach over entries is cleaner and reads better in the loops
    // below.
    const newIndices = new Map<string, number>();
    sorted.forEach((c, i) => newIndices.set(c.id, i));

    const prev = prevIndicesRef.current;
    prevIndicesRef.current = newIndices;

    // First render: nothing to animate from. Also skips the case where
    // the carousel mounted with < 2 courses and is only now crossing
    // the threshold — we'd rather the row appear in place than have
    // a multi-card cascade of slides on first show.
    if (prev.size === 0) return;

    // Invert step: any card whose index changed gets an inline
    // translateX that puts it BACK at its old visual position. We
    // collect them into an array so the subsequent play step doesn't
    // have to re-query the DOM.
    const animating: HTMLElement[] = [];
    for (const [id, newIdx] of newIndices) {
      const prevIdx = prev.get(id);
      if (prevIdx === undefined || prevIdx === newIdx) continue;
      const el = scrollEl.querySelector<HTMLElement>(
        `[data-course-id="${CSS.escape(id)}"]`,
      );
      if (!el) continue;
      const deltaX = (prevIdx - newIdx) * CAROUSEL_CARD_STEP_PX;
      el.style.transition = "none";
      el.style.transform = `translateX(${deltaX}px)`;
      animating.push(el);
    }

    if (animating.length === 0) return;

    // Force a synchronous layout so the browser commits the invert
    // transforms before we queue the play. Without this, some browsers
    // will batch the two style changes and skip straight to identity.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    scrollEl.offsetWidth;

    // Play step: on the next frame, enable the transition and clear
    // the inline transform so each card animates from its old position
    // (invert) back to identity (its new slot).
    const rafId = requestAnimationFrame(() => {
      for (const el of animating) {
        el.style.transition = `transform ${CAROUSEL_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        el.style.transform = "";
      }
    });

    // Once the slide finishes, release the inline `transition` so the
    // base CSS transition (0.18s on hover scale) takes over again.
    // Small buffer on the timeout so we don't cut off the last frame.
    const cleanupId = window.setTimeout(() => {
      for (const el of animating) {
        el.style.transition = "";
      }
    }, CAROUSEL_SLIDE_MS + 50);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(cleanupId);
    };
  }, [sorted]);

  if (sorted.length < 2) return null;

  return (
    <div className="fishbones__carousel" aria-label="Recent courses">
      <div className="fishbones__carousel-scroll" ref={scrollRef}>
        {sorted.map((c) => (
          <CarouselItem
            key={c.id}
            course={c}
            progress={courseProgress(c, completed)}
            onClick={() => onSelectCourse(c.id)}
            onContextMenu={
              onContextMenu ? (e) => onContextMenu(c, e) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/// Single cover thumbnail in the carousel. Shows the extracted cover if
/// one exists; otherwise a language-tinted mini-tile with the short
/// language code. Same cover-loading path as BookCover — the hook
/// dedupes repeat requests across mounts.
function CarouselItem({
  course,
  progress,
  onClick,
  onContextMenu,
}: {
  course: Course;
  /// Fraction 0..1 of completed lessons. Drives the bottom progress
  /// strip over the cover. Also surfaces in the tooltip so hovering a
  /// thumbnail gives a concrete "x of y" number.
  progress: { pct: number; done: number; total: number };
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const coverUrl = useCourseCover(course.id, course.coverFetchedAt);
  const hasCover = !!coverUrl;
  const { pct, done, total } = progress;
  const pctLabel =
    total === 0
      ? ""
      : pct === 1
      ? " · complete"
      : pct === 0
      ? " · not started"
      : ` · ${done}/${total} lessons`;

  return (
    <button
      type="button"
      data-course-id={course.id}
      className={`fishbones__carousel-item fishbones__carousel-item--lang-${course.language} ${
        hasCover ? "" : "fishbones__carousel-item--no-cover"
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${course.title}${pctLabel}`}
      aria-label={`Open ${course.title}${pctLabel}`}
    >
      {hasCover ? (
        <img
          className="fishbones__carousel-cover"
          src={coverUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="fishbones__carousel-glyph" aria-hidden>
          {carouselGlyph(course.language)}
        </span>
      )}
      {/* Title + author overlay with a dark gradient, matching the
          library shelf's BookCover treatment so carousel thumbs read
          as miniaturized versions of the same card. Only shown when
          there's a cover — fallback tiles already surface the title
          via the language-tinted block itself. */}
      {hasCover && (
        <>
          <span className="fishbones__carousel-shadow" aria-hidden />
          <span className="fishbones__carousel-label">
            <span className="fishbones__carousel-label-title">{course.title}</span>
            {course.author && (
              <span className="fishbones__carousel-label-author">
                {course.author}
              </span>
            )}
          </span>
        </>
      )}
      {/* Progress strip along the bottom edge of the cover. Shown for
          every course (even 0%) so the carousel reads as a consistent
          row of status bars — uniform height keeps the cover row from
          jumping when the learner's first completion lands. */}
      {total > 0 && (
        <span className="fishbones__carousel-progress" aria-hidden>
          <span
            className="fishbones__carousel-progress-fill"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </span>
      )}
    </button>
  );
}

/// Compute the 0..1 progress fraction for a course given the completion
/// set the sidebar already has in scope. Keyed by `${courseId}:${lessonId}`
/// so it mirrors the shape used everywhere else (useProgress, library,
/// profile view).
function courseProgress(
  course: Course,
  completed: Set<string>,
): { pct: number; done: number; total: number } {
  let total = 0;
  let done = 0;
  for (const ch of course.chapters) {
    for (const l of ch.lessons) {
      total += 1;
      if (completed.has(`${course.id}:${l.id}`)) done += 1;
    }
  }
  return { pct: total > 0 ? done / total : 0, done, total };
}

/// Short language tag for the carousel fallback tile. Same list as
/// BookCover.tsx's langGlyph — kept local here so the sidebar doesn't
/// import internals from the library folder.
function carouselGlyph(lang: LanguageId): string {
  switch (lang) {
    case "javascript":
      return "JS";
    case "typescript":
      return "TS";
    case "python":
      return "PY";
    case "rust":
      return "RS";
    case "swift":
      return "SW";
    case "go":
      return "GO";
    case "web":
      return "WEB";
    case "threejs":
      return "3D";
    case "react":
      return "RX";
    case "reactnative":
      return "RN";
    case "c":
      return "C";
    case "cpp":
      return "C++";
    case "java":
      return "JV";
    case "kotlin":
      return "KT";
    case "csharp":
      return "C#";
    case "assembly":
      return "ASM";
    case "svelte":
      return "SV";
    case "solid":
      return "SO";
    case "htmx":
      return "HX";
    case "astro":
      return "AS";
    case "bun":
      return "BN";
    case "tauri":
      return "TR";
    case "solidity":
      return "SOL";
  }
}

/// Docs-mode sidebar body — replaces the course tree when the user is
/// on the docs route. Renders a search input + section/page list driven
/// by `FISHBONES_DOCS`. Selecting a page calls back to App-level state
/// so the main pane (DocsView) re-renders with the matching body.
///
/// Search filter is local — only the sidebar list reacts to it; the
/// main pane keeps showing whatever page is selected. Empty filter =
/// the full list. We compare against title and tagline so a learner
/// looking for "shortcut" finds the keyboard-shortcuts page even
/// though that's not in the title.
function DocsSidebarNav({
  activeId,
  onSelect,
}: {
  activeId?: string;
  onSelect?: (pageId: string) => void;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return FISHBONES_DOCS;
    const needle = filter.trim().toLowerCase();
    return FISHBONES_DOCS.map((s) => ({
      ...s,
      pages: s.pages.filter(
        (p) =>
          p.title.toLowerCase().includes(needle) ||
          (p.tagline ?? "").toLowerCase().includes(needle),
      ),
    })).filter((s) => s.pages.length > 0);
  }, [filter]);

  return (
    <nav className="fishbones__docs-nav" aria-label="Documentation">
      <div className="fishbones__docs-search">
        <Icon icon={searchIcon} size="xs" color="currentColor" />
        <input
          type="text"
          placeholder="Search docs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          // Don't autofocus — clicking the Docs nav item shouldn't
          // steal focus from the main pane's keyboard shortcuts. The
          // user can click into the box themselves when they want to
          // search.
        />
      </div>
      <div className="fishbones__docs-nav-body">
        {filtered.map((section) => (
          <div className="fishbones__docs-nav-section" key={section.id}>
            <div className="fishbones__docs-nav-section-title">
              {section.title}
            </div>
            <ul className="fishbones__docs-nav-list">
              {section.pages.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    className={`fishbones__docs-nav-item ${
                      page.id === activeId
                        ? "fishbones__docs-nav-item--active"
                        : ""
                    }`}
                    onClick={() => onSelect?.(page.id)}
                    title={page.tagline}
                  >
                    {page.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="fishbones__docs-nav-empty">
            No pages match "{filter}"
          </div>
        )}
      </div>
    </nav>
  );
}

/// Vertical nav-list row at the top of the sidebar. Icon + label, full
/// width. `active` controls the highlighted pill state for persistent
/// destinations (Profile, Playground) so the learner always knows which
/// main-pane route they're on.
function SidebarNavItem({
  icon,
  label,
  onClick,
  active,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`fishbones__sidebar-nav-item ${active ? "fishbones__sidebar-nav-item--active" : ""}`}
      onClick={onClick}
    >
      <span className="fishbones__sidebar-nav-icon" aria-hidden>
        <Icon icon={icon} size="sm" color="currentColor" />
      </span>
      <span className="fishbones__sidebar-nav-label">{label}</span>
    </button>
  );
}

/// Section separator used by importer scripts that want their chapter
/// titles auto-grouped in the sidebar — e.g. the Svelte tutorial emits
/// `Basic Svelte · Introduction`, `Basic Svelte · Reactivity`,
/// `Advanced Svelte · Snippets`, etc. Consecutive chapters that share
/// the same prefix collapse into one disclosure-toggle section.
///
/// Importers that don't use the separator just get the existing flat
/// `Chapter → Lesson` tree — no migration needed.
const SECTION_SEPARATOR = " · ";

/// One node in the chapter-level tree. Either a single un-grouped
/// chapter (the legacy course shape — most courses look like this) or
/// a section containing 1+ chapters that all share the same "X · "
/// prefix. The section variant carries a `displayTitle` per chapter
/// (the suffix after the separator) so the nested ChapterBlock doesn't
/// repeat the section label inside its own header.
type ChapterTreeNode =
  | { kind: "flat"; chapter: Chapter }
  | {
      kind: "section";
      label: string;
      entries: { chapter: Chapter; displayTitle: string }[];
    };

/// Walk a course's chapter list and merge consecutive `X · Y` titles
/// into sections. Order is preserved — we never reorder chapters, just
/// group adjacent ones. Anything without the separator (or with a
/// different prefix from its neighbours) stays as a flat node.
function groupChaptersBySection(chapters: Chapter[]): ChapterTreeNode[] {
  const nodes: ChapterTreeNode[] = [];
  let current: { label: string; entries: { chapter: Chapter; displayTitle: string }[] } | null =
    null;

  const flushSection = () => {
    if (current) {
      nodes.push({ kind: "section", label: current.label, entries: current.entries });
      current = null;
    }
  };

  for (const chapter of chapters) {
    const idx = chapter.title.indexOf(SECTION_SEPARATOR);
    if (idx === -1) {
      // No separator → flat node. Close any open section first so
      // we don't accidentally fold this chapter into the previous
      // group.
      flushSection();
      nodes.push({ kind: "flat", chapter });
      continue;
    }
    const label = chapter.title.slice(0, idx);
    const displayTitle = chapter.title.slice(idx + SECTION_SEPARATOR.length);
    if (current && current.label === label) {
      current.entries.push({ chapter, displayTitle });
    } else {
      flushSection();
      current = { label, entries: [{ chapter, displayTitle }] };
    }
  }
  flushSection();
  return nodes;
}

/// Renders a course's chapters with optional section grouping. Used by
/// both the active and the compact (inactive) course branches so the
/// disclosure tree looks identical regardless of which card the user
/// is interacting with. When a course has zero chapters with the
/// `X · Y` separator (the common case for PDF-imported books) this
/// degrades to a plain list of ChapterBlocks — visually indistinct
/// from the pre-grouping behaviour.
function ChapterTree({
  chapters,
  courseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onChapterContextMenu,
  onLessonContextMenu,
}: {
  chapters: Chapter[];
  courseId: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onChapterContextMenu?: (chapter: Chapter, e: React.MouseEvent) => void;
  onLessonContextMenu?: (
    lesson: Lesson,
    isCompleted: boolean,
    e: React.MouseEvent,
  ) => void;
}) {
  const tree = useMemo(() => groupChaptersBySection(chapters), [chapters]);

  return (
    <>
      {tree.map((node, i) => {
        if (node.kind === "flat") {
          return (
            <ChapterBlock
              key={node.chapter.id}
              chapter={node.chapter}
              courseId={courseId}
              activeLessonId={activeLessonId}
              completed={completed}
              onSelectLesson={onSelectLesson}
              onChapterContextMenu={onChapterContextMenu}
              onLessonContextMenu={onLessonContextMenu}
            />
          );
        }
        return (
          <SectionGroup
            // Index in the key because two sections sharing a label
            // can theoretically appear if a course interleaves
            // groups (e.g. Basic … Advanced … Basic). Real courses
            // don't, but indexing the key removes the foot-gun.
            key={`${courseId}:section:${i}:${node.label}`}
            label={node.label}
            entries={node.entries}
            courseId={courseId}
            activeLessonId={activeLessonId}
            completed={completed}
            onSelectLesson={onSelectLesson}
            onChapterContextMenu={onChapterContextMenu}
            onLessonContextMenu={onLessonContextMenu}
          />
        );
      })}
    </>
  );
}

/// Disclosure-toggle wrapper around a contiguous run of chapters that
/// share an `X · ` prefix. Header reads the section label (e.g. "Basic
/// Svelte"); body renders nested ChapterBlocks with their suffix-only
/// `displayTitle` so the same word doesn't repeat in every chapter row.
///
/// Open state persists in localStorage keyed by `(courseId, label)` so
/// a user who expands "Advanced Svelte" once doesn't have to re-expand
/// it next session. Sections that contain the active lesson auto-open
/// regardless of the stored value — the user is working there, the
/// path to their lesson should be visible.
function SectionGroup({
  label,
  entries,
  courseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onChapterContextMenu,
  onLessonContextMenu,
}: {
  label: string;
  entries: { chapter: Chapter; displayTitle: string }[];
  courseId: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onChapterContextMenu?: (chapter: Chapter, e: React.MouseEvent) => void;
  onLessonContextMenu?: (
    lesson: Lesson,
    isCompleted: boolean,
    e: React.MouseEvent,
  ) => void;
}) {
  const containsActiveLesson = activeLessonId
    ? entries.some(({ chapter }) =>
        chapter.lessons.some((l) => l.id === activeLessonId),
      )
    : false;

  const storageKey = `fishbones:section-open:${courseId}:${label}`;
  const [open, setOpen] = useState<boolean>(() => {
    // Auto-open when our active lesson lives inside this section. The
    // stored "0" only wins when the user is NOT currently working
    // here — once they navigate in, the path becomes visible again.
    if (containsActiveLesson) return true;
    if (typeof window !== "undefined") {
      try {
        const stored = window.localStorage.getItem(storageKey);
        if (stored === "1") return true;
        if (stored === "0") return false;
      } catch {
        // localStorage can throw in private-browsing modes — fall
        // through to the default.
      }
    }
    // The whole point of the grouping is to fold a 30-chapter
    // outline into a few digestible rows; default closed.
    return false;
  });

  // If the user navigates to a lesson inside this section AFTER the
  // group rendered closed, force it open so the active row is
  // reachable without an extra click. We don't write to localStorage
  // here — auto-open is per-render, not user intent.
  useEffect(() => {
    if (containsActiveLesson) setOpen(true);
  }, [containsActiveLesson]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Private-browsing — silently drop the persistence; the
        // toggle still works for the current session.
      }
      return next;
    });
  };

  // Aggregate completion across every chapter in the group so the
  // header ring reads as a single "X / Y" the same way a chapter
  // header does — gives the learner one-glance progress for the
  // whole section.
  let totalLessons = 0;
  let doneLessons = 0;
  for (const { chapter } of entries) {
    for (const lesson of chapter.lessons) {
      totalLessons += 1;
      if (completed.has(`${courseId}:${lesson.id}`)) doneLessons += 1;
    }
  }
  const pct = totalLessons > 0 ? doneLessons / totalLessons : 0;

  return (
    <div
      className={`fishbones__section ${
        open ? "fishbones__section--open" : "fishbones__section--closed"
      }`}
    >
      <button
        type="button"
        className="fishbones__section-title"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="fishbones__section-caret" aria-hidden>
          <Icon
            icon={open ? chevronDown : chevronRight}
            size="xs"
            color="currentColor"
            weight="bold"
          />
        </span>
        <span className="fishbones__section-title-text">{label}</span>
        <span
          className="fishbones__section-ring"
          title={`${doneLessons}/${totalLessons} lessons complete`}
        >
          <ProgressRing progress={pct} size={16} stroke={2} label="" />
        </span>
      </button>
      {open && (
        <div className="fishbones__section-children">
          {entries.map(({ chapter, displayTitle }) => (
            <ChapterBlock
              key={chapter.id}
              chapter={chapter}
              displayTitle={displayTitle}
              courseId={courseId}
              activeLessonId={activeLessonId}
              completed={completed}
              onSelectLesson={onSelectLesson}
              onChapterContextMenu={onChapterContextMenu}
              onLessonContextMenu={onLessonContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChapterBlock({
  chapter,
  displayTitle,
  courseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onChapterContextMenu,
  onLessonContextMenu,
}: {
  chapter: Chapter;
  /// Override for the title text. Set by SectionGroup so chapters
  /// nested inside a "Basic Svelte" group show only the suffix
  /// ("Introduction") rather than repeating "Basic Svelte · " in
  /// every row. Falls back to `chapter.title` for the flat / legacy
  /// case where there's no enclosing section.
  displayTitle?: string;
  courseId: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onChapterContextMenu?: (chapter: Chapter, e: React.MouseEvent) => void;
  onLessonContextMenu?: (
    lesson: Lesson,
    isCompleted: boolean,
    e: React.MouseEvent,
  ) => void;
}) {
  const done = chapter.lessons.filter((l) => completed.has(`${courseId}:${l.id}`)).length;
  const total = chapter.lessons.length;
  const pct = total > 0 ? done / total : 0;

  // A chapter is open by default if it contains the currently-active
  // lesson — that's the one the learner is working in, so the lesson
  // tree should be visible without an extra click. Other chapters stay
  // collapsed to their header row so the active card doesn't sprawl.
  // Once the user manually toggles a chapter open, it stays open for
  // the session (state is local).
  const containsActiveLesson = activeLessonId
    ? chapter.lessons.some((l) => l.id === activeLessonId)
    : false;
  const [open, setOpen] = useState(containsActiveLesson);

  return (
    <div
      className={`fishbones__chapter ${
        open ? "fishbones__chapter--open" : "fishbones__chapter--closed"
      }`}
    >
      <button
        type="button"
        className="fishbones__chapter-title"
        onClick={() => setOpen(!open)}
        onContextMenu={
          onChapterContextMenu
            ? (e) => onChapterContextMenu(chapter, e)
            : undefined
        }
        aria-expanded={open}
      >
        <span className="fishbones__chapter-caret" aria-hidden>
          <Icon
            icon={open ? chevronDown : chevronRight}
            size="xs"
            color="currentColor"
            weight="bold"
          />
        </span>
        <span className="fishbones__chapter-title-text">
          {displayTitle ?? chapter.title}
        </span>
        <span
          className="fishbones__chapter-ring"
          title={`${done}/${total} lessons complete`}
        >
          <ProgressRing progress={pct} size={16} stroke={2} label="" />
        </span>
      </button>
      {open && (
        <div className="fishbones__chapter-lessons">
          {chapter.lessons.map((lesson) => {
            const isCompleted = completed.has(`${courseId}:${lesson.id}`);
            return (
              <LessonRow
                key={lesson.id}
                lesson={lesson}
                isCompleted={isCompleted}
                isActive={lesson.id === activeLessonId}
                onSelect={() => onSelectLesson(courseId, lesson.id)}
                onContextMenu={
                  onLessonContextMenu
                    ? (e) => onLessonContextMenu(lesson, isCompleted, e)
                    : undefined
                }
                difficulty={
                  lesson.kind === "exercise" || lesson.kind === "mixed"
                    ? lesson.difficulty
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function LessonRow({
  lesson,
  isCompleted,
  isActive,
  onSelect,
  onContextMenu,
  difficulty,
}: {
  lesson: Lesson;
  isCompleted: boolean;
  isActive: boolean;
  onSelect: () => void;
  /// Right-click handler. Optional so callers that don't care (no reset
  /// support wired up) get the original behaviour with no menu.
  onContextMenu?: (e: React.MouseEvent) => void;
  /// Only present for challenge-pack exercise rows. Drives a colored dot
  /// (easy → green, medium → amber, hard → red) that replaces the default
  /// kind-based accent so a pack reads as ramp-up, not as ordered lessons.
  difficulty?: "easy" | "medium" | "hard";
}) {
  return (
    <button
      className={`fishbones__nav-item fishbones__lesson-item fishbones__lesson-item--${lesson.kind} ${
        isActive ? "fishbones__nav-item--active" : ""
      }`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <LessonStatusIcon
        kind={lesson.kind}
        completed={isCompleted}
        active={isActive}
        difficulty={difficulty}
      />
      <span className="fishbones__lesson-name">{lesson.title}</span>
    </button>
  );
}

/// Single icon slot to the left of the lesson title. The same kind-glyph
/// (book / code / help-circle) is rendered across every state — only the
/// circle around it changes:
///   - pending: hollow ring, icon is a barely-visible dim gray
///   - active: hollow ring brightened, icon slightly more visible + halo
///   - done:  filled white circle with a black icon inside (inverted)
/// Keeping the glyph persistent means a completed lesson still advertises
/// what it was (reading vs exercise vs quiz), just styled differently.
///
/// When `difficulty` is set (challenge-pack lessons), we ALSO add a
/// `--diff-*` modifier so CSS can tint the pending/active ring to the
/// difficulty color (green/amber/red). Completed state still inverts to
/// the filled white disc — once you've solved it, difficulty is history.
function LessonStatusIcon({
  kind,
  completed,
  active,
  difficulty,
}: {
  kind: Lesson["kind"];
  completed: boolean;
  active: boolean;
  difficulty?: "easy" | "medium" | "hard";
}) {
  const state = completed ? "done" : active ? "active" : "pending";
  const diffClass = difficulty ? ` fishbones__lesson-status--diff-${difficulty}` : "";
  return (
    <span
      className={`fishbones__lesson-status fishbones__lesson-status--${state} fishbones__lesson-status--${kind}${diffClass}`}
      aria-hidden
    >
      <Icon icon={iconForKind(kind)} size="xs" color="currentColor" />
    </span>
  );
}
