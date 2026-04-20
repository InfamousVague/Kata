import type { LanguageId } from "../data/types";
import { runJavaScript, runTypeScript } from "./javascript";
import type { RunResult } from "./types";

export type { RunResult, LogLine, TestResult } from "./types";
export { isPassing } from "./types";

/// Dispatch to the right in-browser runtime for a language.
/// `testCode` is optional; when provided, the runtime runs it against the
/// user's module.exports and reports per-test pass/fail results.
export async function runCode(
  language: LanguageId,
  code: string,
  testCode?: string,
): Promise<RunResult> {
  switch (language) {
    case "javascript":
      return runJavaScript(code, testCode);
    case "typescript":
      return runTypeScript(code, testCode);
    case "python":
    case "rust":
    case "swift":
      return {
        logs: [],
        error: `${language} runtime not implemented yet — coming in a later step`,
        durationMs: 0,
      };
  }
}
