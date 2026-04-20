/// Canonical course format. A course is a collection of chapters; each chapter
/// has one or more lessons. A lesson is either reading-only or contains an
/// exercise with a starter file, hidden solution, and hidden test file.
///
/// On disk this is a mix of JSON (structure) and Markdown (prose). At runtime
/// we load everything into these types.

export type LanguageId = "javascript" | "typescript" | "python" | "rust" | "swift";

export interface Course {
  id: string;
  title: string;
  author?: string;
  description?: string;
  language: LanguageId;
  chapters: Chapter[];
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
}

export interface ReadingLesson extends LessonBase {
  kind: "reading";
}

export interface ExerciseLesson extends LessonBase {
  kind: "exercise";
  language: LanguageId;
  /** Code the user sees in the editor on first open. */
  starter: string;
  /** Hidden reference solution. Not shown to the user. */
  solution: string;
  /** Hidden test file the evaluator runs against the user's code. */
  tests: string;
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

/** Canonicalize a user or accepted-answer string for short-answer matching. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
