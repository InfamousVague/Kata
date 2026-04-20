/// The full ingest pipeline, run from the webview.
///
/// Stages:
///   0. extract_pdf_text (pdftotext)
///   1. clean_code (LLM per chapter)
///   2. outline_chapter (LLM per chapter)
///   3. generate_lesson (LLM per stub)
///   4. validate exercises: solution-passes + starter-fails, retry 3x
///   5. assemble Course and return it (caller decides whether to save)
///
/// Every stage caches its output via cache_read/cache_write so interrupted
/// runs resume from the last completed stage.
///
/// Each pipeline call emits progress events via an onProgress callback so
/// the UI can show what's happening and the user doesn't stare at a blank
/// window while Claude thinks.

import { invoke } from "@tauri-apps/api/core";
import { runCode, isPassing } from "../runtimes";
import type {
  Course,
  Lesson,
  LanguageId,
  ReadingLesson,
  ExerciseLesson,
} from "../data/types";
import { splitChapters } from "./pdfParser";

// Local shape for stage-1 input (per-chapter blob). Distinct from pdfParser's
// RawChapter which carries section-level metadata we flatten down.
interface ChapterBlob {
  title: string;
  body: string;
}

export interface PipelineOptions {
  pdfPath: string;
  bookId: string;       // slugified id used for cache directory + course id
  title: string;
  author?: string;
  language: LanguageId;
  onProgress: (stage: string, detail?: string) => void;
}

export async function runPipeline(opts: PipelineOptions): Promise<Course> {
  const { pdfPath, bookId, title, author, language, onProgress } = opts;

  // ---- Stage 0: extract raw text -----------------------------------------
  onProgress("Extracting text from PDF…");
  let rawText = await cacheRead(bookId, "raw.txt");
  if (!rawText) {
    const res = await invoke<{ text: string; error: string | null }>(
      "extract_pdf_text",
      { path: pdfPath },
    );
    if (res.error) throw new Error(res.error);
    rawText = res.text;
    await cacheWrite(bookId, "raw.txt", rawText);
  }

  // ---- Stage 1: split into raw chapters, then clean each with Claude ----
  const rawChapters = splitChaptersIntoRaw(rawText);
  if (rawChapters.length === 0) throw new Error("No chapters detected in PDF.");
  onProgress(`Found ${rawChapters.length} chapter(s).`);

  const cleaned: Array<{ title: string; markdown: string }> = [];
  for (let i = 0; i < rawChapters.length; i++) {
    const ch = rawChapters[i];
    const cacheKey = `clean/chapter-${pad(i + 1)}.md`;
    onProgress(
      `Cleaning + fencing code: chapter ${i + 1}/${rawChapters.length}`,
      ch.title,
    );
    let md = await cacheRead(bookId, cacheKey);
    if (!md) {
      md = await invoke<string>("clean_code", {
        chapterTitle: ch.title,
        rawText: ch.body,
      });
      await cacheWrite(bookId, cacheKey, md);
    }
    cleaned.push({ title: ch.title, markdown: md });
  }

  // ---- Stage 2: outline each chapter ------------------------------------
  const outlines: Array<{ title: string; stubs: LessonStub[] }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const cacheKey = `outlines/chapter-${pad(i + 1)}.json`;
    onProgress(
      `Outlining lessons: chapter ${i + 1}/${cleaned.length}`,
      ch.title,
    );
    let raw = await cacheRead(bookId, cacheKey);
    if (!raw) {
      raw = await invoke<string>("outline_chapter", {
        chapterTitle: ch.title,
        cleanedMarkdown: ch.markdown,
        language,
      });
      await cacheWrite(bookId, cacheKey, raw);
    }
    const stubs = parseJson<LessonStub[]>(raw, `outline of ${ch.title}`);
    outlines.push({ title: ch.title, stubs });
  }

  // ---- Stage 3: generate each lesson, Stage 4 validate exercises ---------
  const chapters: Course["chapters"] = [];
  for (let ci = 0; ci < outlines.length; ci++) {
    const ch = outlines[ci];
    const lessons: Lesson[] = [];

    // Section-scoped progressive exercises: remember the most recent solution
    // from this chapter so the next exercise's starter can be the previous
    // solution if the LLM wants progression. Reset at chapter boundaries.
    let priorSolution: string | undefined;

    for (let li = 0; li < ch.stubs.length; li++) {
      const stub = ch.stubs[li];
      const cacheKey = `lessons/chapter-${pad(ci + 1)}/${slug(stub.id)}.json`;
      onProgress(
        `Generating lesson ${li + 1}/${ch.stubs.length} of chapter ${ci + 1}`,
        `${stub.title} (${stub.kind})`,
      );

      let rawLesson = await cacheRead(bookId, cacheKey);
      if (!rawLesson) {
        rawLesson = await invoke<string>("generate_lesson", {
          chapterTitle: ch.title,
          cleanedMarkdown: cleaned[ci].markdown,
          language,
          stub: JSON.stringify(stub),
          priorSolution: priorSolution ?? null,
        });
        await cacheWrite(bookId, cacheKey, rawLesson);
      }
      let lesson = parseJson<Lesson>(rawLesson, `lesson ${stub.id}`);

      // Stage 4: validate exercises
      if (lesson.kind === "exercise" || lesson.kind === "mixed") {
        const validated = await validateExerciseWithRetry(
          lesson as ExerciseLesson,
          {
            bookId,
            chapterIndex: ci,
            stubId: stub.id,
            onProgress,
          },
        );
        lesson = validated;
        if (lesson.kind === "exercise") priorSolution = lesson.solution;
      }

      lessons.push(lesson);
    }

    chapters.push({ id: slug(ch.title), title: ch.title, lessons });
  }

  // ---- Assemble final course --------------------------------------------
  return {
    id: bookId,
    title,
    author,
    description: "Auto-generated by Kata's AI pipeline",
    language,
    chapters,
  };
}

// ---- Stage 4 helper --------------------------------------------------------

const MAX_RETRIES = 3;

async function validateExerciseWithRetry(
  lesson: ExerciseLesson,
  ctx: {
    bookId: string;
    chapterIndex: number;
    stubId: string;
    onProgress: PipelineOptions["onProgress"];
  },
): Promise<Lesson> {
  let current = lesson;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    ctx.onProgress(
      `Validating exercise (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
      current.title,
    );

    const failure = await validateOnce(current);
    if (!failure) {
      return current; // passes both gates
    }

    if (attempt === MAX_RETRIES) {
      // Strike out — demote to a reading lesson with the example inline.
      ctx.onProgress(
        `⚠️  Exercise couldn't be validated, demoting to reading`,
        current.title,
      );
      return demoteToReading(current, failure);
    }

    // Ask the LLM to fix it.
    const retryKey = `lessons/chapter-${pad(ctx.chapterIndex + 1)}/${slug(
      ctx.stubId,
    )}.retry-${attempt + 1}.json`;
    const rawFixed = await invoke<string>("retry_exercise", {
      originalLesson: JSON.stringify(current),
      failureReason: failure,
    });
    await cacheWrite(ctx.bookId, retryKey, rawFixed);
    current = parseJson<ExerciseLesson>(rawFixed, `${current.id} retry ${attempt + 1}`);
  }

  return current;
}

/// Returns null if the exercise passes BOTH gates (solution passes every test,
/// starter fails at least one). Otherwise returns a human-readable reason.
async function validateOnce(lesson: ExerciseLesson): Promise<string | null> {
  // Non-JS/TS/Python exercises can't run in-browser for full validation yet.
  // Trust the LLM on those for now; Rust uses the Playground and Swift is
  // run-only. Validation is still a huge quality lift for the languages we
  // *can* run.
  const runnable =
    lesson.language === "javascript" ||
    lesson.language === "typescript" ||
    lesson.language === "python";
  if (!runnable) return null;

  // Gate 1: solution must pass every test.
  const solRes = await runCode(lesson.language, lesson.solution, lesson.tests);
  if (!isPassing(solRes)) {
    const failingTests = solRes.tests?.filter((t) => !t.passed) ?? [];
    const first = failingTests[0];
    const errText = solRes.error ? ` [runtime error] ${solRes.error}` : "";
    const testText = first
      ? ` [first failing test] "${first.name}": ${first.error ?? "(no message)"}`
      : "";
    return `Reference solution failed validation.${errText}${testText}`;
  }

  // Gate 2: starter must fail at least one test (otherwise the task is trivial).
  const startRes = await runCode(lesson.language, lesson.starter, lesson.tests);
  if (isPassing(startRes)) {
    return "Starter code already passes every test — there's nothing for the user to solve. Add TODOs to the starter.";
  }

  return null;
}

function demoteToReading(lesson: ExerciseLesson, reason: string): ReadingLesson {
  return {
    id: lesson.id,
    kind: "reading",
    title: lesson.title + " (demoted)",
    body:
      lesson.body +
      `\n\n---\n\n*(This exercise was demoted to a reading lesson after ${MAX_RETRIES} validation failures: ${reason})*` +
      "\n\n## Reference solution\n\n```" +
      lesson.language +
      "\n" +
      lesson.solution +
      "\n```",
  };
}

// ---- Helpers ---------------------------------------------------------------

interface LessonStub {
  id: string;
  kind: "reading" | "exercise" | "quiz" | "mixed";
  title: string;
  intent: string;
}

function splitChaptersIntoRaw(rawText: string): ChapterBlob[] {
  // Re-use the deterministic splitter from pdfParser — it's good enough at
  // partitioning the raw text into per-chapter chunks for the LLM to work on.
  // We flatten the section-level structure into a single body per chapter
  // since Stage 1 (clean_code) re-finds headings on its own.
  const fullChapters = splitChapters(rawText);
  return fullChapters.map((c) => ({
    title: c.title,
    body:
      (c.intro ? c.intro + "\n\n" : "") +
      c.sections
        .map((s) => `## ${s.title}\n\n${s.body}`)
        .join("\n\n"),
  }));
}

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const snippet = raw.slice(0, 300);
    throw new Error(
      `LLM returned invalid JSON for ${context}: ${e}\n\nFirst 300 chars:\n${snippet}`,
    );
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "x";
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

async function cacheRead(bookId: string, key: string): Promise<string | null> {
  try {
    const v = await invoke<string | null>("cache_read", { bookId, key });
    return v ?? null;
  } catch {
    return null;
  }
}

async function cacheWrite(bookId: string, key: string, contents: string): Promise<void> {
  try {
    await invoke("cache_write", { bookId, key, contents });
  } catch {
    /* ignore — cache is best-effort */
  }
}
