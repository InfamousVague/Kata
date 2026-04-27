/// Helpers for the multi-file workbench. The component layer always deals
/// with `WorkbenchFile[]` — legacy single-file lessons get converted on the
/// fly so we don't have two render paths.

import type {
  ExerciseLesson,
  FileLanguage,
  LanguageId,
  MixedLesson,
  WorkbenchFile,
} from "../data/types";

/// Default filename + Monaco language for a given primary language. Only
/// used when a lesson has no explicit `files` array — this synthesizes a
/// sensible single-file starting point.
/// Partial on purpose — "web" and "threejs" are multi-file-only
/// meta-languages that never hit the single-file-starter synthesis
/// path. `deriveStarterFiles` calls this; if a lesson somehow gets
/// here with those languages, the caller's fallback kicks in.
const LANG_DEFAULTS: Partial<Record<LanguageId, { name: string; language: FileLanguage }>> = {
  javascript: { name: "user.js", language: "javascript" },
  typescript: { name: "user.ts", language: "typescript" },
  python: { name: "user.py", language: "python" },
  rust: { name: "user.rs", language: "rust" },
  swift: { name: "user.swift", language: "swift" },
  go: { name: "main.go", language: "go" },
  c: { name: "main.c", language: "c" },
  cpp: { name: "main.cpp", language: "cpp" },
  java: { name: "Main.java", language: "java" },
  kotlin: { name: "Main.kt", language: "kotlin" },
  csharp: { name: "Program.cs", language: "csharp" },
  assembly: { name: "main.s", language: "assembly" },
  // React Native single-file fallback. Conventionally named `App.js`
  // so JSX lessons that LLM-generated with only `starter` + `solution`
  // strings (not multi-file `files`) still open with a real filename.
  // Without this entry the derive* helpers fell through to the generic
  // `user.txt / plaintext` branch — the solution string DID populate
  // but Monaco highlighted it as plaintext, and the learner saw an
  // unfamiliar file tab. Now reveal-solution shows `App.js` with JS
  // highlighting (close enough to JSX at the workbench level).
  reactnative: { name: "App.js", language: "javascript" },
  // Bun runs JS/TS at the syntax level — single-file Bun lessons land
  // in `user.js` with JavaScript highlighting. Without this entry the
  // editor was falling through to plaintext (visible in screenshots
  // where Bun.password / Response / module.exports rendered as
  // unhighlighted text). The course uses CommonJS (`module.exports`)
  // for sandbox-test compatibility, so `.js` + `javascript` is the
  // honest mapping.
  bun: { name: "user.js", language: "javascript" },
  // Svelte 5 single-file fallback. The Svelte 5 course usually ships
  // multi-file `files` arrays; this is the safety net for any lesson
  // that only has `starter` + `solution` strings. Uses our hand-rolled
  // Monarch grammar registered in lib/monaco-svelte.ts.
  svelte: { name: "App.svelte", language: "svelte" },
  // SolidJS is JSX — Monaco's JS mode handles JSX syntax well enough
  // for highlighting purposes (no dedicated `solid` Monarch grammar).
  solid: { name: "App.jsx", language: "javascript" },
  // HTMX lessons are HTML with hx-* attributes — html mode highlights
  // them correctly.
  htmx: { name: "index.html", language: "html" },
  // Astro's frontmatter syntax (`---`) doesn't have a Monaco language;
  // html mode handles the bulk of Astro markup acceptably and beats
  // plaintext.
  astro: { name: "Page.astro", language: "html" },
  // Tauri lessons live in Rust (the #[tauri::command] surface), so
  // single-file fallbacks land in `lib.rs` with rust highlighting.
  tauri: { name: "lib.rs", language: "rust" },
  // Solidity. Solidity has a dedicated FileLanguage entry so Monaco
  // gets our hand-rolled Monarch grammar (registered in
  // lib/monaco-setup.ts). Default filename is `Contract.sol` —
  // matches the convention `solc` expects for a self-contained
  // contract source.
  solidity: { name: "Contract.sol", language: "solidity" },
};

/// Derive the editor's starting file set. When the lesson has explicit
/// `files`, we clone it. Otherwise we synthesize a one-file array from the
/// legacy `starter` field. Cloning matters because the editor mutates the
/// files array on every keystroke and we don't want to leak edits back onto
/// the loaded lesson (which can be revisited via Prev/Next).
export function deriveStarterFiles(lesson: ExerciseLesson | MixedLesson): WorkbenchFile[] {
  if (lesson.files && lesson.files.length > 0) {
    return lesson.files.map((f) => ({ ...f }));
  }
  // Fallback to a generic `user.txt` if the lesson's language isn't in
  // the default map (e.g. web / threejs — which shouldn't normally hit
  // this path but we degrade gracefully rather than crash).
  const def = LANG_DEFAULTS[lesson.language] ?? { name: "user.txt", language: "plaintext" as FileLanguage };
  return [
    {
      name: def.name,
      language: def.language,
      // Fallback to empty string so the editor mounts with a blank
      // buffer during the brief window between the fast summary load
      // (starter stripped server-side) and the background hydration
      // that swaps in the real body. Monaco treats undefined and ""
      // differently — "" renders a visible editor, undefined can
      // render a disposed/broken state.
      content: lesson.starter ?? "",
    },
  ];
}

/// Derive the reference solution as files, same shape the editor uses so
/// "reveal solution" can just swap the array wholesale.
export function deriveSolutionFiles(lesson: ExerciseLesson | MixedLesson): WorkbenchFile[] {
  if (lesson.solutionFiles && lesson.solutionFiles.length > 0) {
    return lesson.solutionFiles.map((f) => ({ ...f }));
  }
  // Fallback to a generic `user.txt` if the lesson's language isn't in
  // the default map (e.g. web / threejs — which shouldn't normally hit
  // this path but we degrade gracefully rather than crash).
  const def = LANG_DEFAULTS[lesson.language] ?? { name: "user.txt", language: "plaintext" as FileLanguage };
  return [
    {
      name: def.name,
      language: def.language,
      // Same "hydration in flight" guard as deriveStarterFiles — the
      // summary load strips `solution`, background `load_course` swaps
      // the real body in. Empty string until then.
      content: lesson.solution ?? "",
    },
  ];
}

/// Build the single source string passed to `runCode` from a set of files.
/// Only files matching the lesson's runnable language get concatenated; the
/// rest (e.g. CSS in a web-flavored JS lesson) are ignored by the runner but
/// still visible in the editor tabs.
///
/// Concatenation order is file-array order, which means authors can deliver
/// a reference module (say, a shared helper) as file[0] and the user's
/// primary scratchpad as file[1] — they stack top-down like `cat *.js`.
export function assembleRunnable(files: WorkbenchFile[], language: LanguageId): string {
  const runnable = files.filter((f) => f.language === language);
  if (runnable.length === 0) {
    // Nothing that matches the primary language — run an empty string. Tests
    // will surface this cleanly via "function is not defined" style errors.
    return "";
  }
  if (runnable.length === 1) return runnable[0].content;
  // Separate files with filename comments so runtime errors can hint at which
  // file the trace maps to. Works across every currently-supported runtime
  // because they all use `//` line comments.
  return runnable
    .map((f) => `// ---- ${f.name} ----\n${f.content}`)
    .join("\n\n");
}

/// Whether the given files array differs from the lesson's starter set —
/// used to enable/disable the Reset button so the learner can tell whether
/// they're in "pristine starter" state.
export function filesDifferFromStarter(
  current: WorkbenchFile[],
  starter: WorkbenchFile[],
): boolean {
  if (current.length !== starter.length) return true;
  for (let i = 0; i < current.length; i++) {
    if (current[i].name !== starter[i].name) return true;
    if (current[i].content !== starter[i].content) return true;
  }
  return false;
}
