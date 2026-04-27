/// Canonical course format. A course is a collection of chapters; each chapter
/// has one or more lessons. A lesson is either reading-only or contains an
/// exercise with a starter file, hidden solution, and hidden test file.
///
/// On disk this is a mix of JSON (structure) and Markdown (prose). At runtime
/// we load everything into these types.

export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "swift"
  | "go"
  | "web"
  | "threejs"
  | "react"
  | "reactnative"
  | "svelte"
  | "solid"
  | "htmx"
  | "astro"
  | "bun"
  | "tauri"
  | "c"
  | "cpp"
  | "java"
  | "kotlin"
  | "csharp"
  | "assembly"
  | "solidity";

/// Difficulty tier for challenge-pack exercises. Courses' exercises don't
/// set this — it's specific to the kata-style challenge packs that group
/// problems by how hard they are. Optional on both exercise kinds so
/// existing course lessons deserialize without a migration.
export type Difficulty = "easy" | "medium" | "hard";

/// A file in an exercise's workbench. Multi-file exercises list their files
/// here (e.g. index.html + style.css + script.js, or lib.rs + main.rs). For
/// legacy single-file exercises we synthesize one of these at runtime from
/// the `starter` field so the workbench UI always deals in file arrays.
///
/// `fileLanguage` is broader than the lesson's primary `language` because
/// individual files can be HTML or CSS even in a "javascript" lesson (web
/// projects). The primary language is still what picks the runtime.
/// Monaco language id for a single file in a workbench. Kept separate
/// from `LanguageId` (the lesson's PRIMARY language) because per-file
/// languages are narrower — you never have a single file whose language
/// is "web" or "threejs"; those are meta-languages that describe how
/// the lesson as a whole is run. A file inside a `web` lesson has its
/// own `"html"` / `"css"` / `"javascript"` language.
export type FileLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "swift"
  | "go"
  | "c"
  | "cpp"
  | "java"
  | "kotlin"
  | "csharp"
  | "assembly"
  | "solidity"
  | "html"
  | "css"
  | "json"
  | "svelte"
  | "markdown"
  | "plaintext";

export interface WorkbenchFile {
  /// Filename including extension — used by the UI as the tab label and by
  /// the test runner when the harness imports relative to the user module.
  name: string;
  /// Monaco language id for syntax highlighting. Also drives how we
  /// concatenate the file when running (e.g. CSS isn't executable JS, so
  /// it's ignored when building the JS test bundle).
  language: FileLanguage;
  /// Starter content shown when the exercise first opens, or current
  /// content in solutionFiles.
  content: string;
  /// When true, the user can't edit this file — useful for a reference
  /// library they should use but not modify. Still shown in tabs so the
  /// learner can read it.
  readOnly?: boolean;
}

/// Binary assets (images, textures, models, audio) that travel
/// alongside a workbench's files. Lives outside `WorkbenchFile` because
/// the content is base64-encoded — keeping files and assets in
/// separate arrays lets the Monaco tab bar ignore the binaries and the
/// runtime serve them via blob URLs / data URLs without parsing as
/// text. Referenced from HTML / CSS / JS via `/assets/<name>` paths,
/// which the web runtime rewrites at assembly time.
export interface WorkbenchAsset {
  /// Filename including extension (e.g. "hero.png", "ground.glb").
  /// Lives under the virtual `/assets/` prefix at runtime.
  name: string;
  /// MIME type for the data URL wrapper. Inferred from the extension
  /// at import time; stored so the runtime doesn't have to sniff.
  mimeType: string;
  /// Base64-encoded payload (no `data:` prefix). Kept as a string so
  /// it survives JSON serialization of the course / playground state.
  base64: string;
}

export interface Course {
  id: string;
  title: string;
  author?: string;
  description?: string;
  language: LanguageId;
  chapters: Chapter[];
  /// Distinguishes book-derived linear courses from kata-style challenge
  /// packs. Missing OR "course" means it's a linear course (default for
  /// everything imported before this field was added). "challenges" means
  /// the chapters are difficulty tiers and lessons carry `topic` tags.
  /// Shapes are identical so the same UI, persistence, and progress
  /// tracking apply — the flag is purely a classification for the
  /// sidebar, library, and profile views.
  packType?: "course" | "challenges";
  /// Epoch-ms timestamp of the most recent cover-artwork extraction.
  /// When present, the Library + Sidebar render the PNG at
  /// `<courses_dir>/<id>/cover.png` via the `load_course_cover` Tauri
  /// command. Acts as a cache-buster: re-fetching a cover bumps this
  /// value so the frontend invalidates its in-memory blob URL and
  /// reloads. Missing = no cover extracted yet.
  coverFetchedAt?: number;
  /// Origin of this course's content. Missing OR "pdf" means a book
  /// import (the original path); "docs" means the course was generated
  /// by crawling a documentation website via `crawl_docs_site`. Drives
  /// a small attribution badge in the Library and enables a future
  /// "re-sync from source" action that a PDF-derived course can't
  /// offer (the source might change).
  sourceType?: "pdf" | "docs";
  /// Starting URL of a doc-site crawl. Populated when `sourceType` is
  /// "docs". Used to re-sync the course against the live site and to
  /// link back to the original docs from the Library card's hover
  /// tooltip. Absent for PDF imports.
  sourceUrl?: string;
}

export interface Chapter {
  id: string;
  title: string;
  lessons: Lesson[];
}

export type Lesson = ReadingLesson | ExerciseLesson | MixedLesson | QuizLesson;

interface LessonBase {
  id: string;
  title: string;
  /** Markdown body shown in the reading pane. Code fences are highlighted via Shiki. */
  body: string;
  /**
   * 3-5 short bullets that say what the learner will know after this lesson.
   * Rendered as a "You'll learn" card above the body. Optional so older
   * lessons (or very short ones) can skip it — the reader just hides the
   * card when the array is missing or empty.
   */
  objectives?: string[];
  /**
   * Auto-generated reading aids for this lesson. Populated at ingest time
   * (see `generate_lesson` + the one-off `enrich_lesson` command) so
   * rendering costs nothing at read time. Everything inside is optional:
   * the reader degrades gracefully when `enrichment` is missing.
   */
  enrichment?: LessonEnrichment;
}

/**
 * Glossary / symbol reference data cached alongside the lesson's body.
 * Kept separately so the reader can compute first-use wrapping without
 * re-parsing the markdown, and so a future "lint the lesson" step can
 * validate every referenced term exists.
 */
export interface LessonEnrichment {
  /**
   * Every term-of-art introduced in this lesson (e.g. "closure", "borrow",
   * "generator"). Used for two UI pieces:
   *   - dotted underline on the FIRST occurrence of each term in the body
   *   - the collapsible Glossary side panel
   */
  glossary?: GlossaryEntry[];
  /**
   * Mapping from inline-code tokens (as they appear in backticks) to a
   * short signature + 1-line description + official doc URL. Drives the
   * hoverable popover on inline `code` spans and the "View full docs →"
   * link inside it.
   */
  symbols?: SymbolEntry[];
}

export interface GlossaryEntry {
  /** The term as it appears in the prose. Case-sensitive first-match. */
  term: string;
  /** One-sentence plain-language definition. Kept tight for popovers. */
  definition: string;
}

export interface SymbolEntry {
  /**
   * The string as it appears inside backticks, e.g. "Array.prototype.map"
   * or "Vec::new". Matched exactly against the text inside `<code>`.
   */
  pattern: string;
  /** Optional one-line signature shown above the description. */
  signature?: string;
  /** One-sentence description of what the symbol does. */
  description?: string;
  /**
   * Canonical docs URL — MDN for JS/TS, doc.rust-lang.org for Rust,
   * pkg.go.dev for Go, docs.python.org for Python. Click opens in the
   * default browser via Tauri's opener plugin.
   */
  docUrl?: string;
}

export interface ReadingLesson extends LessonBase {
  kind: "reading";
}

export interface ExerciseLesson extends LessonBase {
  kind: "exercise";
  language: LanguageId;
  /** Legacy single-file starter. For multi-file exercises, see `files`. */
  starter: string;
  /** Hidden reference solution for the single-file flow. See also `solutionFiles`. */
  solution: string;
  /** Hidden test file the evaluator runs against the user's code. */
  tests: string;
  /**
   * Progressive hints. The UI reveals them one at a time (click 1 shows hint
   * 0, click 2 shows hints 0–1, etc) so learners can escalate help as needed.
   * Optional — legacy lessons without hints just disable the Hint button.
   */
  hints?: string[];
  /**
   * Multi-file workbench. When present, takes precedence over `starter`. Each
   * file becomes a tab in the editor. The runnable files (matching the
   * lesson's primary language) are concatenated in order before running.
   */
  files?: WorkbenchFile[];
  /** Reference solution for a multi-file exercise. Mirrors `files` shape. */
  solutionFiles?: WorkbenchFile[];
  /**
   * Challenge-pack metadata (ignored when the parent course's packType is
   * "course"). Drives difficulty-dot coloring in the sidebar and the
   * topic bucket counts in the Profile view.
   */
  difficulty?: Difficulty;
  topic?: string;
}

/**
 * A mixed lesson has reading prose AND a runnable exercise. Used when a book
 * section is mostly narrative but caps with a "try it" task.
 */
export interface MixedLesson extends LessonBase {
  kind: "mixed";
  language: LanguageId;
  starter: string;
  solution: string;
  tests: string;
  hints?: string[];
  files?: WorkbenchFile[];
  solutionFiles?: WorkbenchFile[];
  difficulty?: Difficulty;
  topic?: string;
}

/**
 * Checkpoint lesson — a small batch of questions the user must get right to
 * complete the lesson. Mixes multiple-choice and short-answer so we can cover
 * both "pick the right definition" and "fill in the identifier" cases without
 * needing a full exercise.
 */
export interface QuizLesson extends LessonBase {
  kind: "quiz";
  questions: QuizQuestion[];
}

export type QuizQuestion = QuizMcq | QuizShort;

export interface QuizMcq {
  kind: "mcq";
  prompt: string;
  options: string[];
  /** Index into `options` of the correct answer. */
  correctIndex: number;
  /** Optional context shown after an answer is committed. */
  explanation?: string;
}

export interface QuizShort {
  kind: "short";
  prompt: string;
  /**
   * Accepted answers. Matching is case-insensitive and punctuation-stripped,
   * so `"prototype"`, `"Prototype"`, and `"prototype."` all match.
   */
  accept: string[];
  explanation?: string;
}

export function isExerciseKind(lesson: Lesson): lesson is ExerciseLesson | MixedLesson {
  return lesson.kind === "exercise" || lesson.kind === "mixed";
}

export function isQuiz(lesson: Lesson): lesson is QuizLesson {
  return lesson.kind === "quiz";
}

/// Challenge packs and courses share the same shape — this is the single
/// source of truth for which is which. Missing `packType` (legacy courses
/// on disk) counts as "course" so nothing changes for existing data.
export function isChallengePack(course: Course): boolean {
  return course.packType === "challenges";
}

/** Canonicalize a user or accepted-answer string for short-answer matching. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
