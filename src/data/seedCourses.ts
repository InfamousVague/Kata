import type { Course } from "./types";

// Vite resolves these JSON imports at build time. Keep new seed courses as
// standalone files under `courses/` in the repo and re-export them here.
// This gives us one source of truth: the JSON files that the ingest CLI
// produces and that ship with the bundle.
import jsDefinitiveGuide from "../../courses/js-definitive-guide/course.json";

/// Courses the app falls back to when running outside Tauri (vite dev or
/// tests) and also the set seeded into app_data_dir on first launch so the
/// user has real content to click on.
export const seedCourses: Course[] = [
  // Inline JS First Steps (kept for quick smoke-tests of the runtime)
  {
    id: "js-first-steps",
    title: "JavaScript First Steps",
    author: "Kata Team",
    description: "A gentle intro to JavaScript. Variables, functions, a first runtime smoke test.",
    language: "javascript",
    chapters: [
      {
        id: "intro",
        title: "Introduction",
        lessons: [
          {
            id: "hello",
            kind: "reading",
            title: "What is JavaScript?",
            body: "# What is JavaScript?\n\nJavaScript is the language of the web. Every browser runs it, and these days Node runs it on servers too.\n\nThis course is a one-lesson smoke test to confirm the runtime works. The real content lives in **JavaScript: The Definitive Guide** below.\n\n```javascript\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\nconsole.log(greet('world'));\n```",
          },
          {
            id: "first-exercise",
            kind: "exercise",
            title: "Your first function",
            language: "javascript",
            body: "# Your first function\n\nImplement `add` so that `add(2, 3)` returns `5`.",
            starter: "function add(a, b) {\n  // your code here\n}\n\nconsole.log('add(2, 3) =', add(2, 3));\n\nmodule.exports = { add };\n",
            solution: "function add(a, b) {\n  return a + b;\n}\n\nconsole.log('add(2, 3) =', add(2, 3));\n\nmodule.exports = { add };\n",
            tests: "const { add } = require('./user');\n\ntest('adds two positive numbers', () => {\n  expect(add(2, 3)).toBe(5);\n});\n\ntest('adds with a negative', () => {\n  expect(add(-1, 10)).toBe(9);\n});\n\ntest('returns a number, not a string', () => {\n  expect(typeof add(1, 2)).toBe('number');\n});\n",
          },
        ],
      },
    ],
  },

  // The big one: hand-crafted Codecademy-style course derived from Flanagan.
  jsDefinitiveGuide as unknown as Course,
];
