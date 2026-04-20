/// kata-ingest CLI — turn a book into a Kata course.
///
/// Usage:
///   ANTHROPIC_API_KEY=sk-... tsx cli.ts <input-book> --out <dir> --lang <rust|javascript|python|swift>
///
/// The pipeline:
///   1. Parse the input (EPUB / PDF / Markdown) into an ordered list of
///      chapter bodies.
///   2. For each chapter, ask an LLM to structure it into lessons matching
///      the Kata course format (types.ts). Reading-heavy sections become
///      `reading` lessons; "try this" passages become `exercise` lessons
///      with starter/solution/tests generated from the book's code samples.
///   3. Assemble a `course.json` and write it to <out>/<course-id>/.
///   4. Optionally zip the folder as <out>/<course-id>.kata.
///
/// V1 of this CLI is a skeleton — it wires up the plumbing but the real
/// LLM prompt-chain and per-format parsers (EPUB vs PDF vs MD) land when we
/// have the actual book to tune against.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, basename, resolve as resolvePath, join as joinPath } from "node:path";

interface CliArgs {
  input: string;
  out: string;
  language: "javascript" | "typescript" | "python" | "rust" | "swift";
  courseId?: string;
  title?: string;
  author?: string;
  pack?: boolean; // also emit a .kata zip next to the folder
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0) usage("missing <input>");
  const input = args[0];
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = get("--out") ?? "./courses";
  const language = (get("--lang") ?? "javascript") as CliArgs["language"];
  if (!["javascript", "typescript", "python", "rust", "swift"].includes(language)) {
    usage(`unknown --lang ${language}`);
  }
  return {
    input,
    out,
    language,
    courseId: get("--id"),
    title: get("--title"),
    author: get("--author"),
    pack: args.includes("--pack"),
  };
}

function usage(msg: string): never {
  console.error(`kata-ingest: ${msg}\n`);
  console.error("Usage: tsx cli.ts <input-book> --out <dir> --lang <lang>");
  console.error("       [--id <course-id>] [--title <t>] [--author <a>] [--pack]");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[ingest] input=${args.input} lang=${args.language} out=${args.out}`);

  if (!existsSync(args.input)) {
    throw new Error(`input not found: ${args.input}`);
  }

  // Dispatch per format
  const ext = extname(args.input).toLowerCase();
  let chapters: RawChapter[];
  switch (ext) {
    case ".epub":
      chapters = await parseEpub(args.input);
      break;
    case ".md":
    case ".markdown":
      chapters = await parseMarkdown(args.input);
      break;
    case ".pdf":
      throw new Error("PDF ingest not implemented yet — convert to EPUB first");
    default:
      throw new Error(`unsupported extension ${ext}`);
  }
  console.log(`[ingest] parsed ${chapters.length} chapter(s)`);

  // Structure each chapter via LLM
  const structured = await structureChapters(chapters, args.language);
  console.log(`[ingest] structured into ${structured.reduce((n, c) => n + c.lessons.length, 0)} lesson(s)`);

  // Assemble course.json
  const courseId = args.courseId ?? deriveCourseId(args.input, args.title);
  const course = {
    id: courseId,
    title: args.title ?? deriveTitle(args.input),
    author: args.author,
    description: `Ingested from ${basename(args.input)}`,
    language: args.language,
    chapters: structured,
  };

  const courseDir = joinPath(args.out, courseId);
  await mkdir(courseDir, { recursive: true });
  await writeFile(joinPath(courseDir, "course.json"), JSON.stringify(course, null, 2));
  console.log(`[ingest] wrote ${courseDir}/course.json`);

  if (args.pack) {
    await packKata(courseDir, joinPath(args.out, `${courseId}.kata`));
    console.log(`[ingest] packed ${joinPath(args.out, `${courseId}.kata`)}`);
  }
}

// ---- Parsers ----------------------------------------------------------------

interface RawChapter {
  title: string;
  body: string;
}

async function parseEpub(_path: string): Promise<RawChapter[]> {
  // Placeholder: real impl uses the `epub2` package. Will be fleshed out
  // when the actual book arrives so we can tune against its exact structure.
  throw new Error("EPUB parsing stub — implement once we have the book in hand");
}

async function parseMarkdown(path: string): Promise<RawChapter[]> {
  const text = await readFile(path, "utf8");
  // Split on top-level `# ` headings. Everything between heading lines is a
  // chapter body. Falls back to one chapter if no headings exist.
  const lines = text.split("\n");
  const chapters: RawChapter[] = [];
  let cur: RawChapter | null = null;
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) {
      if (cur) chapters.push(cur);
      cur = { title: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) chapters.push(cur);
  if (chapters.length === 0) chapters.push({ title: basename(path), body: text });
  return chapters;
}

// ---- LLM structuring --------------------------------------------------------

interface LessonSpec {
  id: string;
  kind: "reading" | "exercise" | "mixed";
  title: string;
  body: string;
  language?: string;
  starter?: string;
  solution?: string;
  tests?: string;
}

interface ChapterSpec {
  id: string;
  title: string;
  lessons: LessonSpec[];
}

async function structureChapters(
  chapters: RawChapter[],
  language: CliArgs["language"],
): Promise<ChapterSpec[]> {
  const out: ChapterSpec[] = [];
  const useLLM = !!process.env.ANTHROPIC_API_KEY;

  for (const [i, ch] of chapters.entries()) {
    if (useLLM) {
      out.push(await structureWithClaude(ch, i, language));
    } else {
      // No key → deterministic fallback: one reading lesson per chapter.
      out.push({
        id: slug(ch.title, i),
        title: ch.title,
        lessons: [
          {
            id: `${slug(ch.title, i)}-reading`,
            kind: "reading",
            title: ch.title,
            body: ch.body.trim(),
          },
        ],
      });
    }
  }
  return out;
}

async function structureWithClaude(
  ch: RawChapter,
  index: number,
  _language: CliArgs["language"],
): Promise<ChapterSpec> {
  // Placeholder: calls Anthropic, asks for JSON matching LessonSpec[]. We'll
  // flesh this out against a real book so we can iterate on the prompt.
  console.warn(`[ingest] Claude prompt stub hit — using deterministic fallback for chapter '${ch.title}'`);
  return {
    id: slug(ch.title, index),
    title: ch.title,
    lessons: [
      {
        id: `${slug(ch.title, index)}-reading`,
        kind: "reading",
        title: ch.title,
        body: ch.body.trim(),
      },
    ],
  };
}

// ---- Packaging --------------------------------------------------------------

async function packKata(courseDir: string, destination: string): Promise<void> {
  const JSZip = (await import("jszip")).default;
  const { readFile, readdir, stat } = await import("node:fs/promises");
  const zip = new JSZip();

  async function walk(dir: string, relBase: string) {
    for (const entry of await readdir(dir)) {
      const full = joinPath(dir, entry);
      const rel = joinPath(relBase, entry);
      const st = await stat(full);
      if (st.isDirectory()) {
        zip.folder(rel);
        await walk(full, rel);
      } else {
        const buf = await readFile(full);
        zip.file(rel, buf);
      }
    }
  }
  await walk(courseDir, basename(courseDir));

  const blob = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, blob);
}

// ---- Helpers ----------------------------------------------------------------

function slug(s: string, fallback: number | string = "x"): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `chapter-${fallback}`;
}

function deriveCourseId(inputPath: string, title: string | undefined): string {
  return slug(title ?? basename(inputPath, extname(inputPath)));
}

function deriveTitle(inputPath: string): string {
  const name = basename(inputPath, extname(inputPath));
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

void resolvePath; // silence unused import until EPUB parser lands

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
