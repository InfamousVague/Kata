import { useEffect, useMemo, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import "@base/primitives/icon/icon.css";
import type { Course, LanguageId } from "../../data/types";
import { isChallengePack } from "../../data/types";
import BookCover from "./BookCover";
import CourseContextMenu, { useCourseMenu } from "../Shared/CourseContextMenu";
import FishbonesLoader from "../Shared/FishbonesLoader";
import LanguageChip from "../LanguageChip/LanguageChip";
import { prefetchCovers } from "../../hooks/useCourseCover";
import "./CourseLibrary.css";

/// Library display mode. `shelf` = tall 2:3 book-cover cards (the new
/// default). `grid` = the information-dense card grid that was the
/// original layout. User's choice persists in localStorage.
type ViewMode = "shelf" | "grid";
const VIEW_MODE_STORAGE_KEY = "fishbones:library-view-mode";

function loadInitialViewMode(): ViewMode {
  if (typeof localStorage === "undefined") return "shelf";
  const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return stored === "grid" ? "grid" : "shelf";
}

interface Props {
  courses: Course[];
  completed: Set<string>;
  /// Course ids whose full body is still hydrating from disk. Covers for
  /// these ids get a dimmed + spinner overlay. Optional — when omitted,
  /// no covers show a loading state.
  hydrating?: Set<string>;
  onDismiss: () => void;
  onOpen: (courseId: string) => void;
  /// Opens the PDF import wizard. Optional — hidden when the host
  /// can't run the AI-assisted ingest pipeline (e.g. the web build).
  onImport?: () => void;
  /// Opens the multi-PDF bulk import wizard — the learner can queue several
  /// books at once for unattended processing. Optional — hidden when the
  /// host app doesn't support bulk imports (e.g. web build).
  onBulkImport?: () => void;
  /// Opens the docs-site import dialog — crawl a documentation URL
  /// and generate a course from its pages. Optional; hidden when not
  /// wired by the host (keeps this component useful in tests / web
  /// previews that don't have the Tauri crawl command available).
  onDocsImport?: () => void;
  /// Opens a file picker for a previously-exported `.fishbones` (or legacy
  /// `.kata`) archive and unzips it into the courses dir. Optional — when omitted the button
  /// is hidden (e.g. in environments where the Tauri dialog plugin isn't
  /// available).
  onImportArchive?: () => void;
  onExport?: (courseId: string, courseTitle: string) => void;
  onDelete?: (courseId: string, courseTitle: string) => void;
  /// Opens the per-course settings modal. When wired, right-clicking
  /// any cover in the library (shelf or grid) surfaces a context menu
  /// with Settings / Export / Delete mirroring the sidebar UX.
  onSettings?: (courseId: string) => void;
  /// Bulk-export every course in the library to a chosen directory.
  /// When wired, renders an "Export all" button in the header next to
  /// the Import cluster. Skipped when the host doesn't offer it (e.g.
  /// the web-preview build with no filesystem access).
  onBulkExport?: () => void;
  /// "modal" (default) — centered overlay with a dimmed backdrop; closed
  /// via the × button or clicking the backdrop.
  /// "inline" — renders inside the current container with no backdrop,
  /// suitable for the "no-tabs-open" empty state. The close × is hidden
  /// since there's no underlying view to return to.
  mode?: "modal" | "inline";
}

type SortKey = "name" | "progress" | "lessons";

// Every LanguageId we support. Each pill is hidden at render time when
// there are zero courses for that language (see the `countByLang` filter
// below), so this full list is safe to carry around even on a library
// with just two or three languages — the user only sees pills for the
// languages they actually have courses in, PLUS whatever's currently
// selected as the active filter. Adding a new language elsewhere in the
// app (e.g. extending `LanguageId` in `data/types.ts`) requires adding
// it here too, otherwise its courses would silently become unfilterable.
const LANG_PILLS: Array<{ id: "all" | LanguageId; label: string }> = [
  { id: "all", label: "All" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "swift", label: "Swift" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "kotlin", label: "Kotlin" },
  { id: "csharp", label: "C#" },
  { id: "assembly", label: "Assembly" },
  { id: "web", label: "Web" },
  { id: "threejs", label: "Three.js" },
  { id: "reactnative", label: "React Native" },
];

/// Browse-all-courses screen. Full-pane modal with language filter chips,
/// sort dropdown, and a responsive grid of course cards. Each card shows
/// progress + lesson count and offers Open / Export / Delete via a hover
/// action row. Empty state invites the user to import their first book.
export default function CourseLibrary({
  courses,
  completed,
  hydrating,
  onDismiss,
  onOpen,
  onImport,
  onBulkImport,
  onDocsImport,
  onImportArchive,
  onExport,
  onDelete,
  onSettings,
  onBulkExport,
  mode = "modal",
}: Props) {
  const isInline = mode === "inline";
  const ctxMenu = useCourseMenu();
  const [langFilter, setLangFilter] = useState<"all" | LanguageId>("all");
  // Kind toggle — separate the two course archetypes the library
  // mixes today: full-length books (chapter-major prose with
  // exercises) vs handcrafted challenge packs (flat list of
  // increasing-difficulty exercises). The default is "all" so a fresh
  // visit shows everything; toggling restricts to one bucket.
  const [kindFilter, setKindFilter] = useState<"all" | "books" | "challenges">(
    "all",
  );
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(loadInitialViewMode);
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    }
  }, [viewMode]);

  // Prefetch every cover up front so the shelf paints fully-populated
  // instead of filling in card-by-card as IntersectionObserver fires.
  // Covers live behind a module-level cache keyed on
  // `courseId:coverFetchedAt`, so repeat library opens are cache hits
  // and we only block on the first visit (or after a course's cover
  // changes via the settings flow). The gate stays shown until every
  // IPC resolves — failures cache as `null` and still count, so a
  // single missing cover doesn't strand the overlay.
  const [coversReady, setCoversReady] = useState(() => courses.length === 0);
  useEffect(() => {
    if (courses.length === 0) {
      setCoversReady(true);
      return;
    }
    let cancelled = false;
    setCoversReady(false);
    void prefetchCovers(
      courses.map((c) => ({ courseId: c.id, cacheBust: c.coverFetchedAt })),
    ).then(() => {
      if (!cancelled) setCoversReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [courses]);

  // Pre-compute per-course progress so sorting + display share one walk.
  const enriched = useMemo(() => {
    return courses.map((c) => {
      let total = 0;
      let done = 0;
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          total += 1;
          if (completed.has(`${c.id}:${l.id}`)) done += 1;
        }
      }
      return {
        course: c,
        total,
        done,
        pct: total > 0 ? done / total : 0,
      };
    });
  }, [courses, completed]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched
      .filter((e) => langFilter === "all" || e.course.language === langFilter)
      .filter((e) => {
        if (kindFilter === "all") return true;
        const isPack = isChallengePack(e.course);
        return kindFilter === "challenges" ? isPack : !isPack;
      })
      .filter((e) =>
        q === ""
          ? true
          : e.course.title.toLowerCase().includes(q) ||
            (e.course.author ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        switch (sortBy) {
          case "progress":
            return b.pct - a.pct;
          case "lessons":
            return b.total - a.total;
          case "name":
          default:
            return a.course.title.localeCompare(b.course.title);
        }
      });
  }, [enriched, langFilter, kindFilter, sortBy, query]);

  // Count courses per language so the filter chips can show badges and
  // hide languages with zero courses (unless they're the active filter).
  const countByLang = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of enriched) {
      m.set(e.course.language, (m.get(e.course.language) ?? 0) + 1);
    }
    return m;
  }, [enriched]);

  // Count books vs challenges so the kind toggle can show badges. Only
  // counts within the current language filter so the numbers track
  // what's actually visible after the lang chip narrows the set.
  const kindCounts = useMemo(() => {
    let books = 0;
    let challenges = 0;
    for (const e of enriched) {
      if (langFilter !== "all" && e.course.language !== langFilter) continue;
      if (isChallengePack(e.course)) challenges += 1;
      else books += 1;
    }
    return { books, challenges, all: books + challenges };
  }, [enriched, langFilter]);

  // The panel content is identical in both modes; only the wrapper differs:
  // modal wraps with a full-viewport backdrop, inline just renders in place.
  const panel = (
    <div
      className={`fishbones-library-panel ${isInline ? "fishbones-library-panel--inline" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
        <div className="fishbones-library-header">
          <div className="fishbones-library-titleblock">
            <span className="fishbones-library-title">Library</span>
            <span className="fishbones-library-subtitle">
              {courses.length} course{courses.length === 1 ? "" : "s"} on this machine
            </span>
          </div>
          <div className="fishbones-library-header-actions">
            {/* Single "Import" label + a segmented cluster of destinations.
                Beats repeating "Import from PDF…", "Import archive…",
                "Bulk import…" three times — the label answers "what do
                these buttons do" once; each segment is just the NAME of
                the thing being imported. */}
            {onImport && (
            <div className="fishbones-library-import-group" role="group" aria-label="Import courses">
              <span className="fishbones-library-import-label">Import</span>
              <div className="fishbones-library-import-segmented">
                <button
                  className="fishbones-library-import-seg fishbones-library-import-seg--primary"
                  onClick={onImport}
                  title="Run the AI pipeline on a PDF or EPUB to generate a course"
                >
                  Book
                </button>
                {onBulkImport && (
                  <button
                    className="fishbones-library-import-seg"
                    onClick={onBulkImport}
                    title="Queue several books for unattended batch import"
                  >
                    Bulk books
                  </button>
                )}
                {onDocsImport && (
                  <button
                    className="fishbones-library-import-seg"
                    onClick={onDocsImport}
                    title="Crawl a documentation website and generate a course from its pages"
                  >
                    Docs site
                  </button>
                )}
                {onImportArchive && (
                  <button
                    className="fishbones-library-import-seg"
                    onClick={onImportArchive}
                    title="Import a previously-exported .fishbones archive (legacy .kata also supported)"
                  >
                    Archive
                  </button>
                )}
              </div>
            </div>
            )}
            {onBulkExport && (
              <button
                className="fishbones-library-bulk-export"
                onClick={onBulkExport}
                disabled={filtered.length === 0 && courses.length === 0}
                title="Export every course in the library as .fishbones archives to a folder of your choice"
              >
                Export all
              </button>
            )}
            {!isInline && (
              <button className="fishbones-library-close" onClick={onDismiss} aria-label="Close">
                ×
              </button>
            )}
          </div>
        </div>

        {courses.length > 0 && (
          <div className="fishbones-library-controls">
            <div className="fishbones-library-pills" role="tablist" aria-label="Filter by language">
              {LANG_PILLS.filter(
                (p) => p.id === "all" || p.id === langFilter || (countByLang.get(p.id) ?? 0) > 0,
              ).map((p) => {
                const count =
                  p.id === "all" ? courses.length : countByLang.get(p.id) ?? 0;
                return (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={langFilter === p.id}
                    className={`fishbones-library-pill ${
                      langFilter === p.id ? "fishbones-library-pill--active" : ""
                    }`}
                    onClick={() => setLangFilter(p.id)}
                  >
                    {p.label}
                    <span className="fishbones-library-pill-count">{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Kind toggle — All / Books / Challenges. Counts tracking
                whatever the language filter has narrowed to, so a learner
                who picks "Rust" and then clicks "Challenges" sees
                only Rust challenges. The toggle is hidden when the
                language-narrowed set has only one kind (no point in
                offering a switch that does nothing). */}
            {kindCounts.books > 0 && kindCounts.challenges > 0 && (
              <div
                className="fishbones-library-kind-toggle"
                role="tablist"
                aria-label="Filter by kind"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === "all"}
                  className={`fishbones-library-kind ${
                    kindFilter === "all" ? "fishbones-library-kind--active" : ""
                  }`}
                  onClick={() => setKindFilter("all")}
                >
                  All
                  <span className="fishbones-library-kind-count">
                    {kindCounts.all}
                  </span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === "books"}
                  className={`fishbones-library-kind ${
                    kindFilter === "books" ? "fishbones-library-kind--active" : ""
                  }`}
                  onClick={() => setKindFilter("books")}
                >
                  Books
                  <span className="fishbones-library-kind-count">
                    {kindCounts.books}
                  </span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === "challenges"}
                  className={`fishbones-library-kind ${
                    kindFilter === "challenges" ? "fishbones-library-kind--active" : ""
                  }`}
                  onClick={() => setKindFilter("challenges")}
                >
                  Challenges
                  <span className="fishbones-library-kind-count">
                    {kindCounts.challenges}
                  </span>
                </button>
              </div>
            )}

            <div className="fishbones-library-tools">
              <input
                type="search"
                className="fishbones-library-search"
                placeholder="Search title or author…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="fishbones-library-sort">
                <span className="fishbones-library-sort-label">sort</span>
                <select
                  className="fishbones-library-sort-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                >
                  <option value="name">Name (A–Z)</option>
                  <option value="progress">Progress</option>
                  <option value="lessons">Lesson count</option>
                </select>
              </label>
              {/* View-mode toggle: shelf (book covers) vs grid (dense
                  info cards). Remembers the choice in localStorage. */}
              <div
                className="fishbones-library-viewmode"
                role="tablist"
                aria-label="View mode"
              >
                <button
                  role="tab"
                  type="button"
                  aria-selected={viewMode === "shelf"}
                  className={`fishbones-library-viewmode-btn ${
                    viewMode === "shelf"
                      ? "fishbones-library-viewmode-btn--active"
                      : ""
                  }`}
                  onClick={() => setViewMode("shelf")}
                  title="Shelf view — book covers"
                >
                  Shelf
                </button>
                <button
                  role="tab"
                  type="button"
                  aria-selected={viewMode === "grid"}
                  className={`fishbones-library-viewmode-btn ${
                    viewMode === "grid"
                      ? "fishbones-library-viewmode-btn--active"
                      : ""
                  }`}
                  onClick={() => setViewMode("grid")}
                  title="Grid view — info cards"
                >
                  Grid
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="fishbones-library-body">
          {/* Full-body loader overlay shown until every cover has
              prefetched. Fades out on `coversReady` so the populated
              shelf isn't jarring when it pops in. */}
          {!coversReady && (
            <div className="fishbones-library-prefetch-overlay" aria-hidden>
              <FishbonesLoader label="Loading covers" />
            </div>
          )}
          {courses.length === 0 ? (
            <div className="fishbones-library-empty">
              <div className="fishbones-library-empty-glyph" aria-hidden>
                <Icon icon={libraryBig} size="2xl" color="currentColor" weight="light" />
              </div>
              <div className="fishbones-library-empty-title">No courses yet</div>
              <div className="fishbones-library-empty-blurb">
                {onImport
                  ? "Import your first book to get started. Fishbones splits a PDF or EPUB into lessons and generates exercises with the Claude API, or you can import a `.fishbones` course someone else shared."
                  : "Sign in to sync courses from another device, or grab the desktop app to ingest your own books."}
              </div>
              <div className="fishbones-library-empty-actions">
                {onImport ? (
                  <button className="fishbones-library-empty-primary" onClick={onImport}>
                    Import a book…
                  </button>
                ) : (
                  <a
                    className="fishbones-library-empty-primary"
                    href="https://github.com/InfamousVague/Kata/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Get the desktop app
                  </a>
                )}
                {onImportArchive && (
                  <button
                    className="fishbones-library-empty-secondary"
                    onClick={onImportArchive}
                  >
                    Import .fishbones archive…
                  </button>
                )}
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="fishbones-library-empty">
              <div className="fishbones-library-empty-title">No matches</div>
              <div className="fishbones-library-empty-blurb">
                Try clearing the filter or searching for a different title.
              </div>
            </div>
          ) : viewMode === "shelf" ? (
            <div className="fishbones-library-shelf">
              {filtered.map((e) => (
                <BookCover
                  key={e.course.id}
                  course={e.course}
                  progress={e.pct}
                  loading={hydrating?.has(e.course.id)}
                  onOpen={() => onOpen(e.course.id)}
                  onContextMenu={
                    onExport || onDelete || onSettings
                      ? (ev) => ctxMenu.show(e.course, ev)
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="fishbones-library-grid">
              {filtered.map((e) => (
                <CourseCard
                  key={e.course.id}
                  course={e.course}
                  total={e.total}
                  done={e.done}
                  pct={e.pct}
                  onOpen={() => onOpen(e.course.id)}
                  onExport={
                    onExport
                      ? () => onExport(e.course.id, e.course.title)
                      : undefined
                  }
                  onDelete={
                    onDelete
                      ? () => onDelete(e.course.id, e.course.title)
                      : undefined
                  }
                  onContextMenu={
                    onExport || onDelete || onSettings
                      ? (ev) => ctxMenu.show(e.course, ev)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
        <CourseContextMenu
          menu={ctxMenu.menu}
          onDismiss={ctxMenu.close}
          onSettings={onSettings}
          onExport={onExport}
          onDelete={onDelete}
        />
    </div>
  );

  // In inline mode, render just the panel so it flows in its parent
  // container. In modal mode, wrap in a backdrop and intercept clicks.
  if (isInline) return panel;
  return (
    <div className="fishbones-library-backdrop" onClick={onDismiss}>
      {panel}
    </div>
  );
}

function CourseCard({
  course,
  total,
  done,
  pct,
  onOpen,
  onExport,
  onDelete,
  onContextMenu,
}: {
  course: Course;
  total: number;
  done: number;
  pct: number;
  onOpen: () => void;
  onExport?: () => void;
  onDelete?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const chapters = course.chapters.length;
  const status =
    pct === 0
      ? "not started"
      : pct === 1
      ? "completed"
      : `${Math.round(pct * 100)}%`;

  return (
    <div className="fishbones-library-card" onContextMenu={onContextMenu}>
      <button className="fishbones-library-card-main" onClick={onOpen}>
        <div className="fishbones-library-card-header">
          <LanguageChip language={course.language} size="sm" />
          <span className="fishbones-library-card-status">{status}</span>
        </div>
        <div className="fishbones-library-card-title">{course.title}</div>
        {course.author && (
          <div className="fishbones-library-card-author">by {course.author}</div>
        )}
        <div className="fishbones-library-card-progress" aria-hidden>
          <div
            className="fishbones-library-card-progress-fill"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <div className="fishbones-library-card-meta">
          {done}/{total} lessons · {chapters} chapter{chapters === 1 ? "" : "s"}
        </div>
      </button>
      <div className="fishbones-library-card-actions">
        {onExport && (
          <button
            className="fishbones-library-card-action"
            onClick={(e) => {
              e.stopPropagation();
              onExport();
            }}
            title="Export as .fishbones archive"
          >
            Export
          </button>
        )}
        {onDelete && (
          <button
            className="fishbones-library-card-action fishbones-library-card-action--danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete this course from disk"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

