#!/usr/bin/env node
/// LLM-assisted micro-puzzle authoring. Walks every staged starter
/// course and, for each exercise/mixed lesson with a non-trivial
/// solution, asks Claude to pick 4-8 pedagogically-meaningful
/// single lines and blank ONE token per line. The result is a
/// `MicroPuzzleLesson` inserted immediately AFTER the source
/// exercise — same idempotency pattern the puzzle/cloze generator
/// uses.
///
/// REQUIRES: env var `ANTHROPIC_API_KEY`.
///
/// Usage:
///   node scripts/generate-micropuzzles.mjs                       # all courses
///   node scripts/generate-micropuzzles.mjs --course <id>         # one course
///   node scripts/generate-micropuzzles.mjs --course <id> --limit 5  # one course, first 5 lessons
///   node scripts/generate-micropuzzles.mjs --dry                 # print plan, no writes
///
/// Caching: responses are stored in `.cache/micropuzzles/<lesson-id>.json`
/// (gitignored) so re-running is free for previously-processed
/// lessons. Delete the cache file to force a re-author of one
/// lesson without nuking the rest.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STAGED = join(ROOT, "public", "starter-courses");
const CACHE = join(ROOT, ".cache", "micropuzzles");

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_LESSONS_PER_COURSE_DEFAULT = 999;
/// Skip authoring for solutions that are too short — fewer than 3
/// non-trivial lines makes for a degenerate one-card drill. Aligns
/// with the puzzle generator's MIN_SOLUTION_LINES.
const MIN_SOLUTION_LINES = 3;

const args = parseArgs(process.argv.slice(2));

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "[generate-micropuzzles] ANTHROPIC_API_KEY is unset. Export it before running.",
    );
    process.exit(1);
  }
  if (!existsSync(STAGED)) {
    console.error(
      `[generate-micropuzzles] expected ${STAGED} — run \`node scripts/extract-starter-courses.mjs\` first.`,
    );
    process.exit(1);
  }
  await mkdir(CACHE, { recursive: true });

  const files = (await readdir(STAGED)).filter(
    (f) => f.endsWith(".json") && f !== "manifest.json",
  );

  // Filter to a single course if --course was passed.
  const targetFiles = args.course
    ? files.filter((f) => f === `${args.course}.json`)
    : files;

  if (args.course && targetFiles.length === 0) {
    console.error(
      `[generate-micropuzzles] no staged course matches --course=${args.course}`,
    );
    process.exit(1);
  }

  let totalLessons = 0;
  let totalDrills = 0;
  let totalCacheHits = 0;
  let totalApiCalls = 0;

  for (const f of targetFiles) {
    const path = join(STAGED, f);
    const text = await readFile(path, "utf-8");
    const course = JSON.parse(text);
    if (!course.chapters) continue;

    console.log(`\n[generate-micropuzzles] === ${course.id} ===`);

    let drillsAdded = 0;
    let lessonsProcessed = 0;
    const limit = args.limit ?? MAX_LESSONS_PER_COURSE_DEFAULT;

    for (const chapter of course.chapters) {
      const next = [];
      for (const lesson of chapter.lessons) {
        next.push(lesson);
        if (lessonsProcessed >= limit) continue;
        if (
          lesson.id.endsWith("__puzzle") ||
          lesson.id.endsWith("__cloze") ||
          lesson.id.endsWith("__drill")
        ) {
          continue; // already an auto-derive
        }
        if (lesson.kind !== "exercise" && lesson.kind !== "mixed") continue;
        const drillId = `${lesson.id}__drill`;
        if (chapter.lessons.some((l) => l.id === drillId)) continue;
        if (!lesson.solution || lesson.solution.trim().length === 0) continue;
        const lines = lesson.solution.split(/\r?\n/);
        if (lines.length < MIN_SOLUTION_LINES) continue;

        lessonsProcessed += 1;
        const language = lesson.language || course.language;

        // Cache hit?
        const cacheKey = createHash("sha1")
          .update(`${course.id}|${lesson.id}|${MODEL}|${lesson.solution}`)
          .digest("hex")
          .slice(0, 16);
        const cachePath = join(CACHE, `${cacheKey}.json`);
        let challenges;
        if (existsSync(cachePath)) {
          challenges = JSON.parse(await readFile(cachePath, "utf-8"));
          totalCacheHits += 1;
          console.log(
            `  · ${lesson.id.padEnd(40)}  ↩ cache  (${challenges.length} cards)`,
          );
        } else {
          if (args.dry) {
            console.log(`  · ${lesson.id.padEnd(40)}  [dry-run, would call API]`);
            continue;
          }
          try {
            challenges = await authorChallenges({
              courseTitle: course.title,
              lessonTitle: lesson.title,
              language,
              body: lesson.body || "",
              starter: lesson.starter || "",
              solution: lesson.solution,
            });
            await writeFile(
              cachePath,
              JSON.stringify(challenges, null, 2),
              "utf-8",
            );
            totalApiCalls += 1;
            console.log(
              `  ✓ ${lesson.id.padEnd(40)}  ↤ Claude  (${challenges.length} cards)`,
            );
          } catch (e) {
            console.warn(
              `  ✗ ${lesson.id.padEnd(40)}  failed: ${e.message?.slice(0, 80)}`,
            );
            continue;
          }
        }

        if (!Array.isArray(challenges) || challenges.length === 0) continue;

        // Pre-render Shiki HTML for each line so the runtime doesn't
        // pay for highlighting. We do this in a background pass via
        // shiki's codeToHtml — same theme as the rest of the app.
        const shikiOk = await prerenderShiki(challenges, language);
        if (!shikiOk) {
          // Non-fatal — the renderer falls back to runtime Shiki.
          // Just note it.
          console.log(
            `    (skipped pre-render for ${lesson.id} — runtime fallback)`,
          );
        }

        const drillLesson = {
          id: drillId,
          kind: "micropuzzle",
          language,
          title: `${lesson.title} — drill`,
          body:
            "Single-line drills lifted from the canonical solution. Tap each blank to fill it; the next card auto-scrolls when you've nailed the current one.",
          prompt:
            challenges.length === 1
              ? "Tap the blank to fill it in."
              : `Tap each blank to fill it in. ${challenges.length} cards.`,
          challenges,
        };
        next.push(drillLesson);
        drillsAdded += 1;
        totalDrills += 1;
      }
      chapter.lessons = next;
    }

    if (drillsAdded > 0 && !args.dry) {
      await writeFile(path, JSON.stringify(course, null, 2), "utf-8");
      console.log(
        `[generate-micropuzzles] ${course.id}: +${drillsAdded} drill lesson(s) (${lessonsProcessed} processed)`,
      );
    } else if (lessonsProcessed === 0) {
      console.log(
        `[generate-micropuzzles] ${course.id}: no eligible exercises`,
      );
    }
    totalLessons += lessonsProcessed;
  }

  console.log("");
  console.log(
    `[generate-micropuzzles] processed ${totalLessons} lesson(s), authored ${totalDrills} drill(s)` +
      ` — ${totalApiCalls} API call(s), ${totalCacheHits} cache hit(s)`,
  );
}

/// One LLM round-trip. Returns an array of MicroPuzzleCard objects
/// (validated structurally — anything that fails validation throws
/// and the caller logs + skips).
async function authorChallenges({
  courseTitle,
  lessonTitle,
  language,
  body,
  starter,
  solution,
}) {
  const userPrompt = buildPrompt({
    courseTitle,
    lessonTitle,
    language,
    body,
    starter,
    solution,
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // Tight system message keeps the model on task — no
      // explanations, no preamble, just the JSON.
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("no text in response");
  // Strip ``` fences if the model adds them.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`bad JSON from model: ${e.message}; got: ${stripped.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`expected JSON array, got ${typeof parsed}`);
  }
  // Validate + normalise each challenge.
  const out = [];
  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i];
    if (!raw || typeof raw.line !== "string") continue;
    if (!Array.isArray(raw.blanks) || raw.blanks.length === 0) continue;
    if (raw.line.length > 240) continue; // single-line cap
    // Stable card id from line content.
    const cardHash = createHash("sha1")
      .update(`${i}|${raw.line}`)
      .digest("hex")
      .slice(0, 8);
    const blanks = [];
    for (let j = 0; j < raw.blanks.length; j++) {
      const b = raw.blanks[j];
      if (!b || typeof b.answer !== "string") continue;
      if (!Array.isArray(b.options) || b.options.length < 2) continue;
      if (!b.options.includes(b.answer)) {
        // Force the answer to be in options.
        b.options = [b.answer, ...b.options.filter((o) => o !== b.answer)];
      }
      const slotId = createHash("sha1")
        .update(`${cardHash}|${j}|${b.answer}`)
        .digest("hex")
        .slice(0, 8);
      blanks.push({
        id: slotId,
        answer: b.answer,
        options: b.options.slice(0, 5),
        hint: typeof b.hint === "string" ? b.hint : undefined,
      });
      // Replace the marker(s) in the line with __SLOT_<id>__.
      // The model is asked to put `{{1}}` / `{{2}}` markers; we
      // accept those plus a few common variants.
      // (Done after the loop builds the canonical id.)
    }
    if (blanks.length === 0) continue;
    // Normalise the line: replace `{{1}}` style markers with our
    // __SLOT_<id>__ format. Markers are 1-indexed so blanks[i-1]
    // gives the matching slot.
    let line = raw.line;
    for (let j = 0; j < blanks.length; j++) {
      const num = j + 1;
      const marker = new RegExp(`\\{\\{\\s*${num}\\s*\\}\\}`, "g");
      line = line.replace(marker, `__SLOT_${blanks[j].id}__`);
    }
    // If the line still doesn't contain any markers, fall back to
    // marker-from-answer: replace the first occurrence of each
    // blank's answer with a slot marker.
    for (let j = 0; j < blanks.length; j++) {
      if (line.includes(`__SLOT_${blanks[j].id}__`)) continue;
      const idx = line.indexOf(blanks[j].answer);
      if (idx === -1) continue;
      line =
        line.slice(0, idx) +
        `__SLOT_${blanks[j].id}__` +
        line.slice(idx + blanks[j].answer.length);
    }
    if (!blanks.every((b) => line.includes(`__SLOT_${b.id}__`))) {
      // At least one blank couldn't be located in the line — skip
      // this card rather than ship a half-broken puzzle.
      continue;
    }
    out.push({
      id: `mp-${cardHash}`,
      line,
      hint: typeof raw.hint === "string" ? raw.hint : undefined,
      explanation:
        typeof raw.explanation === "string" ? raw.explanation : undefined,
      blanks,
    });
  }
  if (out.length === 0) {
    throw new Error("zero valid challenges after validation");
  }
  return out;
}

const SYSTEM_PROMPT = `You design single-line fill-in-the-blank coding drills for a learning app.

For a given lesson, output a JSON ARRAY of 4-8 single-line code drills derived from the canonical solution. Each drill targets ONE pedagogically-meaningful concept the lesson is teaching.

Rules:
- One line per drill. Maximum 80 columns. No multi-line blocks.
- Each drill blanks 1 OR 2 tokens (function names, key keywords, magic constants, type names). Place \`{{1}}\` (and optionally \`{{2}}\`) where the blanks go.
- Provide 3-4 plausible distractors per blank — same shape as the answer (other identifiers from the lesson, similar-looking keywords, common mistakes).
- Pick lines that test understanding, not trivia: the function NAME the lesson teaches, the key keyword that distinguishes the concept, the specific value that matters.
- Skip lines that are just braces, blank lines, comments, or boilerplate.
- Output STRICT JSON only — no markdown, no preamble, no explanation outside the JSON.

Each drill object has: { line, hint, explanation, blanks: [{ answer, options, hint }] }
- \`line\`: the single line with \`{{1}}\` / \`{{2}}\` markers
- \`hint\`: ONE short phrase (~6 words) shown above the card to orient the learner
- \`explanation\`: ONE short sentence revealed AFTER all blanks are correct
- \`blanks[].answer\`: the correct token AS IT APPEARS in the source
- \`blanks[].options\`: array of 4 strings INCLUDING the answer
- \`blanks[].hint\`: ONE word category like "function", "keyword", "type", "value"`;

function buildPrompt({
  courseTitle,
  lessonTitle,
  language,
  body,
  starter,
  solution,
}) {
  // Trim the body so the prompt doesn't blow past 200KB on long
  // lessons — Claude can do without 50 paragraphs of prose. The
  // solution is the most important context.
  const trimmedBody = body.length > 4000 ? body.slice(0, 4000) + "…" : body;
  return `COURSE: ${courseTitle}
LESSON: ${lessonTitle}
LANGUAGE: ${language}

LESSON BODY:
${trimmedBody}

STARTER:
\`\`\`${language}
${starter || "(none)"}
\`\`\`

CANONICAL SOLUTION:
\`\`\`${language}
${solution}
\`\`\`

Generate the JSON array of single-line drills now.`;
}

/// Pre-render every challenge's `line` via Shiki so the client
/// doesn't need to bundle the highlighter. Returns true if the
/// pass succeeded for at least one card.
async function prerenderShiki(challenges, language) {
  // Lazy-import shiki so the script doesn't pay the load cost
  // when --dry is set.
  let codeToHtml;
  try {
    ({ codeToHtml } = await import("shiki"));
  } catch (e) {
    console.warn(`  (shiki not available: ${e.message?.slice(0, 80)})`);
    return false;
  }
  const lang = shikiLang(language);
  let any = false;
  for (const c of challenges) {
    // Replace markers with sentinels so Shiki sees identifier-shaped
    // tokens (the same trick MobileMicroPuzzle uses at runtime).
    const slotIds = [];
    let prepared = c.line.replace(/__SLOT_([A-Za-z0-9_-]+)__/g, (_m, id) => {
      const idx = slotIds.length;
      slotIds.push(id);
      return `__FBSLOT${idx}__`;
    });
    let html;
    try {
      html = await codeToHtml(prepared, { lang, theme: "github-dark" });
    } catch {
      continue;
    }
    for (let i = 0; i < slotIds.length; i++) {
      const span = `<span data-mp-slot="${slotIds[i]}" class="m-mp__chip m-mp__chip--empty"></span>`;
      html = html.replace(`__FBSLOT${i}__`, span);
    }
    c.lineHtml = html;
    any = true;
  }
  return any;
}

function shikiLang(language) {
  switch (language) {
    case "reactnative":
      return "tsx";
    case "threejs":
      return "javascript";
    case "vyper":
      return "python";
    case "bun":
      return "typescript";
    case "assembly":
      return "asm";
    default:
      return language;
  }
}

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") out.dry = true;
    else if (a === "--course") out.course = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

main().catch((err) => {
  console.error("[generate-micropuzzles] failed:", err);
  process.exit(1);
});
