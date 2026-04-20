/// Client-side PDF → Course pipeline. Mirrors the Node CLI in ingest/pdf-parser.ts
/// + ingest/cli.ts so a book imported through the app window produces the
/// same shape as `tsx cli.ts ...`.
///
/// The Tauri command `extract_pdf_text` handles the poppler call (pdftotext);
/// everything else runs in the webview so we only maintain one parser.

import type { Course, LanguageId } from "../data/types";

export interface IngestOptions {
  courseId: string;
  title: string;
  author?: string;
  language: LanguageId;
}

export interface RawChapter {
  title: string;
  intro: string;
  sections: RawSection[];
}

export interface RawSection {
  title: string;
  body: string;
}

export function textToCourse(raw: string, opts: IngestOptions): Course {
  const chapters = splitChapters(raw);

  return {
    id: opts.courseId,
    title: opts.title,
    author: opts.author,
    description: "Ingested in-app from a PDF",
    language: opts.language,
    chapters: chapters.map((ch, i) => ({
      id: slug(ch.title, i),
      title: ch.title,
      lessons: sectionsToLessons(ch, i),
    })),
  };
}

// ---- Chapter / section splitting -------------------------------------------

export function splitChapters(text: string): RawChapter[] {
  const lines = text.split("\n");
  const tocSections = parseTocSections(lines);

  // Chapter openings: a line starting with `\fChapter N. Title`. Form-feeds
  // mark page breaks in pdftotext output — real chapter openings always sit
  // on a fresh page, so they have a `\f` prefix.
  const chapterHits: Array<{ title: string; lineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\fChapter\s+(\d+)\.\s+(.+?)$/.exec(lines[i]);
    if (!m) continue;

    let title = m[2].trim();
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) break;
      if (next.length > 60) break;
      if (/[.,:;]$/.test(next)) break;
      title += " " + next;
      if (title.length > 80) break;
    }

    chapterHits.push({ title, lineIndex: i });
  }

  if (chapterHits.length === 0) {
    return [
      {
        title: "Book",
        intro: "",
        sections: [{ title: "Body", body: stripPageNoise(text) }],
      },
    ];
  }

  const out: RawChapter[] = [];
  for (let c = 0; c < chapterHits.length; c++) {
    const { title, lineIndex } = chapterHits[c];
    const end = c + 1 < chapterHits.length ? chapterHits[c + 1].lineIndex : lines.length;
    const bodyLines = lines.slice(lineIndex + 1, end);

    const sections = splitSections(bodyLines, tocSections.get(title) ?? []);
    const intro =
      sections.length > 0
        ? bodyLines.slice(0, sections[0].startIndex).join("\n")
        : bodyLines.join("\n");

    out.push({
      title,
      intro: stripPageNoise(intro).trim(),
      sections: sections.map((s) => ({
        title: s.title,
        body: stripPageNoise(s.body).trim(),
      })),
    });
  }
  return out;
}

function parseTocSections(lines: string[]): Map<string, string[]> {
  const tocWindow = lines.slice(0, Math.min(200, lines.length));
  const byChapter = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of tocWindow) {
    const line = raw.trim();
    if (!line) continue;

    const chap = /^\d+\.\s+\d+\.\s+(.+)$/.exec(line);
    if (chap) {
      current = chap[1].trim();
      byChapter.set(current, []);
      continue;
    }
    const sec = /^[a-z]\.\s+(.+)$/.exec(line);
    if (sec && current) {
      byChapter.get(current)!.push(sec[1].trim());
    }
    if (line.length > 90) break;
  }
  return byChapter;
}

function splitSections(
  bodyLines: string[],
  knownSectionTitles: string[],
): Array<{ title: string; body: string; startIndex: number }> {
  if (knownSectionTitles.length === 0) {
    return [{ title: "Body", body: bodyLines.join("\n"), startIndex: 0 }];
  }

  const titleSet = new Set(knownSectionTitles);
  const hits: Array<{ title: string; lineIndex: number }> = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (!titleSet.has(line)) continue;
    hits.push({ title: line, lineIndex: i });
  }

  if (hits.length === 0) {
    return [{ title: "Body", body: bodyLines.join("\n"), startIndex: 0 }];
  }

  const out: Array<{ title: string; body: string; startIndex: number }> = [];
  for (let i = 0; i < hits.length; i++) {
    const { title, lineIndex } = hits[i];
    const end = i + 1 < hits.length ? hits[i + 1].lineIndex : bodyLines.length;
    const body = bodyLines.slice(lineIndex + 1, end).join("\n");
    out.push({ title, body, startIndex: lineIndex });
  }
  return out;
}

// ---- Lesson shaping --------------------------------------------------------

function sectionsToLessons(ch: RawChapter, chIndex: number) {
  const lessons: {
    id: string;
    kind: "reading";
    title: string;
    body: string;
  }[] = [];

  if (ch.intro) {
    lessons.push({
      id: slug(`${ch.title}-overview`, `${chIndex}-0`),
      kind: "reading",
      title: `${ch.title} — Overview`,
      body: ch.intro,
    });
  }

  for (const [i, s] of ch.sections.entries()) {
    if (!s.body) continue;
    lessons.push({
      id: slug(s.title, `${chIndex}-${i + 1}`),
      kind: "reading",
      title: s.title,
      body: s.body,
    });
  }

  if (lessons.length === 0) {
    lessons.push({
      id: slug(ch.title, chIndex),
      kind: "reading",
      title: ch.title,
      body: "(empty chapter)",
    });
  }
  return lessons;
}

// ---- Helpers ---------------------------------------------------------------

function stripPageNoise(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/^\s*\d+\s*$/.test(l))
    .join("\n");
}

function slug(s: string, fallback: number | string = "x"): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `chapter-${fallback}`;
}
