/// Mobile search palette — phone-sized analog of the desktop
/// `CommandPalette` (Cmd+K). Full-screen sheet with a search input
/// pinned at the top, courses + lessons listed below, ranked with the
/// same substring-prefix-includes scoring desktop uses so the same
/// query produces the same hits on either surface.
///
/// Quick-action rows (Open Library / Settings / Playground / etc.)
/// are intentionally dropped — mobile has none of those screens
/// modelled the way desktop does, and the bottom tab bar already
/// covers the navigations that matter. The palette here is a content
/// finder, not a generic launcher.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { search as searchIcon } from "@base/primitives/icon/icons/search";
import { bookOpen } from "@base/primitives/icon/icons/book-open";
import { code as codeIcon } from "@base/primitives/icon/icons/code";
import { helpCircle } from "@base/primitives/icon/icons/help-circle";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import type { Course, Lesson } from "../data/types";
import "./MobileSearchPalette.css";

/// Each row in the result list. `kind` only drives the icon + section
/// heading; selection is a callback so the parent can route however
/// it wants (open lesson, jump to library, etc.).
type RowKind = "course" | "lesson";

interface Row {
  id: string;
  kind: RowKind;
  label: string;
  hint?: string;
  icon: string;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  courses: Course[];
  /// Open a specific lesson — same shape as MobileApp.openLesson so
  /// the palette can navigate without knowing about the active-lesson
  /// state machine.
  onOpenLesson: (course: Course, chapterIndex: number, lessonIndex: number) => void;
}

export default function MobileSearchPalette({
  open,
  onClose,
  courses,
  onOpenLesson,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Build courseRows once per `courses` change. Selecting a course
  // jumps to its first lesson — same default the bottom-of-library
  // shelf uses, so behaviour is consistent across surfaces.
  const courseRows: Row[] = useMemo(
    () =>
      courses.map((c) => ({
        id: `course:${c.id}`,
        kind: "course",
        label: c.title,
        hint: c.author ? `${c.language} · ${c.author}` : c.language,
        icon: bookOpen,
        onSelect: () => {
          onOpenLesson(c, 0, 0);
          onClose();
        },
      })),
    [courses, onOpenLesson, onClose],
  );

  const lessonRows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const c of courses) {
      for (let ci = 0; ci < c.chapters.length; ci++) {
        const ch = c.chapters[ci];
        for (let li = 0; li < ch.lessons.length; li++) {
          const l = ch.lessons[li];
          out.push({
            id: `lesson:${c.id}:${l.id}`,
            kind: "lesson",
            label: l.title,
            hint: `${c.title} · ${ch.title}`,
            icon: lessonIconFor(l),
            onSelect: () => {
              onOpenLesson(c, ci, li);
              onClose();
            },
          });
        }
      }
    }
    return out;
  }, [courses, onOpenLesson, onClose]);

  // Empty query: surface the first dozen courses as a launcher hint
  // (mobile users glancing at the palette without typing should still
  // see something useful — this matches desktop's empty-query behaviour).
  // With a query: full substring rank across both pools, capped per
  // section so a generic word doesn't drown the list.
  const sections: Array<{ heading: string; rows: Row[] }> = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return [{ heading: "Courses", rows: courseRows.slice(0, 12) }];
    }
    const matchCourses = rankMatches(courseRows, q).slice(0, 8);
    const matchLessons = rankMatches(lessonRows, q).slice(0, 30);
    return [
      { heading: "Courses", rows: matchCourses },
      { heading: "Lessons", rows: matchLessons },
    ].filter((s) => s.rows.length > 0);
  }, [query, courseRows, lessonRows]);

  const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Reset on open + auto-focus the input. The 60ms delay lets the
  // sheet finish its slide-in transition before the keyboard slides
  // up — focusing too early causes the keyboard to pop while the
  // sheet is mid-animation, which feels jittery on iOS.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  // Hardware-keyboard escape (paired keyboard on iPad / sim).
  // Touchscreen users tap the close button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="m-search-backdrop" role="dialog" aria-label="Search">
      <div className="m-search">
        <header className="m-search__head">
          <span className="m-search__icon" aria-hidden>
            <Icon icon={searchIcon} size="sm" color="currentColor" />
          </span>
          <input
            ref={inputRef}
            type="search"
            className="m-search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lessons, courses…"
            aria-label="Search"
            spellCheck={false}
            autoComplete="off"
            // Stop iOS from auto-capitalizing the first character —
            // searches read more naturally as lowercase ("ownership"
            // not "Ownership"), and rankMatches is case-insensitive
            // so it doesn't matter for hit-rate either way.
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button
            type="button"
            className="m-search__close"
            onClick={onClose}
            aria-label="Close search"
          >
            <Icon icon={xIcon} size="md" color="currentColor" />
          </button>
        </header>

        <div className="m-search__results">
          {flatRows.length === 0 && (
            <div className="m-search__empty">
              No matches for <strong>"{query}"</strong>.
            </div>
          )}
          {sections.map((section) => (
            <div key={section.heading} className="m-search__section">
              <div className="m-search__section-heading">{section.heading}</div>
              {section.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="m-search__row"
                  onClick={row.onSelect}
                >
                  <span className="m-search__row-icon" aria-hidden>
                    <Icon icon={row.icon} size="sm" color="currentColor" />
                  </span>
                  <span className="m-search__row-body">
                    <span className="m-search__row-label">{row.label}</span>
                    {row.hint && (
                      <span className="m-search__row-hint">{row.hint}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/// Pick the per-kind glyph that lives next to a lesson row. Mirrors
/// the MobileOutline / desktop Sidebar mapping so the same lesson
/// reads with the same icon everywhere it appears.
function lessonIconFor(lesson: Lesson): string {
  switch (lesson.kind) {
    case "reading":
      return bookOpen;
    case "quiz":
      return helpCircle;
    case "exercise":
    case "mixed":
    case "puzzle":
    default:
      return codeIcon;
  }
}

/// Substring-rank a pool against `q` (already lowercased). Same
/// scoring formula the desktop CommandPalette uses; copied (not
/// imported) because importing pulls the desktop `Icon` chain into
/// the mobile bundle and inflates initial JS by ~80KB.
///   * `label.startsWith(q)` ⇒ +3 — strongest, "exact-prefix" feel
///   * `label.includes(q)`   ⇒ +2 — title hit
///   * `hint.includes(q)`    ⇒ +1 — secondary metadata hit
function rankMatches(pool: Row[], q: string): Row[] {
  const ranked: Array<{ row: Row; score: number }> = [];
  for (const row of pool) {
    const label = row.label.toLowerCase();
    const hint = (row.hint ?? "").toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score += 3;
    if (label.includes(q)) score += 2;
    if (hint.includes(q)) score += 1;
    if (score > 0) ranked.push({ row, score });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label),
  );
  return ranked.map((r) => r.row);
}
