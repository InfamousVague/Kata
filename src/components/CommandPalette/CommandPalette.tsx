import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { search as searchIcon } from "@base/primitives/icon/icons/search";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import { bookOpen } from "@base/primitives/icon/icons/book-open";
import { fileText } from "@base/primitives/icon/icons/file-text";
import { terminal } from "@base/primitives/icon/icons/terminal";
import { settings as settingsIcon } from "@base/primitives/icon/icons/settings";
import { sparkles } from "@base/primitives/icon/icons/sparkles";
import { command as commandIcon } from "@base/primitives/icon/icons/command";
import { userRoundCog } from "@base/primitives/icon/icons/user-round-cog";
import "@base/primitives/icon/icon.css";
import type { Course, Lesson } from "../../data/types";
import "./CommandPalette.css";

/// What the palette can navigate to. Each result becomes one row in the
/// list; `kind` drives the icon + section heading; `score` is the
/// substring-match weight (computed at search time, see `rankMatches`).
type ResultKind = "action" | "course" | "lesson";

interface BaseResult {
  id: string;
  kind: ResultKind;
  label: string;
  hint?: string;
  /// Lucide icon SVG string. We import each icon name once at the top
  /// of the file rather than passing them through props so adding a
  /// new action only needs one line in the actions list below.
  icon: string;
  /// Fired when the row is activated (click or Enter). Receives the
  /// palette's onClose so handlers can stay 1-line lambdas.
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  courses: Course[];
  /// Quick-action handlers wired by App.tsx. Each is allowed to be
  /// undefined (e.g. the Vite-only build doesn't have an open-import
  /// handler) — the palette filters them out automatically.
  actions: {
    openLibrary?: () => void;
    openPlayground?: () => void;
    openProfile?: () => void;
    openDocs?: () => void;
    openSettings?: () => void;
    importBook?: () => void;
    askAi?: () => void;
  };
  /// Open a specific lesson in a tab. Mirrors `selectLesson` in App.tsx.
  onOpenLesson: (courseId: string, lessonId: string) => void;
}

/// Cmd+K command palette. Searches across:
///   * Built-in app actions ("Open library", "Open settings", …)
///   * Every loaded course ("the Rust programming language")
///   * Every lesson across every course (("learning-go" → "format
///     code with gofmt"))
///
/// Keyboard:
///   ↑/↓        — move selection
///   Enter      — activate
///   Esc        — close
///   Cmd/Ctrl+K — toggle (handled by parent)
export default function CommandPalette({
  open,
  onClose,
  courses,
  actions,
  onOpenLesson,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Build the searchable pool once per (courses, actions) change. We
  // keep three sub-pools so the result list can render section
  // headings in a stable order even when matches span all three.
  const actionPool: BaseResult[] = useMemo(() => {
    const out: BaseResult[] = [];
    if (actions.openLibrary)
      out.push({
        id: "action:library",
        kind: "action",
        label: "Open library",
        hint: "Browse every course",
        icon: libraryBig,
        onSelect: () => {
          actions.openLibrary?.();
          onClose();
        },
      });
    if (actions.openPlayground)
      out.push({
        id: "action:playground",
        kind: "action",
        label: "Open playground",
        hint: "Scratch editor",
        icon: terminal,
        onSelect: () => {
          actions.openPlayground?.();
          onClose();
        },
      });
    if (actions.openProfile)
      out.push({
        id: "action:profile",
        kind: "action",
        label: "Open profile",
        hint: "Streak, XP, generators",
        icon: userRoundCog,
        onSelect: () => {
          actions.openProfile?.();
          onClose();
        },
      });
    if (actions.openDocs)
      out.push({
        id: "action:docs",
        kind: "action",
        label: "Open docs",
        hint: "In-app documentation",
        icon: fileText,
        onSelect: () => {
          actions.openDocs?.();
          onClose();
        },
      });
    if (actions.openSettings)
      out.push({
        id: "action:settings",
        kind: "action",
        label: "Open settings",
        hint: "Theme, AI, keys",
        icon: settingsIcon,
        onSelect: () => {
          actions.openSettings?.();
          onClose();
        },
      });
    if (actions.importBook)
      out.push({
        id: "action:import",
        kind: "action",
        label: "Import a book",
        hint: "PDF or EPUB",
        icon: bookOpen,
        onSelect: () => {
          actions.importBook?.();
          onClose();
        },
      });
    if (actions.askAi)
      out.push({
        id: "action:ask-ai",
        kind: "action",
        label: "Ask Fishbones",
        hint: "Local AI assistant",
        icon: sparkles,
        onSelect: () => {
          actions.askAi?.();
          onClose();
        },
      });
    return out;
  }, [actions, onClose]);

  const coursePool: BaseResult[] = useMemo(
    () =>
      courses.map((c) => ({
        id: `course:${c.id}`,
        kind: "course",
        label: c.title,
        hint: c.author ? `${c.language} · ${c.author}` : c.language,
        icon: bookOpen,
        onSelect: () => {
          // Open the first lesson of the course — same default
          // selectLesson uses for sidebar carousel taps.
          const firstLesson = c.chapters[0]?.lessons[0]?.id;
          if (firstLesson) onOpenLesson(c.id, firstLesson);
          onClose();
        },
      })),
    [courses, onOpenLesson, onClose],
  );

  const lessonPool: BaseResult[] = useMemo(() => {
    const out: BaseResult[] = [];
    for (const c of courses) {
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          out.push({
            id: `lesson:${c.id}:${l.id}`,
            kind: "lesson",
            label: l.title,
            hint: `${c.title} · ${ch.title}`,
            icon: lessonIconFor(l),
            onSelect: () => {
              onOpenLesson(c.id, l.id);
              onClose();
            },
          });
        }
      }
    }
    return out;
  }, [courses, onOpenLesson, onClose]);

  // Filter + rank. Empty query shows actions + first ~12 courses so
  // the palette is useful as a launcher even before typing.
  const sections: Array<{ heading: string; rows: BaseResult[] }> =
    useMemo(() => {
      const q = query.trim().toLowerCase();
      if (q === "") {
        return [
          { heading: "Actions", rows: actionPool },
          {
            heading: "Courses",
            rows: coursePool.slice(0, 12),
          },
        ].filter((s) => s.rows.length > 0);
      }
      const matchActions = rankMatches(actionPool, q);
      const matchCourses = rankMatches(coursePool, q);
      const matchLessons = rankMatches(lessonPool, q);
      // Cap each section so a search like "the" doesn't drown the
      // list in 800 lesson hits. The user can refine the query;
      // the palette doesn't need to be a full grep.
      return [
        { heading: "Actions", rows: matchActions.slice(0, 6) },
        { heading: "Courses", rows: matchCourses.slice(0, 8) },
        { heading: "Lessons", rows: matchLessons.slice(0, 20) },
      ].filter((s) => s.rows.length > 0);
    }, [query, actionPool, coursePool, lessonPool]);

  // Flat list of just the rows (no headings) — used for keyboard
  // navigation indices. The render walks `sections` for layout but
  // arrow keys move through `flatRows`.
  const flatRows = useMemo(
    () => sections.flatMap((s) => s.rows),
    [sections],
  );

  // Reset state on every open. Otherwise the search query + active
  // index from the previous invocation persists, which feels stale
  // and confusing — palette interactions are always fresh starts.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    // Defer focus so the input has actually mounted (the dialog
    // animates in; focusing too early lands on nothing).
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  // Clamp activeIdx whenever the result set shrinks underneath it.
  useEffect(() => {
    if (activeIdx >= flatRows.length) setActiveIdx(Math.max(0, flatRows.length - 1));
  }, [flatRows.length, activeIdx]);

  // Keep the highlighted row scrolled into view as the user moves.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(
      `[data-cmdpal-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Global key handling on the palette. Esc closes; arrows move;
  // Enter activates the current row; Cmd/Ctrl+K also closes (so the
  // toggle behaves like a real toggle from inside the open state).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(flatRows.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = flatRows[activeIdx];
        row?.onSelect();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flatRows, activeIdx, onClose]);

  if (!open) return null;

  // Track the running flat-index so each row knows whether it's
  // selected without an extra map allocation.
  let runningIdx = -1;

  return (
    <div
      className="fishbones-cmdpal-backdrop"
      onMouseDown={(e) => {
        // Click outside the panel closes; click inside (composer /
        // results) shouldn't.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fishbones-cmdpal"
        role="dialog"
        aria-label="Command palette"
      >
        <div className="fishbones-cmdpal-search">
          <span className="fishbones-cmdpal-search-icon" aria-hidden>
            <Icon icon={searchIcon} size="sm" color="currentColor" />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="fishbones-cmdpal-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="Search lessons, courses, actions…"
            aria-label="Command palette search"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="fishbones-cmdpal-kbd" aria-hidden>
            <Icon icon={commandIcon} size="xs" color="currentColor" /> K
          </span>
        </div>

        <div className="fishbones-cmdpal-results" ref={listRef}>
          {flatRows.length === 0 && (
            <div className="fishbones-cmdpal-empty">
              No matches for <strong>"{query}"</strong>. Try a course,
              lesson title, or "open settings".
            </div>
          )}
          {sections.map((section) => (
            <div key={section.heading} className="fishbones-cmdpal-section">
              <div className="fishbones-cmdpal-section-heading">
                {section.heading}
              </div>
              {section.rows.map((row) => {
                runningIdx += 1;
                const isActive = runningIdx === activeIdx;
                const localIdx = runningIdx;
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={`fishbones-cmdpal-row ${
                      isActive ? "is-active" : ""
                    }`}
                    data-cmdpal-idx={localIdx}
                    onMouseEnter={() => setActiveIdx(localIdx)}
                    onClick={row.onSelect}
                  >
                    <span className="fishbones-cmdpal-row-icon" aria-hidden>
                      <Icon icon={row.icon} size="sm" color="currentColor" />
                    </span>
                    <span className="fishbones-cmdpal-row-body">
                      <span className="fishbones-cmdpal-row-label">
                        {row.label}
                      </span>
                      {row.hint && (
                        <span className="fishbones-cmdpal-row-hint">
                          {row.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="fishbones-cmdpal-footer">
          <span className="fishbones-cmdpal-foot-key">↑↓</span> navigate
          <span className="fishbones-cmdpal-foot-key">↵</span> select
          <span className="fishbones-cmdpal-foot-key">Esc</span> close
        </div>
      </div>
    </div>
  );
}

/// Pick a lesson icon by kind. Reading lessons get an open book,
/// exercises get a terminal, quizzes get sparkles. Default fallback
/// is the open book so unknown future kinds still render something.
function lessonIconFor(lesson: Lesson): string {
  switch (lesson.kind) {
    case "exercise":
    case "mixed":
      return terminal;
    case "quiz":
      return sparkles;
    case "reading":
    default:
      return bookOpen;
  }
}

/// Substring-rank a pool against `q` (already lowercased). Returns
/// the pool in descending-quality order, with non-matches dropped.
/// Three signals, summed:
///   * `label.startsWith(q)` ⇒ +3 — strongest, "exact-prefix" feel
///   * `label.includes(q)`   ⇒ +2 — title hit
///   * `hint.includes(q)`    ⇒ +1 — secondary metadata hit
function rankMatches(pool: BaseResult[], q: string): BaseResult[] {
  const ranked: Array<{ row: BaseResult; score: number }> = [];
  for (const row of pool) {
    const label = row.label.toLowerCase();
    const hint = (row.hint ?? "").toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score += 3;
    if (label.includes(q)) score += 2;
    if (hint.includes(q)) score += 1;
    if (score > 0) ranked.push({ row, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label));
  return ranked.map((r) => r.row);
}
