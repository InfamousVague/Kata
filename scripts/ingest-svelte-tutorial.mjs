#!/usr/bin/env node
/// Ingest the official Svelte tutorial (https://svelte.dev/tutorial)
/// into a Fishbones course.
///
/// Source-of-truth: the markdown + asset directories under
/// `apps/svelte.dev/content/tutorial/` in the public `sveltejs/svelte.dev`
/// repo. Each subfolder is one tutorial step; we walk recursively,
/// build a Lesson per step, and emit a single `course.json` into the
/// app-data courses dir.
///
/// Tutorial-side conventions we honour:
///   - `index.md` carries a `--- title: ... ---` frontmatter + body.
///   - Body uses `+++…+++` markers to diff-highlight the code that
///     should be added in this step. We strip the markers but keep
///     the inner text — the learner sees the same code, just without
///     the (off-Svelte-site) highlight syntax.
///   - `+assets/app-a/...` is the STARTER file set for the lesson.
///     Files are typically under `src/lib/<file>` in app-a.
///   - `+assets/app-b/...` is the SOLUTION file set, same layout.
///   - When `+assets/` is absent the page is reading-only — there's
///     no exercise to do, just prose to read (intros, "next steps",
///     etc.).
///
/// Fishbones-side conventions:
///   - 4 sections (Basic Svelte / Advanced Svelte / Basic SvelteKit /
///     Advanced SvelteKit) become 4 separate courses under one course
///     id each.
///   - Each tutorial chapter (numbered subfolder) becomes a Fishbones
///     chapter; lessons under it are flat.
///   - SvelteKit sections are kept but every lesson is forced to
///     `kind: "reading"` — the in-browser Svelte runtime ships
///     CSR-only, no server, so the tutorial's `+server.js` /
///     `+page.server.ts` examples can't run. The prose still reads
///     well as a reference.
///
/// Usage:
///   node scripts/ingest-svelte-tutorial.mjs <path-to-svelte.dev-checkout>
///
/// The checkout argument should point at a sparse clone of the
/// `sveltejs/svelte.dev` repo (see CLI hint emitted on missing arg).
/// Output goes to:
///   ~/Library/Application Support/com.mattssoftware.kata/courses/svelte-tutorial/course.json
///   ~/Library/Application Support/com.mattssoftware.kata/courses/svelte-tutorial-advanced/course.json
///   ~/Library/Application Support/com.mattssoftware.kata/courses/sveltekit-tutorial/course.json
///   ~/Library/Application Support/com.mattssoftware.kata/courses/sveltekit-tutorial-advanced/course.json

import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const APP_SUPPORT = join(
  homedir(),
  "Library/Application Support/com.mattssoftware.kata/courses",
);

/// One Fishbones course covering the entire upstream tutorial. The 4
/// upstream "books" (Basic / Advanced Svelte, Basic / Advanced
/// SvelteKit) become 4 SECTIONS within this single course; each
/// section's tutorial chapters get prefixed with the section label
/// so the sidebar reads as a flat list without losing the upstream
/// hierarchy ("Basic Svelte · Introduction" → "Welcome to Svelte").
const COURSE = {
  id: "svelte-tutorial",
  title: "Svelte Tutorial",
  description:
    "The complete official Svelte tutorial — Basic Svelte, Advanced Svelte, Basic SvelteKit, and Advanced SvelteKit — collected into one course. Svelte sections are runnable exercises; SvelteKit sections are reading-only because Fishbones' Svelte runtime is CSR-only and can't host server endpoints.",
  author: "Svelte tutorial (svelte.dev)",
  language: "svelte",
};

const SECTIONS = [
  {
    folder: "01-svelte",
    label: "Basic Svelte",
    slug: "basic-svelte",
    runnable: true,
  },
  {
    folder: "02-advanced-svelte",
    label: "Advanced Svelte",
    slug: "advanced-svelte",
    runnable: true,
  },
  {
    // SvelteKit sections are now runnable too — Fishbones ships a
    // Node-backed runner that scaffolds a real SvelteKit project on
    // disk and runs `vite dev` in the background per lesson. See
    // src-tauri/src/sveltekit_runner.rs for the lifecycle.
    folder: "03-sveltekit",
    label: "Basic SvelteKit",
    slug: "basic-sveltekit",
    runnable: true,
  },
  {
    folder: "04-advanced-sveltekit",
    label: "Advanced SvelteKit",
    slug: "advanced-sveltekit",
    runnable: true,
  },
];

function parseFrontmatter(md) {
  // Frontmatter looks like:
  //   ---
  //   title: Welcome to Svelte
  //   ---
  // Anything else (kind: legacy?, etc.) is preserved into a meta map.
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/// Strip the tutorial site's `+++...+++` highlight markers. They wrap
/// the lines/spans the official tutorial UI animates as "this is what
/// changed" — useful in the live tutorial, distracting in plain
/// rendered markdown. Removing leaves the inner text intact, which
/// is the actual code the learner needs to type.
function stripDiffMarkers(md) {
  return md
    .replace(/\+\+\+([\s\S]*?)\+\+\+/g, "$1")
    .replace(/---([\s\S]*?)---/g, "$1");
}

/// Walk the `+assets/<which>/` tree and gather files into a flat list
/// of `{ name, language, content }` entries the Fishbones workbench
/// expects. Names are flattened to the tail (e.g. `App.svelte` not
/// `src/lib/App.svelte`) since the runtime picks the first .svelte
/// file by name. Multi-component lessons keep their relative paths
/// so the `import './Nested.svelte'` style still reads correctly.
async function collectAssetFiles(assetsDir) {
  if (!existsSync(assetsDir)) return [];
  const out = [];
  async function walk(d, rel) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, r);
      } else {
        const content = await readFile(full, "utf-8");
        out.push({
          // Default to the bare filename so the workbench's tab
          // strip stays readable, but keep nested paths for files
          // outside `src/lib/` (assets, package.json, etc.) so
          // multi-file lessons preserve structure.
          name: shortenPath(r),
          language: detectLanguage(e.name),
          content,
        });
      }
    }
  }
  await walk(assetsDir, "");
  return out;
}

/// Most tutorial files live under `src/lib/<File>` — the prefix is
/// SvelteKit boilerplate the learner doesn't need to navigate. Keep
/// only the tail when present. Files outside src/lib (server hooks,
/// etc.) keep their relative path so SvelteKit lessons still convey
/// project structure.
function shortenPath(rel) {
  const m = /^src\/lib\/(.+)$/.exec(rel);
  if (m) return m[1];
  const m2 = /^src\/(.+)$/.exec(rel);
  if (m2) return m2[1];
  return rel;
}

/// True when two file sets represent the same code (same names + same
/// contents). Lets us treat "starter == solution" lessons as
/// reading-only — nothing for the learner to actually change.
function sameFileSet(a, b) {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((f) => [f.name, f.content]));
  for (const f of b) {
    if (map.get(f.name) !== f.content) return false;
  }
  return true;
}

function detectLanguage(name) {
  if (name.endsWith(".svelte")) return "svelte";
  if (name.endsWith(".ts")) return "typescript";
  if (name.endsWith(".js")) return "javascript";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".html")) return "html";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".md")) return "markdown";
  return "plaintext";
}

function lessonId(sectionSlug, chapterFolder, lessonFolder) {
  // Section slug + chapter + lesson keeps the id unique across the
  // merged course. Without it `01-introduction--01-welcome-to-svelte`
  // would collide between Basic Svelte and Basic SvelteKit since
  // each section restarts numbering at 01.
  return `${sectionSlug}--${chapterFolder}--${lessonFolder}`.replace(
    /[^a-z0-9-]/gi,
    "-",
  );
}

function chapterId(sectionSlug, chapterFolder) {
  return `${sectionSlug}--${chapterFolder}`;
}

function chapterTitle(folder, sectionLabel) {
  // `01-introduction` → `Basic Svelte · Introduction`. The middle dot
  // reads as a soft separator without competing with the chapter
  // titles' own punctuation. Section label first puts the natural
  // sort order in alphabetical/visual register.
  const base = folder
    .replace(/^[0-9]+-/, "")
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return `${sectionLabel} · ${base}`;
}

async function buildLesson({
  sectionSlug,
  chapterFolder,
  lessonFolder,
  lessonDir,
  runnable,
}) {
  const indexPath = join(lessonDir, "index.md");
  if (!existsSync(indexPath)) return null;
  const raw = await readFile(indexPath, "utf-8");
  const { meta, body: rawBody } = parseFrontmatter(raw);
  const body = stripDiffMarkers(rawBody).trim();

  const assetsDir = join(lessonDir, "+assets");
  const starterFiles = await collectAssetFiles(join(assetsDir, "app-a"));
  const solutionFiles = await collectAssetFiles(join(assetsDir, "app-b"));

  // Reading-only when:
  //   - the section is non-runnable (SvelteKit), OR
  //   - there's no app-a starter (intro pages, "next steps", etc.), OR
  //   - app-b is missing or identical to app-a (welcome / next-steps
  //     pages ship a placeholder app-a so the live site has something
  //     to render in the iframe; without a real solution there's
  //     nothing to do).
  const hasSolution =
    solutionFiles.length > 0 &&
    !sameFileSet(starterFiles, solutionFiles);
  const hasExercise =
    runnable && starterFiles.length > 0 && hasSolution;

  const lesson = {
    id: lessonId(sectionSlug, chapterFolder, lessonFolder),
    kind: hasExercise ? "exercise" : "reading",
    title: meta.title || lessonFolder.replace(/^[0-9]+-/, "").replace(/-/g, " "),
    body,
  };

  if (hasExercise) {
    lesson.language = "svelte";
    if (starterFiles.length === 1) {
      lesson.starter = starterFiles[0].content;
    } else {
      lesson.files = starterFiles;
    }
    if (solutionFiles.length === 1) {
      lesson.solution = solutionFiles[0].content;
    } else if (solutionFiles.length > 1) {
      lesson.solutionFiles = solutionFiles;
    }
    // Tutorial pages don't ship automated tests — they're
    // exploratory exercises, not graded ones. Empty `tests` keeps
    // the runner in run-only mode (success = "ran cleanly").
    lesson.tests = "";
  } else {
    // Reading-only — for SvelteKit pages we still want to show the
    // example code so the learner has something to look at. Append
    // a "Reference code" section pulled from app-a (the unfilled
    // version is more illustrative than the solution for a reading
    // lesson).
    const sample = starterFiles.length > 0 ? starterFiles : solutionFiles;
    if (sample.length > 0) {
      const blocks = sample
        .map((f) => `\n\n### \`${f.name}\`\n\n\`\`\`${f.language}\n${f.content.trim()}\n\`\`\``)
        .join("");
      lesson.body = `${body}\n\n---\n\n## Reference code\n${blocks}`;
    }
  }

  return lesson;
}

async function buildChapter({
  sectionDir,
  sectionSlug,
  sectionLabel,
  chapterFolder,
  runnable,
}) {
  const chapterDir = join(sectionDir, chapterFolder);
  const entries = await readdir(chapterDir, { withFileTypes: true });
  const lessonFolders = entries
    .filter((e) => e.isDirectory() && /^[0-9]+-/.test(e.name))
    .map((e) => e.name)
    .sort();
  const lessons = [];
  for (const lf of lessonFolders) {
    const lesson = await buildLesson({
      sectionSlug,
      chapterFolder,
      lessonFolder: lf,
      lessonDir: join(chapterDir, lf),
      runnable,
    });
    if (lesson) lessons.push(lesson);
  }
  return {
    id: chapterId(sectionSlug, chapterFolder),
    title: chapterTitle(chapterFolder, sectionLabel),
    lessons,
  };
}

async function buildCourse(tutorialRoot) {
  const allChapters = [];
  for (const section of SECTIONS) {
    const sectionDir = join(tutorialRoot, section.folder);
    if (!existsSync(sectionDir)) {
      console.warn(`  skip ${section.folder} (not found)`);
      continue;
    }
    const entries = await readdir(sectionDir, { withFileTypes: true });
    const chapterFolders = entries
      .filter((e) => e.isDirectory() && /^[0-9]+-/.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const cf of chapterFolders) {
      allChapters.push(
        await buildChapter({
          sectionDir,
          sectionSlug: section.slug,
          sectionLabel: section.label,
          chapterFolder: cf,
          runnable: section.runnable,
        }),
      );
    }
  }
  return {
    id: COURSE.id,
    title: COURSE.title,
    description: COURSE.description,
    author: COURSE.author,
    language: COURSE.language,
    packType: "course",
    chapters: allChapters,
  };
}

async function main() {
  const root = process.argv[2];
  if (!root) {
    console.error(
      "usage: node scripts/ingest-svelte-tutorial.mjs <path/to/svelte.dev>\n\n" +
        "Hint: sparse-clone the upstream repo first:\n" +
        "  git clone --depth 1 --filter=blob:none --sparse \\\n" +
        "    https://github.com/sveltejs/svelte.dev /tmp/svelte.dev\n" +
        "  cd /tmp/svelte.dev && git sparse-checkout set apps/svelte.dev/content/tutorial",
    );
    process.exit(2);
  }
  const tutorialRoot = join(root, "apps/svelte.dev/content/tutorial");
  if (!existsSync(tutorialRoot)) {
    console.error(`tutorial dir not found: ${tutorialRoot}`);
    process.exit(2);
  }

  console.log(`=== ${COURSE.title} ===`);
  const course = await buildCourse(tutorialRoot);
  const lessonCount = course.chapters.reduce(
    (n, c) => n + c.lessons.length,
    0,
  );
  const exerciseCount = course.chapters.reduce(
    (n, c) => n + c.lessons.filter((l) => l.kind === "exercise").length,
    0,
  );
  const dst = join(APP_SUPPORT, COURSE.id);
  await mkdir(dst, { recursive: true });
  await writeFile(
    join(dst, "course.json"),
    JSON.stringify(course, null, 2) + "\n",
  );
  console.log(
    `  wrote ${dst}/course.json (${course.chapters.length} chapters, ${lessonCount} lessons, ${exerciseCount} runnable)`,
  );

  // Sweep stale per-section courses from previous runs of this
  // script (the v1 layout produced 4 separate course.jsons; v2
  // collapses them into one). Idempotent — first run with the new
  // layout finds them, subsequent runs find nothing.
  const stale = [
    "svelte-tutorial-advanced",
    "sveltekit-tutorial",
    "sveltekit-tutorial-advanced",
  ];
  for (const slug of stale) {
    const dir = join(APP_SUPPORT, slug);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
      console.log(`  cleaned legacy ${dir}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
